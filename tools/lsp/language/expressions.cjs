'use strict';

const { values, generics, stringValue, resultConstants } = require('./syntax.cjs');
const { isFlags, codeEntries } = require('./decodes.cjs');
const type = (name, kind = 'value', options = {}) => ({ name, kind, args: [], key: null, params: [], exact: null, dependency: '', ...options });
const unknown = type('?', 'unknown');
const entity = type('Entity', 'reference', { key: '\0\0Entity' });
const term = (type, sort = 'type', options = {}) => ({ type, sort, path: '', ...options });
const base = value => ({ ...value, exact: null });
const stringLike = value => value.kind === 'reference' || ['string', 'snowflake_id', 'code', 'type', 'attrs'].includes(value.name);
const canonical = value => [value.name, value.kind, value.args.map(canonical), value.key, value.params, value.exact, value.dependency];
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function accepts(expected, actual, symbols) {
  if ([expected.kind, actual.kind].includes('unknown')) return true;
  if (expected.exact !== null) return equal(expected, actual);
  if (equal(expected, base(actual))) return true;
  if (expected.name === 'string' && !expected.params.length && stringLike(actual)) return true;
  if (expected.kind === 'reference' && actual.kind === 'reference') return equal(expected, entity) || (symbols.get(actual.key)?.ancestors || []).some(a => a.key === expected.key);
  if (expected.name === 'type' && actual.name === 'type') return accepts(expected.args[0], actual.args[0], symbols);
  return false;
}

function commonType(types, symbols) {
  if (!types.length) return null;
  if (types.every(item => equal(item, types[0]))) return types[0];
  let result = base(types[0]);
  for (const original of types.slice(1)) {
    const other = base(original);
    if (equal(result, other)) continue;
    if (result.kind === 'reference' && other.kind === 'reference') {
      const candidates = [result.key, ...(symbols.get(result.key)?.ancestors || []).map(a => a.key)];
      const ancestors = [other.key, ...(symbols.get(other.key)?.ancestors || []).map(a => a.key)];
      const shared = candidates.find(k => ancestors.includes(k));
      result = shared ? type(shared.split('\0').at(-1), 'reference', { key: shared }) : entity;
    } else if (result.name === 'type' && other.name === 'type') {
      const target = commonType([result.args[0], other.args[0]], symbols);
      if (!target) return null;
      result = type('type', 'value', { args: [target] });
    } else if (stringLike(result) && stringLike(other)) result = type('string', 'string');
    else return null;
  }
  return result;
}

class Resolver {
  constructor(doc, issue, symbols, owner, allowExact = false, bindings = new Map(), active = []) {
    Object.assign(this, { doc, report: issue, symbols, owner, allowExact, bindings, active });
  }
  issue(node, message, warning = false) {
    this.report(this.doc, node.token || node.operator, message, warning ? 2 : 1, warning ? 'undefined-decodes' : undefined);
  }
  resolve(node) { return this.asType(this.evaluate(node), node); }
  asType(value, node) {
    if (value.sort === 'type') return value.type;
    if (value.sort === 'value' && value.type.name === 'type') return value.type.exact === null ? { ...value.type.args[0], dependency: value.path } : value.type.args[0];
    this.issue(node, 'type position requires a type or an entity type value'); return unknown;
  }
  valueType(value) {
    if (value.sort === 'type' && value.type.kind === 'reference') return type('type', 'value', { args: [value.type], exact: value.type.key });
    return value.sort === 'value' ? value.type : unknown;
  }
  bind(token, target) { if (target) this.doc.bindings.set(token.start, target); }
  evaluate(node, allowBinding = false) {
    if (node.binding && !allowBinding) this.issue(node, 'as binding is only allowed on a mapping key');
    const { name, args, params } = node;
    if (!node.quoted && Object.hasOwn(resultConstants, name)) {
      this.issue(node, `result constant ${name} cannot be used in model expressions`);
      return term(unknown);
    }
    if ((args || params) && (name === 'self' || node.quoted || node.literal)) this.issue(node, 'a value expression does not accept type arguments');
    let result;
    if (this.bindings.has(name)) {
      result = this.bindings.get(name);
      this.bind(node.token, result.definition);
      if (args || params) this.issue(node, 'a bound parameter does not accept arguments');
    } else if (name === 'self') {
      if (!this.owner?.effective?.size) this.issue(node, 'self requires an instance context; pass alias dependencies as arguments');
      result = term(entity, 'value', { path: 'self' });
    } else if (node.quoted || node.literal) {
      const primitive = node.quoted ? 'string' : ['true', 'false'].includes(name) ? 'bool' : /^-?\d+$/.test(name) ? 'integer' : 'decimal';
      result = term(type(primitive, primitive === 'string' ? 'string' : 'value', { exact: name }), 'value');
    } else if (generics.includes(name)) {
      this.doc.valueTypeTokens.set(node.token.start, node.token);
      result = this.generic(node);
    } else {
      const symbol = this.doc.scope.get(name);
      this.bind(node.token, symbol);
      if (symbol?.kind === 'type_alias') result = this.expand(node, symbol);
      else {
        if (args) this.issue(node, `${name} does not accept generic arguments`);
        if (values.includes(name)) {
          this.doc.valueTypeTokens.set(node.token.start, node.token);
          result = term(type(name, name === 'string' ? 'string' : 'value', { params: this.parameters(node) }));
        } else if (name === 'Entity') { if (params) this.issue(node, 'invalid parameters for Entity'); result = term(entity); }
        else if (symbol && !['decorator', 'constant'].includes(symbol.kind)) {
          if (params) this.issue(node, `invalid parameters for ${name}; do not mix positional and named parameters`);
          result = symbol.kind === 'decodes' ? term(type('Decodes', 'reference', { key: this.doc.scope.get('Decodes').key, exact: symbol.key }), 'value', { path: name, dictionary: symbol }) : term(type(name, symbol.kind === 'entity' ? 'reference' : 'value', { key: symbol.key }));
        } else { this.issue(node, `unknown type: ${name}`); result = term(unknown); }
      }
    }
    for (const access of node.accesses || []) {
      if (!this.doc.accessTerms) this.doc.accessTerms = new Map();
      this.doc.accessTerms.set(access.operator.start, result);
      result = this.access(result, access);
    }
    for (const operation of node.operations || []) result = this.combine(result, this.evaluate(operation.term), operation);
    return result;
  }
  combine(left, right, node) {
    const operator = node.operator.value;
    if (left.sort !== 'value' || right.sort !== 'value' || left.type.name !== 'code' || right.type.name !== 'code' || !equal(base(left.type), base(right.type))) {
      this.issue(node, `${operator} requires codes from the same flags Decodes`); return term(unknown);
    }
    const declaration = this.symbols.get(left.type.args[0].key);
    if (!declaration || !isFlags(declaration)) { this.issue(node, `${operator} requires codes from the same flags Decodes`); return term(unknown); }
    let exact = null;
    if (left.type.exact !== null && right.type.exact !== null) {
      const first = new Set(left.type.exact.split('+').filter(Boolean)), second = right.type.exact.split('+').filter(Boolean);
      for (const code of second) { if (operator === '+') first.add(code); else first.delete(code); }
      exact = [...first].sort().join('+');
    }
    return term({ ...left.type, exact }, 'value', { path: left.path + operator + right.path });
  }
  parameters(node) {
    const { name, params } = node;
    if (!params) return [];
    const expected = name === 'string' ? ['regex'] : ['precision', 'scale'];
    const pairs = params.map((p, i) => [p.key || (name === 'decimal' ? ['precision', 'scale'][Math.min(i, 1)] : 'regex'), p.value]);
    const valid = ['string', 'decimal'].includes(name) && (params.every(p => p.key) || params.every(p => !p.key)) && pairs.length === expected.length && new Set(pairs.map(p => p[0])).size === expected.length && pairs.every(([k, v]) => expected.includes(k) && (name === 'string' ? v.value.startsWith("'") : /^-?\d+$/.test(v.value)));
    if (!valid) this.issue(node, `invalid parameters for ${name}; do not mix positional and named parameters`);
    return pairs.map(([k, v]) => [k, v.value.startsWith("'") ? stringValue(v.value) : BigInt(v.value).toString()]).sort((a, b) => a[0].localeCompare(b[0]));
  }
  expand(node, declaration) {
    if (this.active.includes(declaration.key)) { this.issue(node, 'type dependency cycle'); return term(unknown); }
    if (node.params || (node.args || []).length !== declaration.parameters.length) { this.issue(node, `invalid type arguments for ${node.name}`); return term(unknown); }
    const bindings = new Map();
    const nested = new Resolver(declaration.doc, this.report, this.symbols, null, this.allowExact, bindings, [...this.active, declaration.key]);
    let valid = true;
    declaration.parameters.forEach((formal, i) => {
      const expected = nested.resolve(formal.type), actual = this.evaluate(node.args[i]), supplied = this.valueType(actual);
      if (!accepts(expected, supplied, this.symbols) || supplied.kind === 'unknown') { this.issue(node.args[i], `incompatible argument for ${node.name}.${formal.token.value}`); valid = false; }
      bindings.set(formal.token.value, actual);
    });
    return valid ? nested.evaluate(declaration.type) : term(unknown);
  }
  access(value, access) {
    const operator = access.operator.value, member = access.token.value, path = value.path + operator + member;
    const site = { token: access.operator };
    if (operator === '::') {
      if (value.sort === 'field' && member === 'entity') {
        const owner = value.source?.owner;
        if (owner?.kind !== 'entity') { this.issue(site, 'field description has no owning entity'); return term(unknown); }
        this.bind(access.token, owner);
        return term(type(owner.name.value, 'reference', { key: owner.key }));
      }
      if (value.sort !== 'field' || !['type', 'value'].includes(member)) { this.issue(site, ':: requires a field description and type or value'); return term(unknown); }
      if (member === 'value' && !value.instance) { this.issue(site, 'field value requires an instance origin'); return term(unknown); }
      if (!value.source) return term(type('dependent', 'value', { args: value.type.members || [], dependency: value.path + '::type' }));
      const field = value.source, identity = field.doc.uri + ':' + field.type.token.start;
      if (this.active.includes(identity)) { this.issue(site, 'type dependency cycle'); return term(unknown); }
      const resolved = new Resolver(field.doc, this.report, this.symbols, field.owner, true, new Map(), [...this.active, identity]).resolve(field.type);
      return term(resolved, member === 'type' ? 'type' : 'value', { path });
    }
    if (value.type.name === 'Decodes' && value.type.exact !== null) {
      const dictionary = this.symbols.get(value.type.exact);
      const entry = codeEntries(dictionary).find(e => e.name.value === member);
      if (!entry) this.issue(site, `unknown Decodes code: ${value.path}.${member}`);
      else this.bind(access.token, entry);
      let exact = member;
      if (isFlags(dictionary)) {
        if (member === 'None') exact = '';
        else if (member === 'All') exact = [...new Set(dictionary.entries.map(e => e.code.value))].sort().join('+');
      }
      return term(type('code', 'value', { args: [type(dictionary.name.value, 'value', { key: dictionary.key })], exact }), 'value', { path });
    }
    if (value.type.kind !== 'reference' || value.sort === 'field') { this.issue(site, 'field access requires an entity instance or entity type'); return term(unknown); }
    const source = (value.path === 'self' ? this.owner : this.symbols.get(value.type.key))?.effective?.get(member);
    if (!source) { this.issue(site, `unknown field: ${member}`); return term(unknown); }
    this.bind(access.token, source);
    return term(type('attrs'), 'field', { path, source, instance: value.sort === 'value' });
  }
  generic(node) {
    const { name, args = [], params } = node;
    if (params || (args || []).length !== (['mapping', 'attrs'].includes(name) ? 2 : 1)) { this.issue(node, `invalid type arguments for ${name}`); return term(unknown); }
    if (name === 'code') return term(this.code(node, args[0]));
    if (['alias', 'exact'].includes(name)) {
      const value = this.evaluate(args[0]), resolved = this.valueType(value);
      if (name === 'alias') {
        if (value.sort !== 'value' || !value.path.endsWith('::value') || value.type.kind === 'unknown') this.issue(node, 'alias requires an instance field value');
        return term({ ...resolved, dependency: value.path });
      }
      if (!this.allowExact) this.issue(node, 'exact requires override or overload');
      if (resolved.exact === null) this.issue(node, 'exact requires a constant value');
      return term(resolved);
    }
    if (name === 'type') {
      const target = this.resolve(args[0]);
      if (!['reference', 'unknown'].includes(target.kind)) this.issue(node, 'type requires Entity or a visible entity type');
      return term(type('type', 'value', { args: [target] }));
    }
    if (name === 'attrs') return term(this.attributes(node));
    const first = this.asType(this.evaluate(args[0], name === 'mapping'), args[0]);
    if (name === 'mapping') {
      const bindings = new Map(this.bindings);
      if (args[0].binding) bindings.set(args[0].binding.value, term(first, first.name === 'attrs' ? 'field' : 'value', { path: '$key', definition: { name: args[0].binding, doc: this.doc, kind: 'binding' } }));
      const second = new Resolver(this.doc, this.report, this.symbols, this.owner, this.allowExact, bindings, this.active).resolve(args[1]);
      if (!['reference', 'unknown'].includes(first.kind) && !stringLike(first)) this.issue(node, 'mapping keys must be string-compatible or entity references');
      if (second.kind === 'collection') this.issue(node, 'mapping values cannot be collections');
      return term(type(name, 'collection', { args: [first, second] }));
    }
    if (name === 'collection' && !['reference', 'unknown'].includes(first.kind)) this.issue(node, 'collection requires an entity reference');
    if (name === 'values' && !['value', 'string', 'unknown'].includes(first.kind)) this.issue(node, 'values requires a value type');
    return term(type(name, 'collection', { args: [first] }));
  }
  attributes(node) {
    const category = this.evaluate(node.args[0]), target = this.resolve(node.args[1]);
    const expected = type('code', 'value', { args: [type('AttrCats', 'value', { key: this.doc.scope.get('AttrCats').key })] });
    if (!accepts(expected, this.valueType(category), this.symbols) || category.sort !== 'value') this.issue(node, 'attrs requires an AttrCats code');
    if (!['reference', 'unknown'].includes(target.kind)) this.issue(node, 'attrs requires an entity type value');
    const members = new Map();
    for (const decl of this.symbols.values()) {
      if (target.key !== decl.key && !decl.ancestors?.some(a => a.key === target.key)) continue;
      for (const field of decl.effective?.values() || []) {
        if (field.mode === 'id' || (category.type.exact !== null && !category.type.exact.split('+').includes(field.mode[0].toUpperCase() + field.mode.slice(1)))) continue;
        const identity = field.doc.uri + ':' + field.type.token.start;
        if (this.active.includes(identity)) continue;
        const resolved = new Resolver(field.doc, () => {}, this.symbols, field.owner, true, new Map(), [...this.active, identity]).resolve(field.type);
        if (!['collection', 'unknown'].includes(resolved.kind)) { const name = field.name.value; if (!members.has(name)) members.set(name, []); members.get(name).push(resolved); }
      }
    }
    return type('attrs', 'value', { args: [category.type, target], members: [...members.values()].map(group => commonType(group, this.symbols) || unknown) });
  }
  code(node, argument) {
    if (!argument.args && !argument.params && !(argument.accesses || []).length && !(argument.operations || []).length && !argument.literal && !this.bindings.has(argument.name)) {
      const name = argument.name, symbol = this.doc.scope.get(name);
      if ((symbol && symbol.kind !== 'decodes') || (!symbol && [...values, ...generics, ...Object.keys(resultConstants), 'Entity'].includes(name))) this.issue(node, 'code requires a Decodes instance identifier');
      else if (!symbol) this.issue(argument.quoted ? node : argument, `undefined Decodes: ${name}`, Boolean(argument.quoted));
      this.doc.valueTypeTokens.set(argument.token.start, argument.token); this.bind(argument.token, symbol);
      return type('code', 'value', { args: [type(name, 'value', { key: symbol?.key || [this.doc.repository || '', [this.doc.prefix, this.doc.namespace].filter(Boolean).join('.'), name].join('\0') })] });
    }
    const value = this.evaluate(argument);
    if (value.sort !== 'value' || value.type.name !== 'Decodes') this.issue(node, 'code requires a Decodes instance value');
    if (value.type.name === 'Decodes' && value.type.exact !== null) { const key = value.type.exact; return type('code', 'value', { args: [type(key.split('\0').at(-1), 'value', { key })] }); }
    return type('code', 'value', { args: [value.type], dependency: value.path });
  }
}

function checkAliases(documents, issue, symbols) {
  for (const doc of documents) for (const declaration of doc.declarations.filter(d => d.kind === 'type_alias')) {
    const bindings = new Map(), resolver = new Resolver(doc, issue, symbols, null, true, bindings);
    for (const token of doc.tokens) if (declaration.token.start <= token.start && token.end <= declaration.end && token.value === 'input_type') resolver.issue({ token }, 'input_type is only a decorator pair constraint');
    for (const formal of declaration.parameters) {
      const name = formal.token.value;
      if (bindings.has(name) || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)) resolver.issue(formal, `duplicate or invalid type parameter: ${name}`);
      const constraint = resolver.resolve(formal.type);
      bindings.set(name, term(constraint, 'value', { path: '$' + name, definition: { name: formal.token, doc, kind: 'parameter' } }));
    }
    resolver.resolve(declaration.type);
  }
}

module.exports = { Resolver, type, term, entity, unknown, base, canonical, equal, accepts, commonType, checkAliases };
