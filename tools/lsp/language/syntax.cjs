'use strict';

// Offsets and columns use JavaScript's UTF-16 units, as required by LSP's default encoding.
const keywords = ['namespace', 'from', 'import', 'entity', 'inherits', 'extend', 'decodes',
  'id', 'attr', 'snapshot', 'scd', 'config', 'static', 'final', 'self', 'value', 'type', 'as'];
const annotations = ['title', 'description', 'temporal', 'dimension', 'overload', 'override'];
const values = ['bool', 'string', 'integer', 'float', 'decimal', 'date', 'datetime', 'snowflake_id'];
const generics = ['collection', 'values', 'mapping', 'code', 'type', 'attrs', 'alias', 'exact'];
const entities = [];
const structures = [];
const constants = ['NOT_DEFINED', 'true', 'false'];

function position(text, offset) {
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1).length };
}
function range(text, start, end) { return { start: position(text, start), end: position(text, end) }; }
function stringValue(text) { return text.slice(1, -1).replace(/\\(['\\])/g, '$1'); }

function parse(text, uri = '') {
  const doc = { text, uri, namespace: '', imports: [], declarations: [], tokens: [], comments: [], blocks: [], pieces: [], errors: [] };
  const delimiters = [...text.matchAll(/^[ \t]*---[ \t]*(?=\r?$)/gm)];
  if (delimiters.length % 2) {
    const start = delimiters.at(-1).index;
    doc.errors.push({ range: range(text, start, start + 3), severity: 1, message: 'unclosed Markdown block', source: 'yambl' });
    return doc;
  }
  let masked = text;
  for (let i = 0; i < delimiters.length; i += 2) {
    const start = delimiters[i].index, end = delimiters[i + 1].index + delimiters[i + 1][0].length;
    doc.blocks.push({ start, end, text: text.slice(start, end).replace(/\r\n/g, '\n') });
    masked = masked.slice(0, start) + masked.slice(start, end).replace(/[^\r\n]/g, ' ') + masked.slice(end);
  }
  let offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const pattern = /\s+|#[^\r\n]*|'(?:[^'\\\r\n]|\\[^\r\n])*'|[A-Za-z_][A-Za-z_0-9]*|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|::|[{}\[\]()<>,:.=@-]/y;
  while (offset < text.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(masked);
    if (!match) {
      doc.errors.push({ range: range(text, offset, offset + 1), severity: 1, message: 'invalid YAMBL syntax', source: 'yambl' });
      return doc;
    }
    const value = match[0];
    const token = { value, start: offset, end: pattern.lastIndex, range: range(text, offset, pattern.lastIndex) };
    offset = token.end;
    if (value.startsWith('#')) doc.comments.push(token);
    else if (!/^\s/.test(value)) doc.tokens.push(token);
  }
  const eof = { value: '', start: text.length, end: text.length, range: range(text, text.length, text.length) };
  let index = 0;
  const peek = () => doc.tokens[index] || eof;
  const is = value => peek().value === value;
  const fail = () => { throw peek(); };
  const take = value => { if (value !== undefined && !is(value)) fail(); return doc.tokens[index++] || fail(); };
  const name = () => /^[A-Za-z_][A-Za-z_0-9]*$/.test(peek().value) ? take() : fail();
  const literal = () => /^(?:'|-?\d)/.test(peek().value) ? take() : fail();
  const qualified = () => { let value = name().value; while (is('.')) { take(); value += '.' + name().value; } return value; };
  const piece = (start, indent) => doc.pieces.push({ tokens: doc.tokens.slice(start, index), indent });
  function type() {
    const token = /^(?:'|-?\d)/.test(peek().value) ? take() : name();
    const node = { token, name: token.value.startsWith("'") ? stringValue(token.value) : token.value, args: null, params: null, accesses: [] };
    if (token.value.startsWith("'")) node.quoted = true;
    if (/^-?\d/.test(token.value) || ['true', 'false'].includes(token.value)) node.literal = true;
    if (is('<')) {
      take(); node.args = [];
      do {
        if (node.args.length) take(',');
        node.args.push(type());
      } while (is(','));
      take('>');
    } else if (is('[')) {
      take(); node.params = [];
      do {
        if (node.params.length) take(',');
        let key = null;
        if (/^[A-Za-z_]/.test(peek().value)) { key = name().value; take(':'); }
        const value = literal();
        if (!value.value.startsWith("'") && !/^-?\d+$/.test(value.value)) throw value;
        node.params.push({ key, value });
      } while (is(','));
      take(']');
    }
    while (is('.') || is('::')) { const operator = take(); node.accesses.push({ operator, token: name() }); }
    if (is('as')) { take(); node.binding = name(); }
    return node;
  }
  function annotation(indent) {
    const start = index;
    const token = take('@'); const kind = name();
    if (!annotations.includes(kind.value)) throw kind;
    if (['overload', 'override'].includes(kind.value)) { piece(start, indent); return { token, markerToken: kind, name: kind.value, dimensions: [] }; }
    take('(');
    const node = { token, name: kind.value, dimensions: [] };
    if (['title', 'description'].includes(kind.value)) {
      if (!peek().value.startsWith("'")) fail();
      node.value = take();
    } else {
      do {
        if (node.dimensions.length) take(',');
        const dimension = name(); take(':');
        node.dimensions.push({ token: dimension, type: type() });
      } while (is(','));
    }
    take(')'); piece(start, indent); return node;
  }
  try {
    if (is('namespace')) {
      const start = index; take(); doc.namespace = qualified(); piece(start, 0);
    }
    while (is('from')) {
      const start = index; const token = take(); const namespace = qualified(); take('import');
      doc.imports.push({ token, namespace, name: name() }); piece(start, 0);
    }
    while (peek() !== eof) {
      const metadata = [];
      while (is('@')) {
        const item = annotation(0);
        if (!item.value) throw item.token;
        metadata.push(item);
      }
      if (is('type')) {
        if (metadata.length) fail();
        const start = index, token = take(), aliasName = name(), parameters = [];
        if (is('<')) {
          take();
          do {
            if (parameters.length) take(',');
            const parameter = name(); take(':'); parameters.push({ token: parameter, type: type() });
          } while (is(','));
          take('>');
        }
        take('='); const body = type();
        doc.declarations.push({ kind: 'type_alias', token, name: aliasName, parameters, type: body, metadata, fields: [], entries: [], doc, end: doc.tokens[index - 1].end });
        piece(start, 0); continue;
      }
      const start = index; const final = is('final') ? take() : null; const token = take();
      if (final && token.value !== 'entity') throw token;
      if (!['entity', 'extend', 'decodes', 'value'].includes(token.value) || (token.value === 'extend' && metadata.length)) throw token;
      const declaration = { kind: token.value, token: final || token, final: Boolean(final), name: name(), metadata, fields: [], entries: [], doc };
      if (declaration.kind === 'entity' && is('inherits')) { take(); declaration.parent = name(); }
      declaration.bodyStart = take('{').end; piece(start, 0);
      while (!is('}')) {
        if (declaration.kind === 'decodes') {
          const start = index; const token = take('-'); const order = take();
          if (!/^-?\d+$/.test(order.value)) throw order;
          const code = name(); take(':');
          if (!peek().value.startsWith("'")) fail();
          declaration.entries.push({ token, code, value: take() }); piece(start, 1);
        } else {
          const metadata = [];
          while (is('@')) metadata.push(annotation(1));
          const start = index; const token = take(); const mode = token.value;
          if (!['id', 'attr', 'snapshot', 'scd', 'config', 'static'].includes(mode)) throw token;
          if (['snapshot', 'scd', 'config', 'static'].includes(mode)) take('attr');
          const field = { token, mode, name: name(), metadata, doc }; take(':'); field.type = type();
          if (is('=')) {
            field.defaultToken = take();
            field.default = ['true', 'false'].includes(peek().value) ? take() : literal();
          }
          field.end = peek().start;
          declaration.fields.push(field); piece(start, 1);
        }
      }
      const close = index; declaration.end = take('}').end; piece(close, 0);
      doc.declarations.push(declaration);
    }
  } catch (token) {
    if (!token.range) throw token;
    doc.errors.push({ range: token.range, severity: 1, message: 'invalid YAMBL syntax', source: 'yambl' });
  }
  return doc;
}

function format(doc) {
  if (doc.errors.length) return null;
  const pieces = doc.pieces.map(piece => {
    let text = '', previous = '';
    for (const token of piece.tokens) {
      const value = token.value;
      const space = text && !['.', '::', ':', ',', ')', '>', ']', '(', '[', '<'].includes(value) && !['.', '::', '@', '(', '<', '['].includes(previous);
      text += (space ? ' ' : '') + value; previous = value;
    }
    return { start: piece.tokens[0].start, end: piece.tokens.at(-1).end, text, indent: piece.indent };
  });
  for (const token of doc.comments) {
    const indent = Number(doc.declarations.some(d => token.start >= d.bodyStart && token.end < d.end));
    pieces.push({ ...token, text: '# ' + token.value.slice(1).trim(), indent, comment: true });
  }
  pieces.push(...doc.blocks.map(block => ({ ...block, indent: 0 })));
  pieces.sort((a, b) => a.start - b.start);
  const lines = []; let end = 0;
  for (const piece of pieces) {
    const gap = doc.text.slice(end, piece.start).replace(/\r\n?/g, '\n');
    if (piece.comment && lines.length && !gap.includes('\n')) lines[lines.length - 1] += '  ' + piece.text;
    else {
      if (lines.length && (gap.match(/\n/g) || []).length > 1) lines.push('');
      lines.push('    '.repeat(piece.indent) + piece.text);
    }
    end = piece.end;
  }
  return lines.join('\n').trimEnd() + '\n';
}

module.exports = { parse, format, position, range, stringValue, keywords, annotations, values, generics, entities, structures, constants };
