'use strict';

const { values, generics, entities, stringValue } = require('./syntax.cjs');
const reserved = [...values, ...generics, ...entities];
const key = (ns, name) => ns + '\0' + name;
const snake = name => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name);

// Keep this editor implementation aligned with yambl-compiler using the parity fixtures.
function validate(documents) {
  const symbols = new Map();
  function issue(doc, token, message, severity = 1) {
    doc.diagnostics.push({ range: token.range, message, severity, source: 'yambl' });
  }
  function bind(doc, token, target) { if (target) doc.bindings.set(token.start, target); }
  for (const doc of documents) {
    doc.diagnostics = [...doc.errors]; doc.bindings = new Map(); doc.scope = new Map();
    if (doc.errors.length) continue;
    for (const decl of doc.declarations.filter(d => d.kind !== 'extend')) {
      const name = decl.name.value; decl.key = key(doc.namespace, name); decl.ownFields = new Map();
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) issue(doc, decl.token, 'declaration names must use PascalCase');
      if (reserved.includes(name) || symbols.has(decl.key)) issue(doc, decl.token, `duplicate or reserved declaration: ${name}`);
      symbols.set(decl.key, decl); bind(doc, decl.name, decl);
    }
  }
  for (const doc of documents) {
    for (const decl of symbols.values()) if (decl.doc.namespace === doc.namespace) doc.scope.set(decl.name.value, decl);
    for (const imported of doc.imports) {
      const name = imported.name.value; const target = symbols.get(key(imported.namespace, name));
      if (!target) issue(doc, imported.token, `unknown import: ${imported.namespace}.${name}`);
      else if (doc.scope.has(name) || entities.includes(name)) issue(doc, imported.token, `import conflicts with visible name: ${name}`);
      else { doc.scope.set(name, target); bind(doc, imported.name, target); }
    }
  }
  function checkType(doc, node) {
    const { name, token, args, params } = node;
    const error = (message, severity) => issue(doc, token, message, severity);
    if (node.quoted) { error('quoted dictionary identifiers are only valid inside code<...>'); return 'unknown'; }
    if (generics.includes(name)) {
      if (params || (args || []).length !== (name === 'map' ? 2 : 1)) { error(`invalid type arguments for ${name}`); return 'unknown'; }
      if (name === 'code') {
        const arg = args[0]; const target = doc.scope.get(arg.name);
        if (arg.args || arg.params || (target && target.kind !== 'decodes') || reserved.includes(arg.name)) error('code requires a Decodes instance identifier');
        else if (!target) error(`undefined Decodes: ${arg.name}`, 2);
        else bind(doc, arg.token, target);
        return 'value';
      }
      const kinds = args.map(arg => checkType(doc, arg));
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
    const target = doc.scope.get(name); bind(doc, token, target);
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
          if (codes.has(entry.code.value)) issue(doc, entry.token, `duplicate code in Decodes identity: ${entry.code.value}`);
          codes.add(entry.code.value);
        }
        continue;
      }
      const target = doc.scope.get(decl.name.value);
      if (decl.kind === 'extend') bind(doc, decl.name, target);
      if (!target || target.kind !== 'entity') issue(doc, decl.token, `extend requires a visible user-defined entity: ${decl.name.value}`);
      if (decl.parent) {
        const parent = doc.scope.get(decl.parent.value); bind(doc, decl.parent, parent);
        if (entities.includes(decl.parent.value)) issue(doc, decl.parent, 'built-in inheritance is unsupported; Decodes is sealed');
        else if (!parent || parent.kind !== 'entity') issue(doc, decl.parent, `inherits requires a visible entity type: ${decl.parent.value}`);
        else decl.base = parent;
      }
      for (const field of decl.fields) {
        const name = field.name.value; bind(doc, field.name, field);
        if (target?.kind === 'entity') {
          if (target.ownFields.has(name)) issue(doc, field.token, `duplicate field: ${name}`);
          target.ownFields.set(name, field);
        }
        if (!snake(name)) issue(doc, field.token, 'field names must use snake_case');
        if (decl.kind === 'extend' && field.mode === 'id') issue(doc, field.token, 'extend may add attributes, not id fields');
        checkType(doc, field.type); metadata(doc, field.metadata);
        const temporal = field.metadata.filter(a => a.name === 'temporal');
        for (const item of temporal) {
          const d = item.dimensions[0];
          if (!['snapshot', 'scd'].includes(field.mode) || item.dimensions.length !== 1 || d.token.value !== 'as_of_date' ||
            d.type.name !== 'date' || d.type.args || d.type.params) issue(doc, item.token, 'supported annotation is @temporal(as_of_date: date) on snapshot or scd attr');
        }
        if (temporal.length > 1) issue(doc, field.metadata[0].token, 'duplicate temporal annotation');
        const dimensions = new Set();
        for (const item of field.metadata.filter(a => a.name === 'dimensions')) {
          for (const dimension of item.dimensions) {
            const name = dimension.token.value;
            if (!snake(name)) issue(doc, dimension.token, 'dimension names must use snake_case');
            if (dimensions.has(name)) issue(doc, dimension.token, `duplicate dimension: ${name}`);
            dimensions.add(name); checkType(doc, dimension.type);
          }
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
  for (const decl of symbols.values()) {
    if (decl.kind !== 'entity') continue;
    const seen = new Set([decl]); const inherited = new Set(); let base = decl.base;
    while (base) {
      if (seen.has(base)) { issue(decl.doc, decl.token, 'inheritance cycle'); break; }
      seen.add(base); for (const name of base.ownFields.keys()) inherited.add(name); base = base.base;
    }
    for (const [name, field] of decl.ownFields) if (inherited.has(name)) issue(field.doc, field.token, `duplicate inherited field: ${name}`);
  }
  for (const doc of documents) doc.diagnostics.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character || a.message.localeCompare(b.message));
  return symbols;
}

function describe(target) {
  const details = (target.metadata || []).filter(a => a.value).map(a => stringValue(a.value.value));
  const signature = target.kind ? `${target.kind} ${target.name.value}` : `${target.mode} ${target.name.value}: ${target.type.name}`;
  return [signature, ...details].join('\n\n');
}

module.exports = { validate, describe };
