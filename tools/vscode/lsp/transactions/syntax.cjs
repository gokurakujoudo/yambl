'use strict';

const { range } = require('../language/syntax.cjs');
const { semanticDigest } = require('./writing.cjs');
const keywords = ['plan', 'transaction', 'version', 'model', 'group', 'insert', 'update', 'delete', 'replace', 'expect', 'one', 'any', 'scope', 'columns', 'owned_data', 'delete_all', 'in', 'time', 'source', 'digest', 'change', 'before', 'after', 'warning', 'true', 'false', 'NO_ENTRY', 'EMPTY', 'NOT_APPLICABLE'];
const pattern = /(?<space>[ \t]+)|(?<newline>\n)|(?<comment>#[^\n]*)|(?<string>'(?:[^'\\\n]|\\[^\n])*')|(?<number>-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|(?<name>[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*)|(?<punct>[{}\[\](),:=])/y;

class DocumentError extends Error {
  constructor(message, token) { super(message); this.token = token; }
}

function tokenize(text) {
  const tokens = []; let offset = 0, line = 1;
  while (offset < text.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match) throw new DocumentError('invalid token or unterminated string', { start: offset, end: offset + 1 });
    const kind = Object.keys(match.groups).find(k => match.groups[k] !== undefined);
    if (kind === 'newline') line++;
    else if (kind !== 'space') tokens.push({ kind, text: match[0], value: match[0], start: offset, end: pattern.lastIndex, line, range: range(text, offset, pattern.lastIndex) });
    offset = pattern.lastIndex;
  }
  tokens.push({ kind: 'eof', text: '', value: '', start: offset, end: offset, line, range: range(text, offset, offset) });
  return tokens;
}

class Parser {
  constructor(text) {
    this.all = tokenize(text); this.tokens = this.all.filter(t => t.kind !== 'comment');
    this.index = 0; this.depth = 0; this.layout = new Map();
  }
  get current() { return this.tokens[this.index]; }
  fail(message) { throw new DocumentError(message, this.current); }
  take(text) {
    const token = this.current;
    if (token.kind === 'eof' || (text && token.text !== text)) this.fail(`expected ${text || 'token'}`);
    this.index++; return token;
  }
  line() { this.layout.set(this.current, this.depth); }
  open() { const token = this.take('{'); this.depth++; this.line(); return token; }
  close() { this.depth--; this.line(); this.take('}'); this.line(); }
  name(qualified = false) {
    if (this.current.kind !== 'name' || (!qualified && this.current.text.includes('.'))) this.fail('expected identifier');
    return this.take();
  }
  string() {
    if (this.current.kind !== 'string') this.fail('expected single-quoted string');
    return this.take().text.slice(1, -1).replace(/\\(['\\])/g, '$1');
  }
  literal(depth = 0) {
    if (depth > 64) this.fail('literal nesting exceeds 64');
    const token = this.current;
    if (token.kind === 'string') return { kind: 'string', value: this.string(), token };
    if (['number', 'name'].includes(token.kind)) {
      this.take();
      if (token.kind === 'number' && /^-?\d+$/.test(token.text) && token.text.replace('-', '').length > 4300) this.fail('invalid numeric literal');
      if (token.kind === 'number' && /[.eE]/.test(token.text)) {
        const [, whole, fraction = '', power = '0'] = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token.text);
        const exponent = BigInt(power) - BigInt(fraction.length);
        const digits = (whole + fraction).replace(/^0+/, '') || '0';
        if (exponent < -1999999999999999997n || exponent + BigInt(digits.length - 1) > 999999999999999999n) this.fail('invalid numeric literal');
      }
      return { kind: token.kind, value: token.text, token };
    }
    if (['[', '{'].includes(token.text)) {
      this.take(); const items = [], object = token.text === '{', end = object ? '}' : ']';
      while (this.current.text !== end) {
        if (items.length) this.take(',');
        const value = this.literal(depth + 1);
        if (object) { this.take(':'); items.push([value, this.literal(depth + 1)]); }
        else items.push(value);
      }
      this.take(end); return { kind: object ? 'object' : 'collection', items, token };
    }
    this.fail('expected literal or model name');
  }
  columns() {
    this.take('('); const columns = [this.name()];
    while (this.current.text === ',') { this.take(','); columns.push(this.name()); }
    this.take(')');
    if (new Set(columns.map(t => t.text)).size !== columns.length) this.fail('duplicate column');
    return columns;
  }
  rows(width) {
    let previous = this.open().line; const rows = [];
    while (this.current.text !== '}') {
      this.line(); const line = this.current.line;
      if (line <= previous) this.fail('each data record must occupy its own line');
      const values = [this.literal()];
      while (this.current.text === ',' && this.current.line === line) { this.take(','); values.push(this.literal()); }
      if (this.tokens[this.index - 1].line !== line) this.fail('a data record cannot span multiple lines');
      if (values.length !== width) this.fail(`expected ${width} values, received ${values.length}`);
      if (this.current.line === line) this.fail('unexpected token after data record');
      rows.push(values); previous = line;
    }
    this.close(); return rows;
  }
  scope() {
    this.take('scope'); this.take('('); const conditions = [];
    while (this.current.text !== ')') {
      if (conditions.length) this.take(',');
      const name = this.name(); let value, end;
      if (conditions.some(c => c.name.text === name.text)) this.fail(`duplicate scope coordinate: ${name.text}`);
      if (this.current.text === 'in') {
        this.take('in'); this.take('['); value = this.literal(); this.take(','); end = this.literal(); this.take(')');
      } else { this.take('='); value = this.literal(); }
      conditions.push({ name, value, end });
    }
    this.take(')'); if (!conditions.length) this.fail('scope must contain an owner coordinate');
    return conditions;
  }
  operation() {
    this.line(); const token = this.take(), kind = token.text;
    if (!['insert', 'update', 'delete', 'replace'].includes(kind)) this.fail('expected insert, update, delete or replace');
    const target = this.name(true); let owned = false, scope = [], expect = null;
    if (this.current.text === 'expect') {
      if (!['replace', 'delete'].includes(kind)) this.fail('expect is only valid for replace or delete');
      this.take(); expect = this.take().text;
      if (!['one', 'any'].includes(expect)) this.fail('expected one or any');
    }
    if (this.current.text === 'owned_data') {
      if (kind !== 'delete') this.fail('owned_data is only valid for entity deletion');
      this.take(); this.take('delete_all'); owned = true;
    }
    if (this.current.text === 'scope') {
      if (!['replace', 'delete'].includes(kind) || owned) this.fail('scope requires replace or field delete');
      scope = this.scope();
      if (kind === 'delete') return { kind, target, scope, expect, columns: [], rows: [], token };
      this.take('columns');
    } else if (kind === 'replace') this.fail('replace requires scope');
    const columns = this.columns(), rows = this.rows(columns.length);
    return { kind, target, scope, expect, owned, columns, rows, token };
  }
  revision() { this.line(); this.take('version'); if (this.current.text !== '1') this.fail('unsupported document version; expected 1'); this.take(); this.line(); }
  digest() { const value = this.string(); if (!/^[0-9a-f]{64}$/.test(value)) this.fail('expected lowercase SHA-256 digest'); this.line(); return value; }
  plan() {
    this.line(); this.take('plan'); const name = this.name(); this.open(); this.revision(); this.take('model');
    const model = this.digest(), groups = [];
    while (this.current.text !== '}') {
      this.take('group'); const name = this.name();
      if (groups.some(g => g.name.text === name.text)) this.fail(`duplicate group: ${name.text}`);
      this.open(); const operations = [];
      while (this.current.text !== '}') operations.push(this.operation());
      this.close(); groups.push({ name, operations });
    }
    this.close(); return { kind: 'plan', name, model, groups };
  }
  image() { const target = this.name(true), columns = this.columns(); return { target, columns, rows: this.rows(columns.length) }; }
  transaction() {
    this.line(); this.take('transaction'); const id = this.string(); this.open(); this.revision();
    this.take('time'); const time = this.string(); this.line(); let source = '';
    if (this.current.text === 'source') { this.take(); source = this.string(); this.line(); }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const parts = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?Z$/.exec(time);
    const [year, month, day, hour, minute, second] = parts ? parts.slice(1).map(Number) : [];
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!uuid.test(id) || (source && !uuid.test(source)) || !parts || year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) this.fail('invalid transaction metadata');
    this.take('digest'); const digest = this.digest(), plan = this.plan(), groups = [];
    while (this.current.text !== '}') {
      this.take('group'); const name = this.name();
      if (!plan.groups.some(g => g.name.text === name.text) || groups.some(g => g.name.text === name.text)) this.fail('unknown or duplicate transaction group');
      this.open(); const changes = [], warnings = [];
      while (this.current.text !== '}') {
        this.line();
        if (this.current.text === 'warning') { this.take(); warnings.push(this.string()); this.line(); continue; }
        this.take('change'); const target = this.name(true), scope = this.scope(); this.open();
        const before = [], after = [];
        while (this.current.text === 'before') { this.take(); before.push(this.image()); }
        while (this.current.text === 'after') { this.take(); after.push(this.image()); }
        if (!before.length && !after.length) this.fail('change requires before or after data');
        this.close(); changes.push({ target, scope, before, after });
      }
      this.close(); groups.push({ name, changes, warnings });
    }
    this.close(); return { kind: 'transaction', id, time, source, digest, plan, groups };
  }
  document() {
    const result = this.current.text === 'plan' ? this.plan() : this.transaction();
    if (this.current.kind !== 'eof') this.fail('unexpected token after document');
    return result;
  }
}

function parse(text, uri = '') {
  text = text.replace(/\r\n?/g, '\n');
  const doc = { text, uri, transactionLanguage: true, diagnostics: [], tokens: [], bindings: new Map(), scope: new Map(), declarations: [] };
  try {
    doc.parser = new Parser(text); doc.tokens = doc.parser.tokens; doc.ast = doc.parser.document();
    if (doc.ast.kind === 'transaction' && semanticDigest(doc.ast) !== doc.ast.digest) throw new DocumentError('transaction integrity digest does not match', doc.tokens[0]);
  } catch (error) {
    if (error instanceof RangeError) error = new DocumentError('numeric representation exceeds runtime limits', doc.tokens[0]);
    if (!(error instanceof DocumentError)) throw error;
    doc.diagnostics.push({ range: range(text, error.token.start, error.token.end), severity: 1, source: 'yambl', message: error.message });
  }
  doc.syntaxErrors = doc.diagnostics.length;
  return doc;
}

function join(tokens) {
  let text = '', previous = '';
  for (const token of tokens) {
    const spelling = token.text;
    const space = text && ![',', ':', ')', ']', '='].includes(spelling) && !['(', '[', '='].includes(previous) && !(spelling === '}' && previous === '{');
    text += (space ? ' ' : '') + spelling; previous = spelling;
  }
  return text;
}

function format(doc) {
  if (doc.syntaxErrors || !doc.ast) return null;
  const parser = doc.parser, output = []; let pending = [], depth = 0, base = 0, previousLine = 0;
  function flush(comment) {
    if (pending.length || comment !== undefined) {
      let body = join(pending);
      if (comment !== undefined) body += (body ? '  ' : '') + '#' + (comment ? ' ' + comment : '');
      output.push('    '.repeat(depth) + body); pending = [];
    }
  }
  for (const token of parser.all.slice(0, -1)) {
    if (token.kind === 'comment') {
      if (pending.length && token.line !== pending.at(-1).line) flush();
      if (!pending.length) {
        const next = parser.tokens.find(t => t.line > token.line) || parser.tokens.at(-1);
        depth = parser.layout.get(next) ?? base; if (next.text === '}') depth++;
      }
      if (previousLine && token.line > previousLine + 1 && output.at(-1)) output.push('');
      flush(token.text.slice(1).replace(/^ +/, '')); previousLine = token.line; continue;
    }
    const boundary = parser.layout.has(token), newline = pending.length && token.line !== pending.at(-1).line;
    if (boundary || newline) {
      flush(); if (previousLine && token.line > previousLine + 1 && output.at(-1)) output.push('');
      if (boundary) { base = parser.layout.get(token); depth = base; } else depth = base + 1;
    }
    pending.push(token); previousLine = token.line;
  }
  flush();
  const result = output.join('\n').replace(/\n*$/, '') + '\n', checked = parse(result);
  if (checked.diagnostics.length || JSON.stringify(checked.tokens.map(t => t.text)) !== JSON.stringify(doc.tokens.map(t => t.text))) throw new Error('formatting changed document tokens');
  return result;
}

module.exports = { parse, format, keywords, Parser };
