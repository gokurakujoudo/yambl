'use strict';

const { Resolver } = require('../language/expressions.cjs');
const { stringValue } = require('../language/syntax.cjs');
const { codeEntries } = require('../language/decodes.cjs');
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

function checkValue(expected, value, symbols) {
  if (expected.kind === 'unknown' || expected.dependency) return null;
  let error = null, compared = value.value;
  if (expected.kind === 'reference') {
    const entity = symbols.get(expected.key), id = [...(entity?.effective?.values() || [])].find(f => f.mode === 'id');
    return id ? checkValue(resolve(id, symbols), value, symbols) : 'reference requires an entity with an ID';
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
    else if (declaration && !codeEntries(declaration).some(entry => entry.name.value === code)) error = `unknown code for ${owner}: ${code}`;
    compared = code;
  } else if (expected.name === 'type') {
    const entity = [...symbols.values()].find(d => d.kind === 'entity' && qualified(d) === value.value), bound = expected.args[0];
    if (value.kind !== 'name' || !entity) error = 'expected entity type name';
    else if (bound.name !== 'Entity' && ![entity, ...entity.ancestors].some(d => d.key === bound.key)) error = `entity type must derive from ${bound.name}`;
  } else if (['collection', 'values'].includes(expected.name)) {
    if (value.kind !== 'collection') error = 'expected collection literal';
    else for (const item of value.items) { error = checkValue(expected.args[0], item, symbols); if (error) break; }
  } else {
    const declaration = symbols.get(expected.key);
    if (declaration?.kind === 'value') {
      if (value.kind !== 'object') error = 'expected object literal';
      else {
        const items = new Map(value.items.map(([key, item]) => [key.value, item]));
        if (items.size !== value.items.length || items.size !== declaration.fields.length || declaration.fields.some(f => !items.has(f.name.value))) error = 'object fields must match the value definition';
        else for (const field of declaration.fields) { error = checkValue(resolve(field, symbols), items.get(field.name.value), symbols); if (error) break; }
      }
    }
  }
  if (!error && expected.exact !== null && !['type', 'collection', 'values', 'mapping'].includes(expected.name)) {
    const exact = expected.exact.startsWith("'") ? stringValue(expected.exact) : expected.exact;
    if (String(compared) !== exact) error = 'value violates exact constraint';
  }
  return error;
}

function validate(doc) {
  if (!doc.ast || doc.syntaxErrors || !doc.entities) return;
  const issue = (token, message) => doc.diagnostics.push({ range: token.range, severity: 1, source: 'yambl', message });
  const check = (type, value, allowState = false) => {
    if (allowState && value.kind === 'name' && states.has(value.value)) return;
    const error = checkValue(type, value, doc.modelSymbols); if (error) issue(value.token, error);
  };
  const plan = doc.ast.kind === 'transaction' ? doc.ast.plan : doc.ast;
  for (const group of plan.groups) for (const op of group.operations) {
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
        if (candidate.mode !== 'id' && (op.kind === 'delete' || !['static', 'config'].includes(candidate.mode) || candidate.metadata.some(m => m.name === 'dimension') || ['collection', 'values', 'mapping'].includes(type.name))) { issue(column, 'field requires a scope or is not writable'); continue; }
        for (const row of op.rows) check(type, row[index], candidate.mode !== 'id');
      }
      continue;
    }
    if (['id', 'computed'].includes(field.mode)) { issue(op.target, 'field is not writable'); continue; }
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
      else { check(scopeTypes.get(condition.name.text), condition.value); constants.add(condition.name.text); }
    }
    if (op.kind === 'delete') continue;
    rowTypes.set('value', resolve(field, doc.modelSymbols));
    for (const name of rowTypes.keys()) if (!constants.has(name) && !op.columns.some(c => c.text === name)) issue(op.target, `missing replacement column: ${name}`);
    for (const [index, column] of op.columns.entries()) {
      if (!rowTypes.has(column.text)) { issue(column, `unknown replacement column: ${column.text}`); continue; }
      for (const row of op.rows) check(rowTypes.get(column.text), row[index], column.text === 'value');
    }
  }
}

module.exports = { validate, checkValue };
