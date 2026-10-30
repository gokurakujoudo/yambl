'use strict';

const { Resolver, canonical } = require('./expressions.cjs');

function checkRelationships(documents, symbols, issue) {
  const resolved = field => new Resolver(field.doc, issue, symbols, field.owner, true).resolve(field.type);
  const shape = field => {
    const type = resolved(field), collection = type.name === 'collection';
    const target = collection ? type.args[0] : type;
    return { collection, target: target?.kind === 'reference' ? target.key : null };
  };
  const coordinates = field => field.metadata.filter(call => call.name === 'dimension').map(call => call.dimension).filter(Boolean);
  const time = field => {
    if (!['snapshot', 'scd'].includes(field.mode)) return '';
    const temporal = field.metadata.find(call => call.name === 'temporal');
    return JSON.stringify((temporal?.dimensions || []).map(pair => [pair.token.value, canonical(new Resolver(field.doc, issue, symbols, field.owner).resolve(pair.type))]));
  };
  for (const doc of documents.filter(d => !d.errors.length)) for (const declaration of doc.declarations) for (const field of declaration.fields) {
    const forward = field.metadata.find(call => call.name === 'relationship');
    const reverse = field.metadata.find(call => call.name === 'reverse_relationship');
    if (!forward && !reverse) continue;
    for (const call of field.metadata.filter(call => call.name === 'dimension')) if (call.dimension?.hierarchy || call.dimension?.fallback) issue(doc, call.token, 'relationship dimensions cannot have hierarchy or fallback');
    if (reverse && (forward || field.metadata.some(call => ['sparse', 'dense'].includes(call.name)))) issue(doc, reverse.token, 'reverse relationship cannot have forward or storage layout annotations');
    const own = shape(field);
    if (forward?.relationship) {
      const [, y] = forward.relationship;
      if (!own.target) issue(doc, forward.token, 'relationship requires an entity reference or collection of entity references');
      else if (y && !(own.collection ? ['maybe', 'many'] : ['maybe', 'one']).includes(y)) issue(doc, forward.token, 'relationship cardinality does not match field type');
    }
    if (!reverse?.targetSpecified) continue;
    const steps = reverse.targetPath || [], syntax = reverse.arguments.find(a => a.mode === 'positional' || a.key?.value === 'target')?.type;
    if (!reverse.targetOwner || steps.length !== (syntax?.accesses?.length || 0)) {
      if ((syntax?.accesses?.length || 0) > 1 && reverse.targetMissing) issue(doc, reverse.targetMissing, `reverse relationship hop ${steps.length + 1} ${reverse.targetMissing.value} is not a visible field`);
      else issue(doc, reverse.token, 'reverse relationship target must be a forward relationship field');
      continue;
    }
    let target = null, cardinality = null, valid = true;
    for (const [index, step] of steps.entries()) {
      const source = step.field, sourceCall = source.metadata.find(call => call.name === 'relationship'), suffix = steps.length > 1 ? ` at hop ${index + 1} ${source.name.value}` : '';
      if (!sourceCall || source.metadata.some(call => call.name === 'reverse_relationship')) { issue(doc, reverse.token, steps.length > 1 ? `reverse relationship hop ${index + 1} ${source.name.value} must be a forward relationship field` : 'reverse relationship target must be a forward relationship field'); valid = false; break; }
      target = shape(source); cardinality = sourceCall.relationship?.[0];
      if (steps.length > 1 && (target.collection || cardinality !== 'one' || !['one', 'maybe'].includes(sourceCall.relationship?.[1]))) { issue(doc, reverse.token, `reverse relationship hop ${index + 1} ${source.name.value} requires a one-to-one reference`); valid = false; }
      if (field.mode !== source.mode || time(field) !== time(source)) issue(doc, reverse.token, 'relationship categories and temporal parameters must match' + suffix);
      const first = coordinates(field), second = coordinates(source);
      if (first.length !== second.length || first.some(dimension => !second.includes(dimension))) issue(doc, reverse.token, 'relationship dimensions must match by declaration identity' + suffix);
    }
    if (!valid) continue;
    if (target?.target !== field.owner.key) issue(doc, reverse.token, 'forward relationship target must match reverse owner');
    if (own.target !== reverse.targetOwner.key || (cardinality === 'one' && own.collection) || (cardinality === 'many' && !own.collection)) issue(doc, reverse.token, 'reverse relationship type does not match source cardinality');
  }
}

module.exports = { checkRelationships };
