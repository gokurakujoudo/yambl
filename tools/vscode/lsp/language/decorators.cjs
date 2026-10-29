'use strict';

const { Resolver, type, term, canonical, accepts } = require('./expressions.cjs');
const snake = name => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name);
const hasSelf = node => node.name === 'self' || (node.args || []).some(hasSelf) || (node.operations || []).some(op => hasSelf(op.term));

function capture(node, symbols) {
  if (!node.kind) return term(type('attrs'), 'field', { path: 'self', source: node });
  if (node.kind === 'decorator') return term(type('decorator', 'value', { key: node.key }), 'value');
  return new Resolver(node.doc, () => {}, symbols, null).evaluate({ token: node.name, name: node.name.value });
}

function argumentType(resolver, syntax, expected) {
  let actual = resolver.valueType(resolver.evaluate(syntax));
  const literalKind = syntax.quoted ? 'STRING' : ['true', 'false'].includes(syntax.name) ? 'BOOLEAN' : /^-?\d+$/.test(syntax.name) ? 'INT' : 'NUMBER';
  const literalTypes = { string: ['STRING'], integer: ['INT'], snowflake_id: ['INT'], float: ['INT', 'NUMBER'], decimal: ['INT', 'NUMBER'], bool: ['BOOLEAN'] };
  if ((syntax.quoted || syntax.literal) && !syntax.args && !syntax.params && !syntax.accesses?.length && !syntax.operations?.length && literalTypes[expected.name]?.includes(literalKind)) actual = { ...expected, exact: actual.exact };
  if (expected.name === 'date' && actual.name === 'string') {
    const value = actual.exact;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) > 0 && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value) actual = { ...expected, exact: value };
    else resolver.issue(syntax, 'date argument requires a valid YYYY-MM-DD string');
  }
  if (expected.kind === 'reference' && actual.name === 'string') {
    const ids = [...(resolver.symbols.get(expected.key)?.effective || new Map()).values()].filter(f => f.mode === 'id');
    if (ids.length !== 1) resolver.issue(syntax, 'reference argument requires one identifiable ID field');
    else {
      const field = ids[0];
      const idType = new Resolver(field.doc, resolver.report, resolver.symbols, null).resolve(field.type);
      if (['string', 'snowflake_id'].includes(idType.name)) actual = { ...expected, exact: actual.exact };
    }
  }
  if (actual.kind === 'unknown' || !accepts(expected, actual, resolver.symbols)) resolver.issue(syntax, 'incompatible decorator argument');
  return actual;
}

function checkParameters(declaration, issue, symbols) {
  if (declaration.name.value === 'extra_input_params') issue(declaration.doc, declaration.token, 'use @extra_input_param instead of @extra_input_params');
  if (!declaration.metadata.some(a => a.name === 'targets')) issue(declaration.doc, declaration.token, 'decorator requires explicit @targets');
  const seen = new Set(); let pairSeen = false, optionalSeen = false;
  const resolver = new Resolver(declaration.doc, issue, symbols, null);
  for (const formal of declaration.parameters) {
    const name = formal.name.value;
    declaration.doc.bindings.set(formal.name.start, formal);
    if (!snake(name)) resolver.issue(formal, 'decorator parameter names must use snake_case');
    if (name === 'description') resolver.issue(formal, 'description is reserved decorator metadata');
    if (seen.has(name)) resolver.issue(formal, `duplicate decorator parameter: ${name}`);
    seen.add(name);
    if ((pairSeen && !formal.pair) || (optionalSeen && !formal.optional)) resolver.issue(formal, 'ordinary parameters precede pairs; optional pairs come last');
    if ((formal.optional && !formal.pair) || (formal.pair && formal.default)) resolver.issue(formal, 'only pairs use ?; only ordinary parameters use defaults');
    pairSeen ||= formal.pair; optionalSeen ||= formal.optional;
    if (!hasSelf(formal.type)) {
      const expected = resolver.resolve(formal.type);
      if (expected.name === 'input_type' && !formal.pair) resolver.issue(formal.type, 'input_type is only a decorator pair constraint');
      if (expected.kind === 'collection') resolver.issue(formal.type, 'decorator parameters cannot be collections');
      if (formal.default && !hasSelf(formal.default)) argumentType(resolver, formal.default, expected);
    }
  }
}

function callArguments(call, declaration, resolver) {
  const ordinary = declaration.parameters.filter(p => !p.pair);
  const args = [], supplied = new Set(); let description = null, position = 0, pairSeen = false;
  for (const [i, argument] of call.arguments.entries()) {
    const named = argument.mode === 'keyword' && argument.key.value === 'description';
    const trailing = argument.mode === 'positional' && i === call.arguments.length - 1 && (pairSeen || ordinary.every(p => supplied.has(p.name.value))) && argument.type.quoted && !argument.type.accesses.length && !argument.type.operations?.length && !argument.type.args && !argument.type.params;
    if (named || trailing) {
      if (description) resolver.issue(argument, 'duplicate decorator description');
      if (i !== call.arguments.length - 1) resolver.issue(argument, 'description must be the final decorator argument');
      description = argument.type;
    } else {
      args.push(argument);
      if (argument.mode === 'keyword') supplied.add(argument.key.value);
      else if (argument.mode === 'positional' && position < ordinary.length) supplied.add(ordinary[position].name.value);
      position += Number(argument.mode === 'positional'); pairSeen ||= argument.mode === 'pair';
    }
  }
  return { args, description };
}

function bindCall(call, node, issue, symbols, values = null) {
  const doc = node.doc, name = call.name;
  const actualResolver = new Resolver(doc, issue, symbols, null, false, new Map([['self', capture(node, symbols)]]));
  if (name === 'extra_input_params') { actualResolver.issue(call, 'use @extra_input_param instead of @extra_input_params'); return ''; }
  const declaration = doc.scope.get(name);
  if (declaration?.kind !== 'decorator') { actualResolver.issue(call, `unknown decorator: ${name}`); return ''; }
  doc.bindings.set(call.markerToken.start, declaration);
  const { args, description } = callArguments(call, declaration, actualResolver);
  const descriptionType = description && argumentType(actualResolver, description, type('string', 'string'));
  if (descriptionType) values?.set('description', descriptionType);
  if (name === 'dimension') return require('./dimensions.cjs').dimensionCall(call, node, issue, symbols) || '';
  const formalResolver = new Resolver(declaration.doc, issue, symbols, null, false, actualResolver.bindings);
  const ordinary = declaration.parameters.filter(p => !p.pair), pairs = declaration.parameters.filter(p => p.pair);
  const supplied = new Map(), keys = new Set();
  let position = 0, pairPosition = 0, keywordSeen = false, pairSeen = false;
  for (const argument of args) {
    let formal;
    if (argument.mode === 'pair') {
      pairSeen = true;
      const key = argument.key.value;
      if (!snake(key)) actualResolver.issue(argument, 'pair keys must use snake_case');
      if (keys.has(key)) actualResolver.issue(argument, `duplicate pair key: ${key}`);
      keys.add(key); formal = pairs[pairPosition++];
    } else if (argument.mode === 'keyword') {
      keywordSeen = true; formal = ordinary.find(p => p.name.value === argument.key.value);
      if (formal) doc.bindings.set(argument.key.start, formal);
    } else {
      if (keywordSeen) actualResolver.issue(argument, 'positional arguments must precede named arguments');
      formal = ordinary[position++];
    }
    if (pairSeen && argument.mode !== 'pair') actualResolver.issue(argument, 'new pairs must follow ordinary arguments');
    if (!formal) actualResolver.issue(argument, `unexpected argument for decorator: ${name}`);
    else if (supplied.has(formal.name.value)) actualResolver.issue(argument, `duplicate decorator argument: ${formal.name.value}`);
    else supplied.set(formal.name.value, argument);
  }
  const bound = descriptionType ? [['description', '', canonical(descriptionType)]] : [];
  for (const formal of declaration.parameters) {
    const expected = formalResolver.resolve(formal.type), name = formal.name.value;
    if (expected.kind === 'collection') formalResolver.issue(formal.type, 'decorator parameters cannot be collections');
    const argument = supplied.get(name);
    if (!argument) {
      if (formal.default) {
        const actual = argumentType(formalResolver, formal.default, expected);
        bound.push([name, '', canonical(actual)]); values?.set(name, actual);
      }
      else if (!formal.optional) actualResolver.issue(call, `missing decorator argument: ${name}`);
      continue;
    }
    if (formal.pair) {
      const actual = actualResolver.resolve(argument.type);
      if (['collection', 'unknown'].includes(actual.kind) || ['attrs', 'dimension_ref', 'input_type'].includes(actual.name) || (expected.name !== 'input_type' && !accepts(expected, actual, symbols))) actualResolver.issue(argument.type, 'incompatible decorator pair type');
      bound.push([name, argument.key.value, canonical(actual)]);
      values?.set(name, actual);
      if (argument.default) {
        if (call.name !== 'extra_input_param') actualResolver.issue(argument, 'pair defaults are only supported by extra_input_param');
        const value = argumentType(actualResolver, argument.default, actual);
        bound.push(['parameter_default', argument.key.value, canonical(value)]); values?.set('parameter_default', value);
      }
    } else {
      const actual = argumentType(actualResolver, argument.type, expected);
      bound.push([name, '', canonical(actual)]); values?.set(name, actual);
      if (['title', 'description'].includes(call.name) && argument.type.quoted) call.value = argument.type.token;
    }
  }
  return JSON.stringify([declaration.key, bound]);
}

function targetContract(definition, symbols) {
  const targets = definition.metadata.find(a => a.name === 'targets');
  if (!targets) return null;
  const values = new Map(); let invalid = false;
  bindCall(targets, definition, () => { invalid = true; }, symbols, values);
  return invalid ? null : values;
}

function allowsTarget(contract, kind, mode) {
  if (!contract || !(contract.get('targets')?.exact || '').split('+').includes(kind)) return false;
  if (!['EntityAttr', 'ValueAttr'].includes(kind)) return true;
  const categories = (contract.get('categories')?.exact || '').split('+').filter(Boolean);
  return mode ? categories.includes(mode[0].toUpperCase() + mode.slice(1)) : categories.length > 0;
}

function allowsMultiple(definition) {
  return definition.name.value !== 'allow_multiple' && definition.metadata.some(a => a.name === 'allow_multiple');
}

function checkTarget(call, node, declaration, issue, symbols) {
  const contract = targetContract(node.doc.scope.get(call.name), symbols);
  if (!contract) return;
  let mode = node.mode;
  let kind = { entity: 'Entity', value: 'Value', decodes: 'Decodes', type_alias: 'Type', decorator: 'Decorator', lookup: 'Lookup' }[node.kind];
  if (!node.kind) {
    kind = mode === 'id' ? 'Id' : declaration.kind === 'value' ? 'ValueAttr' : 'EntityAttr';
    if (kind === 'ValueAttr') mode = 'static';
  }
  if (!allowsTarget(contract, kind, mode)) issue(node.doc, call.token, `decorator ${call.name} does not allow this target`);
}

function checkDecorators(documents, issue, symbols) {
  const groups = new Map(), placements = new Map();
  for (const doc of documents.filter(d => !d.errors.length)) for (const declaration of doc.declarations) {
    if (declaration.kind === 'decorator') checkParameters(declaration, issue, symbols);
    for (const node of [declaration, ...declaration.fields, ...(declaration.lookups || [])]) {
      const seen = new Set(), dimensions = new Set();
      for (const call of node.metadata) {
        const name = call.name;
        const values = new Map();
        bindCall(call, node, issue, symbols, values);
        const definition = doc.scope.get(name);
        if (definition?.kind === 'decorator') checkTarget(call, node, declaration, issue, symbols);
        if (definition?.kind === 'decorator' && seen.has(name) && !allowsMultiple(definition)) issue(doc, call.token, `duplicate decorator: ${name}`);
        seen.add(name);
        if (['sparse', 'dense'].includes(name)) {
          if (!snake(values.get('cat')?.exact || '')) issue(doc, call.token, 'storage category must be nonempty snake_case');
          if (node.metadata.some(a => a.name === 'dimension') || (node.metadata.some(a => a.name === 'sparse') && node.metadata.some(a => a.name === 'dense'))) issue(doc, call.token, 'sparse, dense and dimension are mutually exclusive');
          if (!node.kind && new Resolver(doc, () => {}, symbols, node.owner).resolve(node.type).kind === 'collection') issue(doc, call.token, 'storage grouping requires a non-collection field');
          if (!node.kind && node.owner?.kind === 'entity') {
            const root = (node.owner.ancestors?.at(-1) || node.owner).key;
            const category = values.get('cat')?.exact || '';
            const groupKey = root + '\0' + category, fieldKey = root + '\0' + node.name.value;
            const placement = JSON.stringify([name, category]);
            if (groups.has(groupKey) && groups.get(groupKey) !== name) issue(doc, call.token, 'conflicting sparse/dense layout for storage category');
            if (placements.has(fieldKey) && placements.get(fieldKey) !== placement) issue(doc, call.token, 'conflicting storage groups across field implementations');
            groups.set(groupKey, name); placements.set(fieldKey, placement);
          }
        }
        if (['temporal', 'dimension'].includes(name)) {
          if (name === 'dimension' && call.dimensions.length) {
            const first = new Resolver(doc, () => {}, symbols, null, false, new Map([['self', capture(node, symbols)]])).resolve(call.dimensions[0].type);
            if (first.kind !== 'unknown' && !['string', 'code'].includes(first.name)) issue(doc, call.dimensions[0].token, 'dimension value must be string or code');
          }
          for (const pair of call.dimensions) {
            const key = pair.token.value;
            if (dimensions.has(key)) issue(doc, pair.token, `duplicate dimension: ${key}`);
            dimensions.add(key);
          }
        }
      }
    }
  }
}

module.exports = { capture, bindCall, checkDecorators, targetContract, allowsTarget, allowsMultiple, callArguments };
