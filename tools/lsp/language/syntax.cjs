'use strict';

const fs = require('node:fs');
const path = require('node:path');
const packagedRoot = path.join(__dirname, '../lang');
const modelRoot = fs.existsSync(packagedRoot) ? packagedRoot : path.join(__dirname, '../../../lang');
const resultConstants = JSON.parse(fs.readFileSync(path.join(modelRoot, 'builtins/result-constants.json'), 'utf8'));

// Offsets and columns use JavaScript's UTF-16 units, as required by LSP's default encoding.
const keywords = ['namespace', 'from', 'import', 'entity', 'inherits', 'extend', 'decodes',
  'id', 'attr', 'snapshot', 'scd', 'config', 'static', 'final', 'self', 'value', 'type', 'as', 'decorator'];
const annotations = ['title', 'description', 'temporal', 'dimension', 'overload', 'override', 'flags', 'allow_multiple', 'targets'];
const values = ['bool', 'string', 'integer', 'float', 'decimal', 'date', 'datetime', 'snowflake_id'];
const generics = ['collection', 'values', 'mapping', 'code', 'type', 'attrs', 'alias', 'exact'];
const entities = [];
const structures = [];
const constants = [...Object.keys(resultConstants), 'true', 'false'];

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
  const pattern = /\s+|#[^\r\n]*|'(?:[^'\\\r\n]|\\[^\r\n])*'|[A-Za-z_][A-Za-z_0-9]*|-?0b[01]+|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|::|[{}\[\]()<>,:.=@+*?-]/y;
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
  function type(operand = false) {
    const token = /^(?:'|-?\d)/.test(peek().value) ? take() : name();
    if (/^-?0b/.test(token.value)) throw token;
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
    if (!operand) {
      node.operations = [];
      while (is('+') || is('-') || /^-\d/.test(peek().value)) {
        // In A-1 the lexer keeps -1 intact; here it follows a complete operand.
        if (/^-\d/.test(peek().value)) {
          const signed = peek();
          doc.tokens.splice(index, 1,
            { ...signed, value: '-', end: signed.start + 1, range: range(text, signed.start, signed.start + 1) },
            { ...signed, value: signed.value.slice(1), start: signed.start + 1, range: range(text, signed.start + 1, signed.end) });
        }
        const operator = take(); node.operations.push({ operator, term: type(true) });
      }
      if (is('as')) { take(); node.binding = name(); }
    }
    return node;
  }
  function annotation(indent) {
    const start = index;
    const token = take('@'); const kind = name();
    const node = { token, markerToken: kind, name: kind.value, arguments: [], dimensions: [] };
    if (is('(')) {
      take();
      while (!is(')')) {
        if (node.arguments.length) take(',');
        const first = peek();
        let mode = 'positional', key = null;
        if (['=', ':'].includes(doc.tokens[index + 1]?.value)) {
          key = name(); mode = take().value === '=' ? 'keyword' : 'pair';
        }
        const expression = type();
        const argument = { token: first, mode, key, type: expression };
        node.arguments.push(argument);
        if (mode === 'pair') node.dimensions.push({ token: key, type: expression });
        if (!is(',')) break;
      }
      take(')');
    }
    node.end = doc.tokens[index - 1].end;
    piece(start, indent); return node;
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
        metadata.push(item);
      }
      if (is('decorator')) {
        const start = index, token = take(); take('@'); const decoratorName = name(), parameters = [];
        take('(');
        while (!is(')')) {
          if (parameters.length) take(',');
          const parameterToken = peek(), pair = is('*'); if (pair) take();
          const parameterName = name(), optional = is('?'); if (optional) take();
          take(':'); const constraint = type();
          let defaultValue = null; if (is('=')) { take(); defaultValue = type(); }
          parameters.push({ token: parameterToken, name: parameterName, type: constraint, pair, optional, default: defaultValue });
          if (!is(',')) break;
        }
        take(')');
        const declaration = { kind: 'decorator', token, name: decoratorName, parameters, metadata, fields: [], entries: [], doc, end: doc.tokens[index - 1].end };
        for (const parameter of parameters) { parameter.kind = 'decorator_parameter'; parameter.doc = doc; parameter.owner = declaration; }
        doc.declarations.push(declaration); piece(start, 0); continue;
      }
      if (is('type')) {
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
          if (!/^-?(?:0b[01]+|\d+)$/.test(order.value)) throw order;
          const code = name(); take(':');
          if (!peek().value.startsWith("'")) fail();
          declaration.entries.push({ token, order, code, value: take() }); piece(start, 1);
        } else {
          const metadata = [];
          while (is('@')) metadata.push(annotation(1));
          const start = index; const token = take(); const mode = token.value;
          if (!['id', 'attr', 'snapshot', 'scd', 'config', 'static'].includes(mode)) throw token;
          if (['snapshot', 'scd', 'config', 'static'].includes(mode)) take('attr');
          const field = { token, mode: mode === 'attr' ? 'static' : mode, name: name(), metadata, doc }; take(':'); field.type = type();
          if (is('=')) {
            field.defaultToken = take();
            field.default = ['true', 'false'].includes(peek().value) ? take() : literal();
            if (/^-?0b/.test(field.default.value)) throw field.default;
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
    let text = '', previous = '', priorEquals = false;
    const keywordEquals = new Set(piece.tokens.filter((t, i) => t.value === '=' && piece.tokens[0].value === '@' && /^[A-Za-z_]/.test(piece.tokens[i - 1]?.value)).map(t => t.start));
    for (const token of piece.tokens) {
      const value = token.value;
      const space = !keywordEquals.has(token.start) && !priorEquals && text && !['?', '.', '::', ':', ',', ')', '>', ']', '(', '[', '<'].includes(value) && !['*', '.', '::', '@', '(', '<', '['].includes(previous);
      text += (space ? ' ' : '') + value; previous = value; priorEquals = keywordEquals.has(token.start);
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

module.exports = { parse, format, position, range, stringValue, keywords, annotations, values, generics, entities, structures, constants, resultConstants, modelRoot };
