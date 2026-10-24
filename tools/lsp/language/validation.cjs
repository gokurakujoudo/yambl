'use strict';
const { checkDecorators } = require('./decorators.cjs');
const { isFlags, codeEntries, checkDecodes } = require('./decodes.cjs');

const { values, generics, entities, structures, stringValue } = require('./syntax.cjs');
const { relationships, builtinModels } = require('./relationships.cjs');
const { Resolver, checkAliases } = require('./expressions.cjs');
const reserved = [...values, ...generics, ...entities, ...structures, ...builtinModels.keys(), 'Entity'];
const namespace = doc => [doc.prefix, doc.namespace].filter(Boolean).join('.');
const key = (doc, ns, name) => [doc.repository || '', ns, name].join('\0');
const snake = name => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name);

// Keep this editor implementation aligned with yambl-compiler using the parity fixtures.
function validate(documents) {
  const symbols = new Map(); const pendingTypes = []; const pendingChecks = [];
  function issue(doc, token, message, severity = 1, code) {
    if (!doc.diagnostics.some(d => d.message === message && d.severity === severity && d.range.start.line === token.range.start.line && d.range.start.character === token.range.start.character)) doc.diagnostics.push({ range: token.range, message, severity, source: 'yambl', ...(code ? { code } : {}) });
  }
  function bind(doc, token, target) { if (target) doc.bindings.set(token.start, target); }
  for (const doc of documents) {
    doc.diagnostics = [...doc.errors]; doc.bindings = new Map(); doc.scope = new Map(); doc.valueTypeTokens = new Map(); doc.markerTargets = new Map();
    if (doc.errors.length) continue;
    for (const decl of doc.declarations.filter(d => d.kind !== 'extend')) {
      const name = decl.name.value; decl.key = key(doc, namespace(doc), name); decl.ownFields = new Map();
      if (['value', 'type_alias', 'decorator'].includes(decl.kind) ? !snake(name) : !/^[A-Z][A-Za-z0-9]*$/.test(name)) issue(doc, decl.token, ['value', 'type_alias', 'decorator'].includes(decl.kind) ? (decl.kind === 'decorator' ? 'decorator names must use snake_case' : 'value names must use snake_case') : 'declaration names must use PascalCase');
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
  for (const builtin of builtinModels.values()) {
    builtin.doc.diagnostics = []; builtin.doc.bindings = new Map(); builtin.doc.valueTypeTokens = new Map();
    if (!symbols.has(builtin.key)) symbols.set(builtin.key, builtin);
    for (const field of builtin.fields) field.owner = builtin;
  }
  for (const doc of documents) for (const [name, declaration] of builtinModels) if (!doc.scope.has(name)) doc.scope.set(name, declaration);
  function checkType(doc, node, owner, allowExact = false) {
    return new Resolver(doc, issue, symbols, owner, allowExact).resolve(node).kind;
  }
  for (const doc of documents.filter(d => !d.errors.length)) {
    for (const decl of doc.declarations) {
      if (decl.kind === 'decodes') {
        checkDecodes(decl, issue);
        for (const entry of codeEntries(decl).filter(e => !e.generated)) bind(doc, entry.name, entry);
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
        else if (decl.parent.value === 'Entity') {}
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
        pendingTypes.push([doc, field.type, target, field.metadata.some(a => ['overload', 'override'].includes(a.name))]);
        const markers = field.metadata.filter(a => ['overload', 'override'].includes(a.name));
        if (markers.length > 1) issue(doc, markers.at(-1).token, 'only one overload or override marker is allowed');
        if (decl.kind === 'value' && !['attr', 'static'].includes(field.mode)) issue(doc, field.token, 'value fields must be attr or static attr');
        if (field.default) {
          if (field.mode !== 'config') issue(doc, field.defaultToken, 'defaults are currently supported only on config attr');
          pendingChecks.push(() => {
            const resolved = new Resolver(doc, () => {}, symbols, target, markers.length > 0).resolve(field.type);
            const value = field.default.value;
            const valid = {
              integer: /^-?\d+$/.test(value), snowflake_id: /^-?\d+$/.test(value),
              float: /^-?\d/.test(value), decimal: /^-?\d/.test(value),
              string: value.startsWith("'"), bool: ['true', 'false'].includes(value),
            };
            if (!valid[resolved.name] || (resolved.exact !== null && (value.startsWith("'") ? stringValue(value) : value) !== resolved.exact)) issue(doc, field.defaultToken, `unsupported or incompatible config default for ${resolved.name}`);
          });
        }
      }
    }
  }
  const valueDecls = [...symbols.values()].filter(d => d.kind === 'value');
  for (const decl of valueDecls) {
    const next = d => d.fields.map(f => symbols.get(new Resolver(d.doc, () => {}, symbols, null).resolve(f.type).key)).filter(t => t?.kind === 'value');
    const pending = next(decl), seen = new Set();
    while (pending.length) {
      const target = pending.pop();
      if (target === decl) { issue(decl.doc, decl.metadata[0]?.token || decl.token, 'value containment cycle'); break; }
      if (!seen.has(target)) { seen.add(target); pending.push(...next(target)); }
    }
  }
  relationships(symbols, issue);
  checkDecorators(documents, issue, symbols);
  checkAliases(documents, issue, symbols);
  for (const check of pendingChecks) check();
  for (const args of pendingTypes) {
    const kind = checkType(...args);
    if (args[2]?.kind === 'value' && kind === 'collection') issue(args[0], args[1].token, 'value fields cannot be collections');
  }
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
  const root = node.quoted ? node.token.value : node.name;
  const args = node.args ? '<' + node.args.map(formatType).join(', ') + '>' : '';
  const params = node.params ? '[' + node.params.map(p => (p.key ? p.key + ': ' : '') + p.value.value).join(', ') + ']' : '';
  const accesses = (node.accesses || []).map(a => a.operator.value + a.token.value).join('');
  return root + args + params + accesses + (node.operations || []).map(a => ' ' + a.operator.value + ' ' + formatType(a.term)).join('') + (node.binding ? ' as ' + node.binding.value : '');
}

function describe(target) {
  if (target.kind === 'decorator_parameter') return `${target.pair ? '*' : ''}${target.name.value}${target.optional ? '?' : ''}: ${formatType(target.type)}${target.default ? ' = ' + formatType(target.default) : ''}`;
  if (target.kind === 'decorator') {
    const targets = target.metadata.filter(a => a.name === 'targets').map(a => `@targets(${a.arguments.map(arg => (arg.mode === 'keyword' ? arg.key.value + '=' : '') + formatType(arg.type)).join(', ')})\n`).join('');
    return `${targets}${target.metadata.some(a => a.name === 'allow_multiple') ? '@allow_multiple\n' : ''}decorator @${target.name.value}(${target.parameters.map(describe).join(', ')})`;
  }
  if (target.kind === 'code') return `code ${target.name.value}${target.generated ? ' = ' + (target.name.value === 'None' ? '0' : 'all declared flags') + ' (generated)' : ': ' + stringValue(target.value.value) + ' (' + target.order.value + ')'}`;
  const details = ['title', 'description'].flatMap(name => (target.metadata || []).filter(a => a.name === name && a.value).map(a => `${name}: ${stringValue(a.value.value)}`));
  const mode = ['snapshot', 'scd', 'config', 'static'].includes(target.mode) ? target.mode + ' attr' : target.mode;
  const signature = target.kind === 'type_alias' ? `type ${target.name.value}${target.parameters.length ? '<' + target.parameters.map(p => p.token.value + ': ' + formatType(p.type)).join(', ') + '>' : ''} = ${formatType(target.type)}` : target.kind ? `${target.kind} ${target.name.value}` : `${mode} ${target.name.value}: ${formatType(target.type)}`;
  return [(target.kind === 'decodes' && isFlags(target) ? '@flags\n' : '') + signature, ...details].join('\n\n');
}

module.exports = { validate, describe, formatType };
