'use strict';

const { entities, structures, stringValue, parse, modelRoot } = require('./syntax.cjs');

const { Resolver, type, entity, canonical, equal, accepts, commonType } = require('./expressions.cjs');
function typeSignature(node, doc, owner, symbols) {
  return canonical(new Resolver(doc, () => {}, symbols, owner, true).resolve(node));
}
function signature(field, symbols = new Map(), includeType = true, ignoreExtraInput = false) {
  const { bindCall } = require('./decorators.cjs');
  const annotations = field.metadata.filter(a => !['override', 'overload', 'sparse', 'dense'].includes(a.name) && !(ignoreExtraInput && a.name === 'extra_input_param')).map(a => bindCall(a, field, () => {}, symbols));
  annotations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([field.mode, includeType ? typeSignature(field.type, field.doc, field.owner, symbols) : '', annotations]);
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
    if (!decl.ownFields) decl.ownFields = new Map(decl.fields.map(f => [f.name.value, f]));
    for (const ancestor of [...decl.ancestors].reverse()) for (const [name, field] of ancestor.ownFields) decl.effective.set(name, field);
    for (const [name, field] of decl.ownFields) decl.effective.set(name, field);
  }
  const groups = new Map();
  for (const decl of declarations.sort((a, b) => a.ancestors.length - b.ancestors.length)) {
    for (const [name, field] of decl.ownFields) {
      field.identity = field;
      field.qualifiedName = ((decl.ancestors.at(-1) || decl).key.split('\0').slice(-2).filter(Boolean).join('.')) + '.' + name;
      const ancestor = decl.ancestors.find(a => a.ownFields.has(name));
      if (ancestor) {
        const prior = ancestor.ownFields.get(name);
        if (marker(field) !== 'override') issue(field.doc, field.token, `duplicate inherited field: ${name}; use @override`);
        else if (signature(field, symbols, false, field.abstract || prior.abstract) !== signature(prior, symbols, false, field.abstract || prior.abstract) || !overrideType(field, prior, symbols)) issue(field.doc, field.token, `override signature mismatch: ${name}`);
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
    const types = fields.map(f => new Resolver(f.doc, () => {}, symbols, f.owner, true).resolve(f.type));
    const common = commonType(types, symbols);
    if (fields.every(f => marker(f) === 'overload') && new Set(fields.map(f => signature(f, symbols, false))).size === 1 && common) {
      const identity = [...fields].sort((a, b) => a.owner.key.localeCompare(b.owner.key))[0];
      for (const field of fields) {
        replacements.set(field, identity); field.commonType = common;
        navigation(field, fields.filter(f => f !== field));
      }
    } else for (const field of fields) issue(field.doc, field.token, `overload requires marked branches with identical signatures: ${name}`);
  }
  for (const decl of declarations) for (const field of decl.ownFields.values()) field.identity = replacements.get(field.identity) || field.identity;
  for (const decl of declarations) {
    const root = decl.ancestors.at(-1) || decl;
    for (const name of ['entity_type', 'root_entity_type']) {
      const token = { ...decl.name, value: name };
      const target = name === 'entity_type' ? type(decl.name.value, 'reference', { key: decl.key }) : entity;
      const field = { name: token, token, type: { name: 'type', args: [{ name: name === 'entity_type' ? 'self' : 'Entity' }], token: { ...token, start: name === 'entity_type' ? -1 : -2 }, builtinType: type('type', 'value', { args: [target] }) }, mode: 'static', metadata: [], doc: decl.doc, owner: decl, builtin: true };
      field.qualifiedName = root.key.split('\0').slice(-2).filter(Boolean).join('.') + '.' + name;
      field.identity = root === decl ? field : root.effective.get(name);
      decl.effective.set(name, field);
    }
  }
}

// These schemas also make built-in mapping candidates available without user declarations.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
function modelFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? modelFiles(file) : entry.name.endsWith('.yambl') ? [file] : [];
  }).sort();
}
const builtinDocuments = modelFiles(modelRoot).map(filename => {
  const doc = parse(fs.readFileSync(filename, 'utf8'), pathToFileURL(filename).href);
  if (doc.errors.length || doc.namespace !== 'builtins') throw new Error(`Invalid built-in model: ${filename}`);
  doc.builtin = true;
  return doc;
});
const builtinLocals = new Map(builtinDocuments.flatMap(doc => doc.declarations.filter(d => d.kind !== 'extend').map(d => {
  d.effective = new Map(d.fields.map(f => [f.name.value, f])); d.ancestors = [];
  if (d.kind === 'value') structures.push(d.name.value);
  if (d.kind === 'entity') entities.push(d.name.value);
  d.key = '\0builtins\0' + d.name.value;
  return [d.name.value, d];
})));
const builtinModels = new Map([...builtinLocals].filter(([, d]) => d.kind !== 'constant'));
for (const doc of builtinDocuments) { doc.scope = builtinLocals; doc.bindings = new Map(); doc.valueTypeTokens = new Map(); doc.diagnostics = []; }
const builtinEntities = new Map([...builtinModels].filter(([, d]) => d.kind === 'entity'));
function overrideType(field, prior, symbols) {
  const actual = new Resolver(field.doc, () => {}, symbols, field.owner, true).resolve(field.type);
  const expected = new Resolver(prior.doc, () => {}, symbols, prior.owner, true).resolve(prior.type);
  return equal(actual, expected) || ((actual.exact !== null || actual.allowed?.length) && accepts(expected, actual, symbols));
}
function mappingCandidates(target, mode, symbols) {
  const result = new Map();
  for (const decl of new Set([target, ...symbols.values()])) {
    if (decl !== target && !decl.ancestors?.includes(target)) continue;
    for (const [name, field] of decl.effective) if (field.mode === mode && !['collection', 'unknown'].includes(new Resolver(field.doc, () => {}, symbols, field.owner, true).resolve(field.type).kind)) {
      if (!result.has(name)) result.set(name, []);
      if (!result.get(name).includes(field)) result.get(name).push(field);
    }
  }
  return result;
}
module.exports = { relationships, signature, mappingCandidates, builtinEntities, builtinModels, builtinLocals, builtinDocuments, modelRoot };
