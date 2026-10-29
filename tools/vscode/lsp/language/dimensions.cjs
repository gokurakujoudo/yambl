'use strict';

const { Resolver, type, canonical } = require('./expressions.cjs');
const snake = name => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name);
const semantic = node => !node ? null : [node.kind, node.value,
  (node.operands || []).map(semantic), (node.arguments || []).map(a => [a.name, semantic(a.expression)]),
  (node.cases || []).map(c => [c.statuses, c.binding, semantic(c.expression)])];

function collectDimensions(documents, issue) {
  for (const doc of documents) for (const declaration of doc.declarations) {
    if (declaration.kind === 'entity') declaration.ownDimensions = new Map();
  }
  for (const doc of documents) for (const declaration of doc.declarations) {
    const owner = doc.scope.get(declaration.name.value);
    if (owner?.kind !== 'entity') continue;
    owner.ownDimensions ||= new Map();
    for (const dimension of declaration.dimensions || []) {
      dimension.owner = owner;
      if (owner.ownDimensions.has(dimension.name.value)) issue(doc, dimension.token, `duplicate dimension declaration: ${dimension.name.value}`);
      for (const token of [dimension.name, dimension.value, dimension.hierarchy].filter(Boolean)) if (!snake(token.value)) issue(doc, token === dimension.name ? dimension.token : token, 'dimension names must use snake_case');
      owner.ownDimensions.set(dimension.name.value, dimension);
      doc.bindings.set(dimension.name.start, dimension);
    }
  }
}

function resolveDimension(owner, name) {
  const seen = new Set();
  while (owner && !seen.has(owner)) {
    seen.add(owner);
    if (owner.ownDimensions?.has(name)) return owner.ownDimensions.get(name);
    owner = owner.base;
  }
  return null;
}

function dimensionCall(call, field, issue, symbols) {
  const { args, description } = require('./decorators.cjs').callArguments(call, field.doc.scope.get('dimension'), new Resolver(field.doc, () => {}, symbols, field.owner));
  if (call.arguments.some(a => a.mode === 'pair')) {
    issue(field.doc, call.token, 'inline @dimension is no longer supported; declare dimension name { ... } and use @dimension(name)'); return null;
  }
  if (args.length !== 1 || field.kind) {
    issue(field.doc, call.token, '@dimension requires one named dimension reference on a field'); return null;
  }
  const reference = args[0].type;
  const local = resolveDimension(field.owner, reference.name);
  const shared = field.doc.scope.get(reference.name);
  const dimension = !reference.args && !reference.accesses?.length && !reference.operations?.length && !reference.quoted && (local || (shared?.kind === 'dimension' ? shared : null));
  if (!dimension) { issue(field.doc, reference.token, `unknown dimension: ${reference.name}`); return null; }
  field.doc.bindings.set(reference.token.start, dimension);
  const resolver = new Resolver(dimension.doc, issue, symbols, dimension.owner);
  const value = resolver.resolve(dimension.type);
  if (!['string', 'code'].includes(value.name)) issue(dimension.doc, dimension.value, 'dimension value must be string or code');
  if (dimension.hierarchy && resolver.resolve(dimension.hierarchyType).key !== dimension.doc.scope.get('Hierarchy')?.key) issue(dimension.doc, dimension.hierarchy, 'dimension hierarchy requires Hierarchy');
  call.dimension = dimension;
  call.dimensions = [{ token: dimension.value, type: dimension.type }, ...(dimension.hierarchy ? [{ token: dimension.hierarchy, type: dimension.hierarchyType }] : [])];
  const bound = [['variation', dimension.value.value, canonical(value)]];
  if (description) bound.push(['description', '', canonical(resolver.valueType(resolver.evaluate(description)))]);
  if (dimension.hierarchy) bound.push(['selector', dimension.hierarchy.value, canonical(type('Hierarchy', 'reference', { key: dimension.doc.scope.get('Hierarchy').key }))]);
  return JSON.stringify([field.doc.scope.get('dimension').key, bound, semantic(dimension.default), semantic(dimension.fallback)]);
}

function checkDimensions(documents, issue, symbols) {
  for (const doc of documents) for (const declaration of doc.declarations) {
    for (const dimension of declaration.kind === 'dimension' ? [declaration] : declaration.dimensions || []) {
      if (!dimension.owner) for (const token of [dimension.value, dimension.hierarchy].filter(Boolean)) if (!snake(token.value)) issue(doc, token, 'dimension names must use snake_case');
      if (dimension.owner && (resolveDimension(dimension.owner.base, dimension.name.value) || dimension.owner.ownFields?.has(dimension.name.value))) issue(doc, dimension.token, `conflicting dimension declaration: ${dimension.name.value}`);
      const resolver = new Resolver(doc, issue, symbols, dimension.owner);
      if (!['string', 'code'].includes(resolver.resolve(dimension.type).name)) issue(doc, dimension.value, 'dimension value must be string or code');
      if (dimension.hierarchy && resolver.resolve(dimension.hierarchyType).key !== doc.scope.get('Hierarchy')?.key) issue(doc, dimension.hierarchy, 'dimension hierarchy requires Hierarchy');
      if (!dimension.owner && doc.tokens.some(t => t.value === 'self' && t.start >= dimension.token.start && t.end <= dimension.end)) issue(doc, dimension.token, 'shared dimension cannot use self');
    }
    for (const field of declaration.fields) for (const call of field.metadata.filter(a => a.name === 'dimension')) {
      dimensionCall(call, field, issue, symbols);
      if (call.dimension?.fallback && field.mode !== 'snapshot') issue(doc, call.token, 'fallback_days is supported only on snapshot fields');
    }
  }
}

module.exports = { collectDimensions, resolveDimension, dimensionCall, checkDimensions, semantic };
