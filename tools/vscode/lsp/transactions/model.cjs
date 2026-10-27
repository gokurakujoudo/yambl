'use strict';

const { range } = require('../language/syntax.cjs');
const { Resolver } = require('../language/expressions.cjs');
const qualified = declaration => [declaration.doc.prefix, declaration.doc.namespace, declaration.name.value].filter(Boolean).join('.');

function bind(doc, symbols) {
  const entities = new Map([...symbols.values()].filter(d => d.kind === 'entity').map(d => [qualified(d), d]));
  doc.modelSymbols = symbols; doc.entities = entities; doc.definitionSites = [];
  const site = (token, target, start = token.start, end = token.end) => {
    if (target) doc.definitionSites.push({ start, end, range: range(doc.text, start, end), target });
  };
  function target(token) {
    const entity = entities.get(token.text);
    if (entity) { site(token, entity); return { entity }; }
    const split = token.text.lastIndexOf('.'), owner = entities.get(token.text.slice(0, split));
    if (!owner) return {};
    const field = owner.effective.get(token.text.slice(split + 1));
    site(token, owner, token.start, token.start + split);
    site(token, field, token.start + split + 1);
    return { entity: owner, field };
  }
  function literal(value, key = false) {
    if (value.kind === 'name' || (key && value.kind === 'string')) {
      const quoted = value.kind === 'string';
      target({ ...value.token, text: value.value, start: value.token.start + Number(quoted), end: value.token.end - Number(quoted) });
    }
    if (value.kind === 'collection') for (const item of value.items) literal(item);
    if (value.kind === 'object') for (const [name, item] of value.items) { literal(name, true); literal(item); }
  }
  const plan = doc.ast?.kind === 'transaction' ? doc.ast.plan : doc.ast;
  for (const group of plan?.groups || []) for (const op of group.operations) {
    const { entity, field } = target(op.target);
    if (!entity) continue;
    const rowCoordinates = field && coordinates(entity, field, true);
    for (const column of op.columns) site(column, field ? (column.text === 'value' ? field : rowCoordinates.get(column.text)) : entity.effective.get(column.text));
    const scopeCoordinates = field ? coordinates(entity, field) : entity.effective;
    for (const condition of op.scope) site(condition.name, scopeCoordinates.get(condition.name.text));
    for (const row of op.rows) for (const value of row) literal(value);
  }
  if (doc.ast?.kind === 'transaction') for (const group of doc.ast.groups) for (const change of group.changes) {
    const { entity, field } = target(change.target);
    const scopeCoordinates = field ? coordinates(entity, field) : entity?.effective;
    for (const condition of change.scope) site(condition.name, scopeCoordinates?.get(condition.name.text));
    for (const image of [...change.before, ...change.after]) {
      const { entity: owner, field } = target(image.target);
      const rowCoordinates = field ? coordinates(owner, field, true) : owner?.effective;
      for (const column of image.columns) site(column, column.text === 'value' && field ? field : rowCoordinates?.get(column.text));
      for (const row of image.rows) for (const value of row) literal(value);
    }
  }
}

function definition(doc, position) {
  const found = doc.definitionSites?.find(site => site.range.start.line === position.line && site.range.start.character <= position.character && position.character < site.range.end.character);
  return found ? { uri: found.target.doc.uri, range: found.target.name.range } : null;
}

function coordinates(entity, field, row = false) {
  const result = new Map([...entity.effective].filter(([, f]) => f.mode === 'id'));
  for (const call of field.metadata) {
    if (call.name === 'dimension' && call.dimension) result.set(call.dimension.value.value, { doc: call.dimension.doc, name: call.dimension.value });
    if (call.name === 'temporal') {
      if (row && field.mode === 'scd') { result.set('valid_from', field); result.set('valid_to', field); }
      else for (const pair of call.dimensions) result.set(pair.token.value, { doc: field.doc, name: pair.token });
    }
  }
  return result;
}

function completion(doc, position) {
  if (!doc.entities) return null;
  const lines = doc.text.split('\n');
  const offset = lines.slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character;
  const before = doc.text.slice(0, offset);
  let inLiteral = false;
  const masked = before.replace(/'(?:\\[^\n]|[^'\\\n])*'?|#[^\n]*/g, (text, start) => {
    if (start + text.length === offset && (text[0] === '#' || !text.endsWith("'") || text.length === 1)) inLiteral = true;
    return text.replace(/[^\n]/g, ' ');
  });
  if (inLiteral) return [];
  const header = /\b(insert|update|delete|replace)\s+([A-Za-z_][A-Za-z_0-9.]*)?([^{}]*)$/.exec(masked);
  if (!header) return null;
  const [, kind, target = '', tail] = header;
  if (!tail) {
    const names = [];
    for (const [name, entity] of doc.entities) {
      if (![...entity.effective.values()].some(f => f.mode === 'id')) continue;
      if (kind !== 'replace') names.push(name);
      if (['replace', 'delete'].includes(kind)) for (const [fieldName, field] of entity.effective) if (!['id', 'computed'].includes(field.mode)) names.push(name + '.' + fieldName);
    }
    return names.filter(name => name.startsWith(target)).map(label => ({ label, kind: 7, insertText: label.slice(target.lastIndexOf('.') + 1) }));
  }
  const split = target.lastIndexOf('.'), entity = doc.entities.get(target) || doc.entities.get(target.slice(0, split));
  if (!entity) return [];
  const field = doc.entities.has(target) ? null : entity.effective.get(target.slice(split + 1));
  const columnList = /(?:^\s*(?:expect\s+(?:one|any)\s*)?(?:owned_data\s+delete_all\s*)?|\bcolumns\s*)\(([^()]*)$/.exec(tail);
  const scopeList = /\bscope\s*\((.*)$/s.exec(tail);
  let choices, used;
  if (columnList) {
    used = new Set(columnList[1].split(',').slice(0, -1).map(s => s.trim()));
    if (field) {
      choices = coordinates(entity, field, true); choices.set('value', field);
      const scope = tail.slice(0, tail.indexOf('columns'));
      for (const match of scope.matchAll(/\b([a-z_][a-z_0-9]*)\s*=/g)) used.add(match[1]);
    } else choices = new Map([...entity.effective].filter(([, candidate]) => {
      if (candidate.mode === 'id') return true;
      if (kind === 'delete' || !['static', 'config'].includes(candidate.mode) || candidate.metadata.some(m => m.name === 'dimension')) return false;
      const resolved = new Resolver(candidate.doc, () => {}, doc.modelSymbols, candidate.owner, true).resolve(candidate.type);
      return kind === 'insert' || !['collection', 'values', 'mapping'].includes(resolved.name);
    }));
  } else if (scopeList && /(?:^|,)\s*[a-z_0-9]*$/i.test(scopeList[1]) && field) {
    choices = coordinates(entity, field);
    used = new Set([...scopeList[1].matchAll(/\b([a-z_][a-z_0-9]*)\s*(?:=|in\b)/g)].map(match => match[1]));
  } else return null;
  return [...choices.keys()].filter(label => !used.has(label)).map(label => ({ label, kind: 5 }));
}

module.exports = { bind, definition, completion };
