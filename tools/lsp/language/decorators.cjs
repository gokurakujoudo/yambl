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
  const seen = new Set(); let pairSeen = false, optionalSeen = false;
  const resolver = new Resolver(declaration.doc, issue, symbols, null);
  for (const formal of declaration.parameters) {
    const name = formal.name.value;
    declaration.doc.bindings.set(formal.name.start, formal);
    if (!snake(name)) resolver.issue(formal, 'decorator parameter names must use snake_case');
    if (seen.has(name)) resolver.issue(formal, `duplicate decorator parameter: ${name}`);
    seen.add(name);
    if ((pairSeen && !formal.pair) || (optionalSeen && !formal.optional)) resolver.issue(formal, 'ordinary parameters precede pairs; optional pairs come last');
    if ((formal.optional && !formal.pair) || (formal.pair && formal.default)) resolver.issue(formal, 'only pairs use ?; only ordinary parameters use defaults');
    pairSeen ||= formal.pair; optionalSeen ||= formal.optional;
    if (!hasSelf(formal.type)) {
      const expected = resolver.resolve(formal.type);
      if (expected.kind === 'collection') resolver.issue(formal.type, 'decorator parameters cannot be collections');
      if (formal.default && !hasSelf(formal.default)) argumentType(resolver, formal.default, expected);
    }
  }
}

function bindCall(call, node, issue, symbols) {
  const doc = node.doc, name = call.name;
  const actualResolver = new Resolver(doc, issue, symbols, null, false, new Map([['self', capture(node, symbols)]]));
  const declaration = doc.scope.get(name);
  if (declaration?.kind !== 'decorator') { actualResolver.issue(call, `unknown decorator: ${name}`); return ''; }
  doc.bindings.set(call.markerToken.start, declaration);
  const formalResolver = new Resolver(declaration.doc, issue, symbols, null, false, actualResolver.bindings);
  const ordinary = declaration.parameters.filter(p => !p.pair), pairs = declaration.parameters.filter(p => p.pair);
  const supplied = new Map(), keys = new Set();
  let position = 0, pairPosition = 0, keywordSeen = false, pairSeen = false;
  for (const argument of call.arguments) {
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
  const bound = [];
  for (const formal of declaration.parameters) {
    const expected = formalResolver.resolve(formal.type), name = formal.name.value;
    if (expected.kind === 'collection') formalResolver.issue(formal.type, 'decorator parameters cannot be collections');
    const argument = supplied.get(name);
    if (!argument) {
      if (formal.default) bound.push([name, '', canonical(argumentType(formalResolver, formal.default, expected))]);
      else if (!formal.optional) actualResolver.issue(call, `missing decorator argument: ${name}`);
      continue;
    }
    if (formal.pair) {
      const actual = actualResolver.resolve(argument.type);
      if (actual.kind === 'collection' || !accepts(expected, actual, symbols)) actualResolver.issue(argument.type, 'incompatible decorator pair type');
      bound.push([name, argument.key.value, canonical(actual)]);
    } else {
      bound.push([name, '', canonical(argumentType(actualResolver, argument.type, expected))]);
      if (['title', 'description'].includes(call.name) && argument.type.quoted) call.value = argument.type.token;
    }
  }
  return JSON.stringify([declaration.key, bound]);
}

function checkDecorators(documents, issue, symbols) {
  for (const doc of documents.filter(d => !d.errors.length)) for (const declaration of doc.declarations) {
    if (declaration.kind === 'decorator') checkParameters(declaration, issue, symbols);
    for (const node of [declaration, ...declaration.fields]) {
      const seen = new Set(), dimensions = new Set();
      for (const call of node.metadata) {
        const name = call.name;
        bindCall(call, node, issue, symbols);
        const definition = doc.scope.get(name);
        if (definition?.kind === 'decorator' && seen.has(name) && (name === 'allow_multiple' || !definition.metadata.some(a => a.name === 'allow_multiple'))) issue(doc, call.token, `duplicate decorator: ${name}`);
        seen.add(name);
        let message = '';
        if (name === 'allow_multiple' && node.kind !== 'decorator') message = 'allow_multiple requires a decorator declaration';
        else if (name === 'flags' && node.kind !== 'decodes') message = 'flags requires a Decodes declaration';
        else if (['override', 'overload'].includes(name) && (node.kind || node.mode === 'id' || declaration.kind === 'value')) message = 'field markers require an entity attr';
        else if (name === 'temporal' && !['snapshot', 'scd'].includes(node.mode)) message = 'temporal requires snapshot or scd attr';
        else if (name === 'dimension' && (!['attr', 'snapshot', 'scd'].includes(node.mode) || declaration.kind === 'value')) message = 'dimension requires attr, snapshot or scd';
        if (message) issue(doc, call.token, message);
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

module.exports = { capture, bindCall, checkDecorators };
