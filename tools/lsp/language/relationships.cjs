'use strict';

const { entities, structures, stringValue, parse } = require('./syntax.cjs');

function entityArgument(node, doc, universal = false) {
  return !node.quoted && !node.selfField && !node.args && !node.params &&
    ((universal && node.name === 'Entity') || entities.includes(node.name) || doc.scope.get(node.name)?.kind === 'entity');
}
function typeSignature(node, doc, fields = new Map()) {
  if (node.selfField) {
    const field = fields.get(node.selfField.value);
    return ['self', node.selfField.value, field ? typeSignature(field.type, field.doc) : null];
  }
  const identity = doc.scope.get(node.name)?.key || node.name;
  const params = (node.params || []).map((p, i) => [p.key || (node.name === 'decimal' ? ['precision', 'scale'][Math.min(i, 1)] : 'regex'),
    p.value.value.startsWith("'") ? stringValue(p.value.value) : BigInt(p.value.value).toString()]).sort((a, b) => a[0].localeCompare(b[0]));
  return [identity, (node.args || []).map(arg => typeSignature(arg, doc, fields)), params];
}
function signature(field) {
  const annotations = [];
  for (const item of field.metadata) {
    if (['title', 'description'].includes(item.name)) annotations.push([item.name, stringValue(item.value.value)]);
    if (['temporal', 'dimension'].includes(item.name)) annotations.push([item.name, item.dimensions.map(d => [d.token.value, typeSignature(d.type, field.doc, field.owner?.effective)])]);
  }
  annotations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([field.mode, typeSignature(field.type, field.doc, field.owner?.effective), annotations]);
}
const markers = field => field.metadata.filter(a => ['overload', 'override'].includes(a.name));
const marker = field => markers(field)[0]?.name;
function navigation(field, targets) {
  if (markers(field).length !== 1 || field.mode === 'id') return;
  const item = markers(field)[0];
  for (const token of [item.token, item.markerToken]) field.doc.markerTargets.set(token.start, targets);
}
function relationships(symbols, issue) {
  const declarations = [...symbols.values()].filter(d => d.kind === 'entity');
  for (const decl of declarations) {
    const seen = new Set([decl]); decl.ancestors = []; let base = decl.base;
    while (base) {
      if (seen.has(base)) { issue(decl.doc, decl.token, 'inheritance cycle'); break; }
      seen.add(base); decl.ancestors.push(base); base = base.base;
    }
    decl.effective = new Map();
    for (const ancestor of [...decl.ancestors].reverse()) for (const [name, field] of ancestor.ownFields) decl.effective.set(name, field);
    for (const [name, field] of decl.ownFields) decl.effective.set(name, field);
  }
  const groups = new Map();
  for (const decl of declarations.sort((a, b) => a.ancestors.length - b.ancestors.length)) {
    for (const [name, field] of decl.ownFields) {
      field.identity = field;
      const ancestor = decl.ancestors.find(a => a.ownFields.has(name));
      if (ancestor) {
        const prior = ancestor.ownFields.get(name);
        if (marker(field) !== 'override') issue(field.doc, field.token, `duplicate inherited field: ${name}; use @override`);
        else if (signature(field) !== signature(prior)) issue(field.doc, field.token, `override signature mismatch: ${name}`);
        else { field.identity = prior.identity || prior; navigation(field, [prior]); }
      } else if (marker(field) === 'override') issue(field.doc, field.token, `override requires an inherited field: ${name}`);
      else if (field.mode !== 'id') {
        const key = (decl.ancestors.at(-1) || decl).key + '\0' + name;
        if (!groups.has(key)) groups.set(key, []); groups.get(key).push(field);
      }
    }
  }
  const replacements = new Map();
  for (const fields of groups.values()) {
    const name = fields[0].name.value;
    if (fields.length === 1) {
      if (marker(fields[0]) === 'overload') issue(fields[0].doc, fields[0].metadata[0]?.token || fields[0].token, `overload requires another branch implementation: ${name}`);
      continue;
    }
    if (fields.every(f => marker(f) === 'overload') && new Set(fields.map(signature)).size === 1) {
      const identity = [...fields].sort((a, b) => a.owner.key.localeCompare(b.owner.key))[0];
      for (const field of fields) {
        replacements.set(field, identity);
        navigation(field, fields.filter(f => f !== field));
      }
    } else for (const field of fields) issue(field.doc, field.token, `overload requires marked branches with identical signatures: ${name}`);
  }
  for (const decl of declarations) for (const field of decl.ownFields.values()) field.identity = replacements.get(field.identity) || field.identity;
}

// These schemas also make built-in mapping candidates available without user declarations.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const packagedRoot = path.join(__dirname, '../models');
const modelRoot = fs.existsSync(packagedRoot) ? packagedRoot : path.join(__dirname, '../../../models');
const builtinDocuments = fs.readdirSync(modelRoot).filter(name => name.endsWith('.yambl')).sort().map(name => {
  const filename = path.join(modelRoot, name);
  const doc = parse(fs.readFileSync(filename, 'utf8'), pathToFileURL(filename).href);
  if (doc.errors.length || doc.namespace) throw new Error(`Invalid built-in model: ${filename}`);
  doc.builtin = true;
  return doc;
});
const builtinModels = new Map(builtinDocuments.flatMap(doc => doc.declarations.map(d => {
  d.effective = new Map(d.fields.map(f => [f.name.value, f])); d.ancestors = [];
  (d.kind === 'value' ? structures : entities).push(d.name.value);
  return [d.name.value, d];
})));
const builtinEntities = new Map([...builtinModels].filter(([, d]) => d.kind === 'entity'));
function mappingCandidates(target, mode, symbols) {
  const result = new Map();
  for (const decl of new Set([target, ...symbols.values()])) {
    if (decl !== target && !decl.ancestors?.includes(target)) continue;
    for (const [name, field] of decl.effective) if (field.mode === mode) {
      if (!result.has(name)) result.set(name, []);
      if (!result.get(name).includes(field)) result.get(name).push(field);
    }
  }
  return result;
}
module.exports = { relationships, entityArgument, signature, mappingCandidates, builtinEntities, builtinModels, modelRoot };
