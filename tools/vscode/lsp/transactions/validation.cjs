'use strict';

const { Resolver } = require('../language/expressions.cjs');
const { stringValue } = require('../language/syntax.cjs');
const { codeEntries, isFlags } = require('../language/decodes.cjs');
const { number } = require('./writing.cjs');
const states = new Set(['NO_ENTRY', 'EMPTY', 'NOT_APPLICABLE']);
const qualified = declaration => [declaration.doc.prefix, declaration.doc.namespace, declaration.name.value].filter(Boolean).join('.');
const keyName = key => key.split('\0').slice(-2).filter(Boolean).join('.');
const resolve = (field, symbols) => new Resolver(field.doc, () => {}, symbols, field.owner, true).resolve(field.type);
function isoDate(value) {
  if (value.kind !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.value) || value.value.startsWith('0000')) return false;
  const date = new Date(value.value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.value;
}

function checkValue(expected, value, symbols, dictionaries = new Map()) {
  if (expected.kind === 'unknown' || expected.dependency) return null;
  let error = null, compared = value.value;
  if (expected.kind === 'reference') {
    const entity = symbols.get(expected.key), id = [...(entity?.effective?.values() || [])].find(f => f.mode === 'id');
    return id ? checkValue(resolve(id, symbols), value, symbols, dictionaries) : 'reference requires an entity with an ID';
  }
  if (['integer', 'snowflake_id'].includes(expected.name)) {
    if (value.kind !== 'number' || !/^-?\d+$/.test(value.value)) error = 'expected integer literal';
    else compared = number(value.value);
  } else if (expected.name === 'decimal') {
    if (value.kind !== 'number') error = 'expected decimal literal';
    else {
      const canonical = number(value.value).replace(/\.0$/, ''), [whole, fraction = ''] = canonical.replace(/^-/, '').split('.');
      const params = Object.fromEntries(expected.params);
      if (params.precision && (fraction.length > Number(params.scale) || whole.replace(/^0+/, '').length > Number(params.precision) - Number(params.scale))) error = 'decimal exceeds declared precision or scale';
      compared = canonical;
    }
  } else if (expected.name === 'bool') {
    if (value.kind !== 'name' || !['true', 'false'].includes(value.value)) error = 'expected bool literal';
  } else if (expected.name === 'date') {
    if (!isoDate(value)) error = 'expected ISO date string';
  } else if (expected.name === 'string') {
    if (value.kind !== 'string') error = 'expected string literal';
  } else if (expected.name === 'code') {
    const dictionary = expected.args[0], declaration = symbols.get(dictionary.key);
    const owner = keyName(dictionary.key), split = value.value?.lastIndexOf('.');
    const code = value.kind === 'name' && value.value.slice(0, split) === owner ? value.value.slice(split + 1) : value.kind === 'string' ? value.value : null;
    if (code === null) error = `expected code from ${owner}`;
    else if (declaration) {
      const known = dictionaries.get(dictionary.key);
      if ((known && !known.has(code)) || (!known && (declaration.subtypeOwner || isFlags(declaration)) && !codeEntries(declaration).some(entry => entry.name.value === code))) error = `unknown code for ${owner}: ${code}`;
    }
    compared = code;
  } else if (expected.name === 'type') {
    const entity = [...symbols.values()].find(d => d.kind === 'entity' && qualified(d) === value.value), bound = expected.args[0];
    if (value.kind !== 'name' || !entity) error = 'expected entity type name';
    else if (bound.name !== 'Entity' && ![entity, ...entity.ancestors].some(d => d.key === bound.key)) error = `entity type must derive from ${bound.name}`;
  } else if (['collection', 'values'].includes(expected.name)) {
    if (value.kind !== 'collection') error = 'expected collection literal';
    else for (const item of value.items) { error = checkValue(expected.args[0], item, symbols, dictionaries); if (error) break; }
  } else {
    const declaration = symbols.get(expected.key);
    if (declaration?.kind === 'value') {
      if (value.kind !== 'object') error = 'expected object literal';
      else {
        const items = new Map(value.items.map(([key, item]) => [key.value, item]));
        if (items.size !== value.items.length || items.size !== declaration.fields.length || declaration.fields.some(f => !items.has(f.name.value))) error = 'object fields must match the value definition';
        else for (const field of declaration.fields) { error = checkValue(resolve(field, symbols), items.get(field.name.value), symbols, dictionaries); if (error) break; }
      }
    }
  }
  if (!error && expected.exact !== null && !['type', 'collection', 'values', 'mapping'].includes(expected.name)) {
    const exact = expected.exact.startsWith("'") ? stringValue(expected.exact) : expected.exact;
    if (String(compared) !== exact) error = 'value violates exact constraint';
  }
  return error;
}

function configMapping(field, value, doc, issue, ownerType, dictionaries) {
  if (value.kind !== 'object') { issue(value.token, 'expected ConfigGroup mapping object'); return; }
  const seen = new Set(), category = field.name.value === 'when' ? 'static' : 'config';
  const fields = new Map();
  for (const entity of doc.entities.values()) for (const candidate of entity.effective.values()) {
    const identity = candidate.identity || candidate;
    if (identity.qualifiedName) fields.set(identity.qualifiedName, identity);
  }
  for (const [key, item] of value.items) {
    if (!['name', 'string'].includes(key.kind) || seen.has(key.value)) { issue(key.token, 'mapping keys must be unique field names'); continue; }
    seen.add(key.value);
    const candidate = fields.get(key.value);
    if (!candidate || candidate.mode !== category) { issue(key.token, `ConfigGroup mapping requires ${category} fields`); continue; }
    if (ownerType && (candidate.owner.ancestors.at(-1) || candidate.owner).key !== (ownerType.ancestors.at(-1) || ownerType).key) { issue(key.token, 'ConfigGroup field is outside its target inheritance tree'); continue; }
    const error = checkValue(resolve(candidate, doc.modelSymbols), item, doc.modelSymbols, dictionaries);
    if (error) issue(item.token, error);
  }
}

function dictionaryOperation(op, symbols, dictionaries, issue) {
  const target = op.target.text;
  if (!['builtins.Decodes', 'builtins.Decodes.entries'].includes(target)) return;
  const declarations = new Map([...symbols.values()].filter(d => d.kind === 'decodes').map(d => [keyName(d.key), d]));
  const idIndex = op.columns.findIndex(c => c.text === 'decodes_id');
  const scope = op.scope.find(c => c.name.text === 'decodes_id' && !c.end);
  const ids = target.endsWith('.entries') ? [scope?.value] : idIndex < 0 ? [] : op.rows.map(row => row[idIndex]);
  for (const id of ids) {
    if (id?.kind !== 'string') continue;
    const declaration = declarations.get(id.value);
    if (!declaration) continue;
    if (declaration.subtypeOwner || isFlags(declaration)) {
      issue(op.target, `${declaration.subtypeOwner ? 'derived' : 'flags'} dictionary is read-only: ${id.value}`);
      continue;
    }
    if (target === 'builtins.Decodes' && op.kind === 'delete') {
      issue(op.target, `model dictionary cannot be deleted: ${id.value}`);
      continue;
    }
    if (!target.endsWith('.entries')) continue;
    if (op.kind === 'delete') {
      if (declaration.entries.length) issue(op.target, `model dictionary entries are immutable: ${id.value}`);
      else dictionaries.set(declaration.key, new Set());
      continue;
    }
    if (op.kind !== 'replace') continue;
    const valueIndex = op.columns.findIndex(c => c.text === 'value');
    if (valueIndex < 0 || op.rows.length > 1) continue;
    const value = op.rows[0]?.[valueIndex];
    if (!value || (value.kind === 'name' && states.has(value.value))) {
      if (declaration.entries.length) issue(op.target, `model dictionary entries are immutable: ${id.value}`);
      else dictionaries.set(declaration.key, new Set());
      continue;
    }
    if (value.kind !== 'collection') continue;
    const entries = new Map(); let valid = true;
    for (const item of value.items) {
      if (item.kind !== 'object') { valid = false; break; }
      const fields = new Map(item.items.map(([key, element]) => [key.value, element]));
      const code = fields.get('code'), decode = fields.get('decode'), order = fields.get('ordering');
      if (fields.size !== 3 || fields.size !== item.items.length || code?.kind !== 'string' || decode?.kind !== 'string' || order?.kind !== 'number' || !/^-?\d+$/.test(order.value)) { valid = false; break; }
      if (entries.has(code.value)) { issue(code.token, 'duplicate collection member'); valid = false; break; }
      entries.set(code.value, [decode.value, BigInt(order.value)]);
    }
    if (!valid) continue;
    const retained = declaration.entries.every(entry => {
      const current = entries.get(entry.code.value), text = entry.order.value;
      const order = text.startsWith('-') ? -BigInt(text.slice(1)) : BigInt(text);
      return current && current[0] === stringValue(entry.value.value) && current[1] === order;
    });
    if (!retained) issue(op.target, `model dictionary entries are immutable: ${id.value}`);
    else dictionaries.set(declaration.key, new Set(entries.keys()));
  }
}

function validate(doc) {
  if (!doc.ast || doc.syntaxErrors || !doc.entities) return;
  const issue = (token, message) => doc.diagnostics.push({ range: token.range, severity: 1, source: 'yambl', message });
  const dictionaries = new Map();
  const check = (type, value, allowState = false, dictionaryView = dictionaries) => {
    if (allowState && value.kind === 'name' && states.has(value.value)) return;
    const error = checkValue(type, value, doc.modelSymbols, dictionaryView); if (error) issue(value.token, error);
  };
  const plan = doc.ast.kind === 'transaction' ? doc.ast.plan : doc.ast;
  const operations = plan.groups.flatMap(group => group.operations), configTypes = new Map();
  if (doc.ast.kind === 'plan') {
    const claims = new Map();
    const claim = (entity, id, field, token) => {
      if (!id || !['string', 'number'].includes(id.kind)) return;
      if (id.kind === 'number' && !/^-?\d+$/.test(id.value)) return;
      const root = (entity.ancestors.at(-1) || entity).key;
      const value = id.kind === 'number' ? number(id.value) : id.value;
      const key = root + '\0' + id.kind + '\0' + value, fields = claims.get(key) || new Set();
      if (fields.has(field) || fields.has('*') || (field === '*' && fields.size)) {
        issue(token, `overlapping operations for ${token.text}`);
      }
      fields.add(field); claims.set(key, fields);
    };
    for (const op of operations) {
      const split = op.target.text.lastIndexOf('.');
      const entity = doc.entities.get(op.target.text) || doc.entities.get(op.target.text.slice(0, split));
      if (!entity) continue;
      const id = [...entity.effective.values()].find(field => field.mode === 'id');
      if (!id) continue;
      if (op.scope.length) {
        const owner = op.scope.find(condition => condition.name.text === id.name.value && !condition.end);
        const field = entity.effective.get(op.target.text.slice(split + 1));
        if (field && owner) claim(entity, owner.value, field.identity || field, op.target);
      } else {
        const index = op.columns.findIndex(column => column.text === id.name.value);
        if (index < 0) continue;
        for (const row of op.rows) {
          if (['insert', 'delete'].includes(op.kind)) claim(entity, row[index], op.kind === 'insert' ? '+' : '*', op.target);
          if (op.kind !== 'delete') for (const column of op.columns) {
            const field = entity.effective.get(column.text);
            if (field && field.mode !== 'id') claim(entity, row[index], field.identity || field, op.target);
          }
        }
      }
    }
  }
  for (const op of operations) {
    if (op.target.text === 'builtins.ConfigGroup') {
      const owner = op.columns.findIndex(c => c.text === 'config_group_id'), type = op.columns.findIndex(c => c.text === 'target_entity_type');
      if (owner >= 0 && type >= 0) for (const row of op.rows) configTypes.set(row[owner].value, doc.entities.get(row[type].value));
    } else if (op.target.text === 'builtins.ConfigGroup.target_entity_type') {
      const owner = op.scope.find(c => c.name.text === 'config_group_id'), type = op.columns.findIndex(c => c.text === 'value');
      if (owner && type >= 0 && op.rows.length === 1) configTypes.set(owner.value.value, doc.entities.get(op.rows[0][type].value));
    }
  }
  if (doc.ast.kind === 'transaction') for (const group of doc.ast.groups) for (const change of group.changes) {
    // Images use the same typed row contract as writes; no instance lookup is needed.
    for (const images of [change.before, change.after]) {
      const imageTypes = new Map();
      for (const image of images) if (image.target.text === 'builtins.ConfigGroup.target_entity_type') {
        const owner = image.columns.findIndex(c => c.text === 'config_group_id'), value = image.columns.findIndex(c => c.text === 'value');
        if (owner >= 0 && value >= 0) for (const row of image.rows) imageTypes.set(row[owner].value, doc.entities.get(row[value].value));
      }
      for (const image of images) {
        const entity = doc.entities.has(image.target.text);
        operations.push({ ...image, kind: entity ? 'insert' : 'replace', scope: entity ? [] : change.scope, configTypes: imageTypes, transactionImage: true });
      }
    }
  }
  for (const op of operations) {
    if (!op.transactionImage) dictionaryOperation(op, doc.modelSymbols, dictionaries, issue);
    const dictionaryView = op.transactionImage ? new Map() : dictionaries;
    const split = op.target.text.lastIndexOf('.'), entity = doc.entities.get(op.target.text) || doc.entities.get(op.target.text.slice(0, split));
    if (!entity) { issue(op.target, `unknown entity: ${op.target.text}`); continue; }
    const field = doc.entities.has(op.target.text) ? null : entity.effective.get(op.target.text.slice(split + 1));
    if (!field && !doc.entities.has(op.target.text)) { issue(op.target, `unknown field: ${op.target.text}`); continue; }
    const id = [...entity.effective.values()].find(f => f.mode === 'id');
    if (!id) { issue(op.target, 'entity requires an ID'); continue; }
    const ownerType = resolve(id, doc.modelSymbols);
    if (!field) {
      if (op.scope.length || op.kind === 'replace') { issue(op.target, 'scope operation requires a field target'); continue; }
      if (!op.columns.some(c => c.text === id.name.value)) issue(op.target, 'entity operation requires its ID column');
      for (const [index, column] of op.columns.entries()) {
        const candidate = entity.effective.get(column.text);
        if (!candidate) { issue(column, `unknown field: ${column.text}`); continue; }
        const type = resolve(candidate, doc.modelSymbols);
        if (candidate.mode !== 'id' && (candidate.builtin || op.kind === 'delete' || !['static', 'config'].includes(candidate.mode) || candidate.metadata.some(m => m.name === 'dimension') || (op.kind !== 'insert' && ['collection', 'values', 'mapping'].includes(type.name)))) { issue(column, 'field requires a scope or is not writable'); continue; }
        for (const row of op.rows) check(type, row[index], candidate.mode !== 'id', dictionaryView);
      }
      continue;
    }
    if (field.builtin || ['id', 'computed'].includes(field.mode)) { issue(op.target, 'field is not writable'); continue; }
    if (!['replace', 'delete'].includes(op.kind) || !op.scope.length) { issue(op.target, 'field operations require replace or delete with scope'); continue; }
    const scopeTypes = new Map([[id.name.value, ownerType]]), rowTypes = new Map(scopeTypes);
    let temporal;
    for (const call of field.metadata) {
      if (call.name === 'dimension' && call.dimension) {
        const dimension = call.dimension, type = new Resolver(dimension.doc, () => {}, doc.modelSymbols, dimension.owner).resolve(dimension.type);
        scopeTypes.set(dimension.value.value, type); rowTypes.set(dimension.value.value, type);
      }
      if (call.name === 'temporal') temporal = call.dimensions[0]?.token.value;
    }
    const dateType = { name: 'date', kind: 'value', exact: null };
    if (temporal) {
      if (field.mode === 'scd') { rowTypes.set('valid_from', dateType); rowTypes.set('valid_to', dateType); }
      else rowTypes.set(temporal, dateType);
    }
    const constants = new Set();
    if (!op.scope.some(c => c.name.text === id.name.value && !c.end)) issue(op.target, 'field scope requires owner ID');
    for (const condition of op.scope) {
      if (condition.name.text === temporal) {
        if (!condition.end || !isoDate(condition.value) || !isoDate(condition.end) || condition.value.value >= condition.end.value) issue(condition.name, 'temporal scope requires an increasing half-open ISO date range');
      } else if (!scopeTypes.has(condition.name.text) || condition.end) issue(condition.name, 'unknown or invalid scope coordinate');
      else { check(scopeTypes.get(condition.name.text), condition.value, false, dictionaryView); constants.add(condition.name.text); }
    }
    if (op.kind === 'delete') continue;
    rowTypes.set('value', resolve(field, doc.modelSymbols));
    for (const name of rowTypes.keys()) if (!constants.has(name) && !op.columns.some(c => c.text === name)) issue(op.target, `missing replacement column: ${name}`);
    for (const [index, column] of op.columns.entries()) {
      if (!rowTypes.has(column.text)) { issue(column, `unknown replacement column: ${column.text}`); continue; }
      for (const row of op.rows) {
        const value = row[index];
        if (column.text === 'value' && qualified(entity) === 'builtins.ConfigGroup' && ['when', 'then_set'].includes(field.name.value) && !(value.kind === 'name' && states.has(value.value))) {
          const owner = op.scope.find(c => c.name.text === id.name.value)?.value.value;
          configMapping(field, value, doc, issue, (op.configTypes || configTypes).get(owner), dictionaryView);
        } else check(rowTypes.get(column.text), value, column.text === 'value', dictionaryView);
      }
    }
  }
}

module.exports = { validate, checkValue };
