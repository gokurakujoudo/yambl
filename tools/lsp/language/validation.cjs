'use strict';

const { values, generics, entities, structures, stringValue } = require('./syntax.cjs');
const { relationships, entityArgument, builtinModels } = require('./relationships.cjs');
const reserved = [...values, ...generics, ...entities, ...structures, 'Entity'];
const namespace = doc => [doc.prefix, doc.namespace].filter(Boolean).join('.');
const key = (doc, ns, name) => [doc.repository || '', ns, name].join('\0');
const snake = name => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name);

// Keep this editor implementation aligned with yambl-compiler using the parity fixtures.
function validate(documents) {
  const symbols = new Map(); const pendingTypes = [];
  function issue(doc, token, message, severity = 1, code) {
    doc.diagnostics.push({ range: token.range, message, severity, source: 'yambl', ...(code ? { code } : {}) });
  }
  function bind(doc, token, target) { if (target) doc.bindings.set(token.start, target); }
  for (const doc of documents) {
    doc.diagnostics = [...doc.errors]; doc.bindings = new Map(); doc.scope = new Map(); doc.valueTypeTokens = new Map(); doc.markerTargets = new Map();
    if (doc.errors.length) continue;
    for (const decl of doc.declarations.filter(d => d.kind !== 'extend')) {
      const name = decl.name.value; decl.key = key(doc, namespace(doc), name); decl.ownFields = new Map();
      if (decl.kind === 'value' ? !snake(name) : !/^[A-Z][A-Za-z0-9]*$/.test(name)) issue(doc, decl.token, decl.kind === 'value' ? 'value names must use snake_case' : 'declaration names must use PascalCase');
      const modelDefinition = namespace(doc) === 'builtins' && builtinModels.has(name);
      if ((!modelDefinition && reserved.includes(name)) || symbols.has(decl.key)) issue(doc, decl.token, `duplicate or reserved declaration: ${name}`);
      symbols.set(decl.key, decl); bind(doc, decl.name, decl);
    }
  }
  for (const doc of documents) {
    for (const decl of symbols.values()) if (namespace(decl.doc) === namespace(doc) && (decl.doc.repository || '') === (doc.repository || '')) doc.scope.set(decl.name.value, decl);
    for (const imported of doc.imports) {
      const name = imported.name.value; const target = symbols.get(key(doc, [doc.prefix, imported.namespace].filter(Boolean).join('.'), name));
      if (!target) issue(doc, imported.token, `unknown import: ${imported.namespace}.${name}`);
      else if (doc.scope.has(name) || reserved.includes(name)) issue(doc, imported.token, `import conflicts with visible name: ${name}`);
      else { doc.scope.set(name, target); bind(doc, imported.name, target); }
    }
  }
  function checkType(doc, node, owner) {
    const { name, token, args, params } = node;
    const error = (message, severity, code) => issue(doc, token, message, severity, code);
    if (values.includes(name) || generics.includes(name)) doc.valueTypeTokens.set(token.start, token);
    if (node.quoted) { error('quoted dictionary identifiers are only valid inside code<...>'); return 'unknown'; }
    if (node.selfField) { error('self fields are only valid as field_mapping targets'); return 'unknown'; }
    if (generics.includes(name)) {
      if (params || (args || []).length !== (['map', 'field_mapping'].includes(name) ? 2 : 1)) { error(`invalid type arguments for ${name}`); return 'unknown'; }
      if (name === 'type') {
        if (!entityArgument(args[0], doc, true)) error('type requires Entity or a visible entity type');
        else bind(doc, args[0].token, doc.scope.get(args[0].name) || builtinModels.get(args[0].name));
        return 'value';
      }
      if (name === 'field_mapping') {
        const filter = args[0], target = args[1];
        if (filter.quoted || filter.selfField || filter.args || filter.params || !['attr', 'static', 'config', 'snapshot', 'scd'].includes(filter.name)) error('field_mapping requires an attr, static, config, snapshot or scd filter');
        if (target.selfField) {
          const field = owner?.effective?.get(target.selfField.value);
          if (!field) error(`unknown self field: ${target.selfField.value}`);
          else {
            bind(doc, target.selfField, field);
            if (field.type.name !== 'type' || field.type.params || field.type.args?.length !== 1 || !entityArgument(field.type.args[0], field.doc, true)) error(`self field must have a valid type<...> type: ${target.selfField.value}`);
          }
        } else if (!entityArgument(target, doc)) error('field_mapping requires a visible entity type or self field target');
        else bind(doc, target.token, doc.scope.get(target.name) || builtinModels.get(target.name));
        return 'collection';
      }
      if (name === 'code') {
        const arg = args[0]; const target = doc.scope.get(arg.name);
        if (arg.selfField || arg.args || arg.params || (target && target.kind !== 'decodes') || reserved.includes(arg.name)) error('code requires a Decodes instance identifier');
        else {
          doc.valueTypeTokens.set(arg.token.start, arg.token);
          if (!target) error(`undefined Decodes: ${arg.name}`, 2, 'undefined-decodes');
          else bind(doc, arg.token, target);
        }
        return 'value';
      }
      const kinds = args.map(arg => checkType(doc, arg, owner));
      if (name === 'collection' && !['reference', 'unknown'].includes(kinds[0])) error('collection requires an entity reference');
      if (name === 'values' && !['value', 'string', 'unknown'].includes(kinds[0])) error('values requires a value type');
      if (name === 'map') {
        if (!['string', 'reference', 'unknown'].includes(kinds[0])) error('map keys must be string or entity references');
        if (kinds[1] === 'collection') error('map values cannot be collections');
      }
      return 'collection';
    }
    if (args) error(`${name} does not accept generic arguments`);
    if (params) {
      const keys = params.map(p => p.key);
      const positional = keys.every(k => k === null);
      const validString = name === 'string' && params.length === 1 && [null, 'regex'].includes(keys[0]) && params[0].value.value.startsWith("'");
      const validDecimal = name === 'decimal' && params.length === 2 && params.every(p => /^-?\d+$/.test(p.value.value)) &&
        (positional || (keys.includes('precision') && keys.includes('scale')));
      if (!validString && !validDecimal) error(`invalid parameters for ${name}; do not mix positional and named parameters`);
    }
    if (values.includes(name)) return name === 'string' ? 'string' : 'value';
    const target = doc.scope.get(name); bind(doc, token, target || builtinModels.get(name));
    if (structures.includes(name) || target?.kind === 'value') { doc.valueTypeTokens.set(token.start, token); bind(doc, token, target || builtinModels.get(name)); return 'value'; }
    if (entities.includes(name) || target?.kind === 'entity') return 'reference';
    if (target) error(`${name} is an instance; use code<${name}> or Decodes`);
    else error(`unknown type: ${name}`);
    return 'unknown';
  }
  function metadata(doc, items) {
    const seen = new Set();
    for (const item of items.filter(a => ['title', 'description'].includes(a.name))) {
      if (seen.has(item.name)) issue(doc, item.token, `duplicate metadata: ${item.name}`);
      seen.add(item.name);
    }
  }
  for (const doc of documents.filter(d => !d.errors.length)) {
    for (const decl of doc.declarations) {
      metadata(doc, decl.metadata);
      if (decl.kind === 'decodes') {
        const codes = new Set();
        for (const entry of decl.entries) {
          if (codes.has(entry.code.value)) issue(doc, entry.token, `duplicate code in Decodes: ${entry.code.value}`);
          codes.add(entry.code.value);
        }
        continue;
      }
      const target = doc.scope.get(decl.name.value);
      if (decl.kind === 'extend') bind(doc, decl.name, target);
      const blocked = decl.kind === 'extend' && (builtinModels.get(decl.name.value)?.final || target?.final);
      if (blocked) issue(doc, decl.token, `cannot extend final entity: ${decl.name.value}`);
      else if (decl.kind === 'extend' && (!target || target.kind !== 'entity')) issue(doc, decl.token, `extend requires a visible user-defined entity: ${decl.name.value}`);
      if (decl.parent) {
        const parent = doc.scope.get(decl.parent.value); bind(doc, decl.parent, parent);
        if (builtinModels.get(decl.parent.value)?.final || parent?.final) issue(doc, decl.parent, `cannot inherit final entity: ${decl.parent.value}`);
        else if (!parent || parent.kind !== 'entity') issue(doc, decl.parent, `inherits requires a visible entity type: ${decl.parent.value}`);
        else decl.base = parent;
      }
      for (const field of decl.fields) {
        const name = field.name.value; bind(doc, field.name, field);
        field.owner = target;
        if (!blocked && ['entity', 'value'].includes(target?.kind)) {
          if (target.ownFields.has(name)) issue(doc, field.token, `duplicate field: ${name}`);
          target.ownFields.set(name, field);
        }
        if (!snake(name)) issue(doc, field.token, 'field names must use snake_case');
        if (decl.kind === 'extend' && field.mode === 'id') issue(doc, field.token, 'extend may add attributes, not id fields');
        pendingTypes.push([doc, field.type, target]); metadata(doc, field.metadata);
        const markers = field.metadata.filter(a => ['overload', 'override'].includes(a.name));
        if (markers.length > 1) issue(doc, markers.at(-1).token, 'only one overload or override marker is allowed');
        if (markers.length && field.mode === 'id') issue(doc, markers[0].token, 'field markers require an attr');
        const temporal = field.metadata.filter(a => a.name === 'temporal');
        for (const item of temporal) {
          const d = item.dimensions[0];
          if (!['snapshot', 'scd'].includes(field.mode) || item.dimensions.length !== 1 || d.token.value !== 'as_of_date' ||
            d.type.name !== 'date' || d.type.args || d.type.params) issue(doc, item.token, 'supported annotation is @temporal(as_of_date: date) on snapshot or scd attr');
        }
        if (temporal.length > 1) issue(doc, field.metadata[0].token, 'duplicate temporal annotation');
        const dimensions = new Set(temporal.flatMap(a => a.dimensions.map(d => d.token.value)));
        for (const item of field.metadata.filter(a => a.name === 'dimension')) {
          if (!['attr', 'snapshot', 'scd'].includes(field.mode)) issue(doc, item.token, 'dimension requires attr, snapshot or scd');
          if (![1, 2].includes(item.dimensions.length)) issue(doc, item.token, 'dimension requires one or two parameters');
          for (const [i, dimension] of item.dimensions.entries()) {
            const name = dimension.token.value;
            if (!snake(name)) issue(doc, dimension.token, 'dimension names must use snake_case');
            if (dimensions.has(name)) issue(doc, dimension.token, `duplicate dimension: ${name}`);
            dimensions.add(name); pendingTypes.push([doc, dimension.type, target]);
            if (i === 0 && !['string', 'code'].includes(dimension.type.name)) issue(doc, dimension.token, 'dimension value must be string or code');
            if (i === 1 && (dimension.type.name !== 'Hierarchy' || dimension.type.args || dimension.type.params)) issue(doc, dimension.token, 'dimension selector must be Hierarchy');
          }
        }
        if (decl.kind === 'value') {
          if (!['attr', 'static'].includes(field.mode)) issue(doc, field.token, 'value fields must be attr or static attr');
          for (const item of field.metadata.filter(a => !['title', 'description'].includes(a.name))) issue(doc, item.token, 'value fields allow only title and description annotations');
          if (['collection', 'values', 'map', 'field_mapping'].includes(field.type.name)) issue(doc, field.type.token, 'value fields cannot be collections');
        }
        if (field.default) {
          if (field.mode !== 'config') issue(doc, field.defaultToken, 'defaults are currently supported only on config attr');
          const value = field.default.value;
          const valid = {
            integer: /^-?\d+$/.test(value), snowflake_id: /^-?\d+$/.test(value),
            float: /^-?\d/.test(value), decimal: /^-?\d/.test(value),
            string: value.startsWith("'"), bool: ['true', 'false'].includes(value),
          };
          if (!valid[field.type.name]) issue(doc, field.defaultToken, `unsupported or incompatible config default for ${field.type.name}`);
        }
      }
    }
  }
  const valueDecls = [...symbols.values()].filter(d => d.kind === 'value');
  for (const decl of valueDecls) {
    const next = d => d.fields.map(f => d.doc.scope.get(f.type.name)).filter(t => t?.kind === 'value');
    const pending = next(decl), seen = new Set();
    while (pending.length) {
      const target = pending.pop();
      if (target === decl) { issue(decl.doc, decl.metadata[0]?.token || decl.token, 'value containment cycle'); break; }
      if (!seen.has(target)) { seen.add(target); pending.push(...next(target)); }
    }
  }
  relationships(symbols, issue);
  for (const args of pendingTypes) checkType(...args);
  const invalidField = field => field.doc.diagnostics.some(d => d.severity === 1 &&
    field.doc.tokens.some(t => t.start >= (field.metadata[0]?.token || field.token).start && t.start < field.end &&
      t.range.start.line === d.range.start.line && t.range.start.character === d.range.start.character));
  for (const doc of documents) for (const decl of doc.declarations) for (const field of decl.fields) {
    for (const item of field.metadata.filter(a => ['overload', 'override'].includes(a.name))) {
      const targets = doc.markerTargets.get(item.token.start);
      if (targets && (invalidField(field) || targets.some(invalidField))) {
        doc.markerTargets.delete(item.token.start); doc.markerTargets.delete(item.markerToken.start);
      }
    }
  }
  for (const doc of documents) doc.diagnostics.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character || a.message.localeCompare(b.message));
  return symbols;
}

function formatType(node) {
  if (node.quoted) return node.token.value;
  if (node.selfField) return `self.${node.selfField.value}`;
  const args = node.args ? '<' + node.args.map(formatType).join(', ') + '>' : '';
  const params = node.params ? '[' + node.params.map(p => (p.key ? p.key + ': ' : '') + p.value.value).join(', ') + ']' : '';
  return node.name + args + params;
}
function describe(target) {
  const details = ['title', 'description'].flatMap(name => (target.metadata || []).filter(a => a.name === name && a.value).map(a => `${name}: ${stringValue(a.value.value)}`));
  const mode = ['snapshot', 'scd', 'config', 'static'].includes(target.mode) ? target.mode + ' attr' : target.mode;
  const signature = target.kind ? `${target.kind} ${target.name.value}` : `${mode} ${target.name.value}: ${formatType(target.type)}`;
  return [signature, ...details].join('\n\n');
}

module.exports = { validate, describe, formatType };
