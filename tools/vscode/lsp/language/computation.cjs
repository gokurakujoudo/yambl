'use strict';

const { Resolver, type, accepts, equal, base, canonical, commonType, unknown } = require('./expressions.cjs');
const { resolveDimension } = require('./dimensions.cjs');
const { isFlags } = require('./decodes.cjs');
const { resultConstants } = require('./syntax.cjs');
const numbers = ['integer', 'decimal', 'float'];
const conversions = require('./conversions.cjs');
const constants = require('./constant-evaluation.cjs');
const snake = name => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name);
function lookupSupported(resolved, symbols) {
  const dictionary = resolved.name === 'code' && symbols.get(resolved.args[0]?.key);
  return resolved.kind === 'unknown' || (!resolved.dependency && (resolved.kind === 'reference' || (resolved.name === 'code' ? !dictionary || !require('./decodes.cjs').isFlags(dictionary) : !resolved.key && ['string', 'bool', 'integer', 'snowflake_id', 'decimal', 'date', 'datetime'].includes(resolved.name))));
}

function checkComputations(documents, symbols, report) {
  const completed = new Map(), active = new Set();
  const constantTypes = new Map(), constantActive = new Set(), constantValues = new Map();
  const finiteTypes = new WeakMap(), finiteActive = new WeakSet();
  function pure(doc, issue, expression, keyPosition = false) {
    if (expression.kind === 'descriptor' && expression.value === 'subtypes' && expression.operands[0].kind === 'name' && doc.scope.get(expression.operands[0].value)?.kind === 'entity') return;
    if (expression.kind === 'name' && !keyPosition) {
      const symbol = doc.scope.get(expression.value);
      if (!(expression.value in conversions.signatures) && !['constant', 'decodes'].includes(symbol?.kind)) issue(expression, `not a pure constant dependency: ${expression.value}`);
    }
    if (['descriptor', 'recover', 'lambda'].includes(expression.kind) || (expression.kind === 'call' && expression.operands[0].kind !== 'name')) issue(expression, 'constant expressions cannot read fields, inputs or non-normal results');
    expression.operands.forEach((child, i) => pure(doc, issue, child, expression.kind === 'object' && expression.inferred?.type?.key && i % 2 === 0));
    expression.arguments.forEach(a => pure(doc, issue, a.expression));
  }
  function resolveConstant(doc, name) {
    const [root, code] = name.split('.'), target = doc.scope.get(root.replace(/::subtypes$/, ''));
    if (root.endsWith('::subtypes') && target?.kind === 'entity' && code !== undefined && target.subtypes.entries.some(e => e.code.value === code)) return code;
    if (target?.kind === 'constant') { constant(target); if (constantValues.has(target)) { const value = constantValues.get(target); if (code === undefined) return value; if (value instanceof Map && value.has(code)) return value.get(code); } }
    if (target?.kind === 'decodes' && code !== undefined) return code;
    throw Error(`not a pure constant dependency: ${name}`);
  }
  function constant(declaration) {
    if (constantTypes.has(declaration)) return constantTypes.get(declaration);
    const node = declaration.initializer, issue = (node, message) => report(declaration.doc, node.token, message);
    if (constantActive.has(declaration)) { issue(node, `constant dependency cycle: ${declaration.name.value}`); return unknown; }
    constantActive.add(declaration);
    const checker = new Checker(declaration.doc, declaration, issue);
    const expected = new Resolver(declaration.doc, report, symbols, declaration, true).resolve(declaration.type);
    const before = declaration.doc.diagnostics.length;
    const actual = checker.infer(node, new Map(), expected).type;
    pure(declaration.doc, issue, node);
    if (!compatible(expected, actual)) issue(node, `incompatible constant result: expected ${expected.name}, got ${actual.name}`);
    if (declaration.doc.diagnostics.length === before) {
      try {
        const payload = constants.evaluate(node, name => resolveConstant(declaration.doc, name));
        if (expected.name === 'decimal' && expected.params?.length) {
          const params = Object.fromEntries(expected.params), text = payload.text(), [whole, fraction = ''] = text.replace(/^-/, '').split('.');
          if (fraction.length > Number(params.scale) || (whole === '0' ? 0 : whole.length) > Number(params.precision) - Number(params.scale)) throw Error('decimal exceeds declared precision or scale');
        }
        constantValues.set(declaration, payload);
      } catch (error) { issue(node, `constant evaluation failed: ${error.message}`); }
    }
    constantActive.delete(declaration); constantTypes.set(declaration, expected);
    return expected;
  }
  function parameterDeclaration(doc, token, resolvedType) {
    let declaration = doc.bindings.get(token.start);
    if (!declaration) {
      declaration = { kind: 'calculation_binding', name: token, doc, resolvedType };
      doc.bindings.set(token.start, declaration);
    }
    return declaration;
  }
  function compatible(expected, actual) {
    if (expected.allowed?.length || expected.exact !== null) return accepts(expected, actual, symbols);
    if (numbers.includes(expected.name) && numbers.includes(actual.name)) return numbers.indexOf(actual.name) <= numbers.indexOf(expected.name);
    if (expected.name === actual.name && expected.args.length && expected.args.length === actual.args.length) return expected.args.every((t, i) => compatible(t, actual.args[i]));
    return accepts(expected, actual, symbols);
  }
  function scopedSemantic(node, doc) {
    if (!node) return null;
    const declaration = node.kind === 'name' && doc.scope.get(node.value);
    const value = declaration && ['constant', 'decodes', 'hierarchy'].includes(declaration.kind) ? declaration.key : node.value;
    return [node.kind, value, node.operands.map(child => scopedSemantic(child, doc)), node.arguments.map(a => [a.name, scopedSemantic(a.expression, doc)]), node.cases.map(c => [c.statuses, c.binding, scopedSemantic(c.expression, doc)])];
  }
  function declareInputs(checker, node, issue) {
    for (const call of node.metadata.filter(c => c.name === 'extra_input_param')) {
      const values = new Map(); require('./decorators.cjs').bindCall(call, node, () => {}, symbols, values);
      const pair = call.arguments.find(a => a.mode === 'pair'), constraint = values.get('parameter');
      if (!pair || !constraint) continue;
      const name = pair.key.value, defaultType = values.get('parameter_default');
      if (checker.declared.has(name)) issue({ token: pair.key }, `duplicate extra input parameter: ${name}`);
      const defaultValue = defaultType?.exact == null ? null : { kind: ['integer', 'snowflake_id'].includes(constraint.name) ? 'integer' : ['decimal', 'float'].includes(constraint.name) ? 'decimal' : constraint.name === 'bool' ? 'bool' : 'string', value: defaultType.exact, token: pair.default.token, end: pair.default.token.end, operands: [], arguments: [], cases: [] };
      const parameter = { name, type: constraint, required: false, default: defaultValue, defaultDoc: node.doc, sites: [pair.key], description: values.get('description')?.exact || '' };
      checker.addInput(parameter, { token: pair.key }); checker.declared.set(name, parameter);
      const declaration = { kind: 'calculation_binding', name: pair.key, doc: node.doc, resolvedType: constraint };
      node.doc.bindings.set(pair.key.start, declaration); parameter.declaration = declaration;
    }
  }
  function analyze(field) {
    if (completed.has(field)) return completed.get(field);
    const issue = (node, message) => report(field.doc, node.token, message);
    if (active.has(field)) { issue(field.calculation?.result || { token: field.token }, `computed field dependency cycle: ${field.name.value}`); return { inputs: new Map() }; }
    active.add(field);
    if (field.abstract) {
      const implementations = [...symbols.values()].filter(d => d.kind === 'entity' && d.ancestors?.includes(field.owner)).flatMap(d => [...d.ownFields.values()]).filter(f => f.identity === field.identity && f.calculation);
      const contracts = implementations.map(analyze);
      const contract = contracts[0] || { inputs: new Map() };
      active.delete(field); completed.set(field, contract);
      field.inferredInputs = [...contract.inputs.values()].sort((a, b) => a.name.localeCompare(b.name));
      return contract;
    }
    const checker = new Checker(field.doc, field.owner, issue);
    declareInputs(checker, field, issue);
    const environment = new Map([['self', { type: type(field.owner.name.value, 'reference', { key: field.owner.key }) }]]);
    for (const binding of field.calculation.bindings) {
      if (!snake(binding.name) || environment.has(binding.name) || binding.name === 'input') issue(binding.expression, `duplicate or invalid local binding: ${binding.name}`);
      const constraint = binding.annotation ? new Resolver(field.doc, report, symbols, field.owner, true).resolve(binding.annotation) : null;
      const value = checker.read(checker.infer(binding.expression, environment, constraint), binding.expression);
      if (constraint && !compatible(constraint, value.type)) issue(binding.expression, `incompatible local binding: expected ${constraint.name}, got ${value.type.name}`);
      if (constraint) value.type = constraint;
      const declaration = { kind: 'calculation_binding', name: binding.token, doc: field.doc, resolvedType: value.type };
      field.doc.bindings.set(binding.token.start, declaration);
      environment.set(binding.name, { ...value, declaration });
    }
    const expected = new Resolver(field.doc, report, symbols, field.owner, true).resolve(field.type);
    const actual = checker.read(checker.infer(field.calculation.result, environment, expected), field.calculation.result).type;
    if (!compatible(expected, actual)) issue(field.calculation.result, `incompatible computed result: expected ${expected.name}, got ${actual.name}`);
    const locals = new Map();
    const expand = node => node.kind === 'name' && locals.has(node.value) ? locals.get(node.value) : { ...node, operands: node.operands.map(expand), arguments: node.arguments.map(a => ({ ...a, expression: expand(a.expression) })), cases: node.cases.map(c => ({ ...c, expression: expand(c.expression) })) };
    for (const binding of field.calculation.bindings) locals.set(binding.name, expand(binding.expression));
    for (const [name, p] of checker.inputs) if (p.default) checker.inputs.set(name, { ...p, default: expand(p.default) });
    checker.checkDefaults();
    active.delete(field); completed.set(field, checker); field.inferredInputs = [...checker.inputs.values()].sort((a, b) => a.name.localeCompare(b.name));
    return checker;
  }
  class Checker {
    constructor(doc, owner, issue) { Object.assign(this, { doc, owner, issue, inputs: new Map(), declared: new Map(), dependencies: new Set() }); }
    addInput(parameter, node) {
      const name = parameter.name;
      if (!snake(name) || ['self', 'input', 'best_effort'].includes(name)) this.issue(node, `invalid or reserved calculation parameter: ${name}`);
      const prior = this.inputs.get(name);
      const declared = this.declared.get(name);
      if (declared) parameter = { ...parameter, required: false, default: declared.default || parameter.default, defaultDoc: declared.default ? declared.defaultDoc : parameter.defaultDoc, defaultDimension: declared.default ? null : parameter.defaultDimension };
      if (prior) {
        if (!equal(prior.type, parameter.type) || (prior.default && parameter.default && JSON.stringify(scopedSemantic(prior.default, prior.defaultDoc || this.doc)) !== JSON.stringify(scopedSemantic(parameter.default, parameter.defaultDoc || this.doc)))) this.issue(node, `conflicting inferred parameter: ${name}`);
        parameter = { ...prior, required: prior.required || parameter.required, default: prior.default || parameter.default, defaultDoc: prior.default ? prior.defaultDoc : parameter.defaultDoc, defaultDimension: prior.default ? prior.defaultDimension : parameter.defaultDimension, sites: [...prior.sites, ...parameter.sites] };
      }
      this.inputs.set(name, parameter);
    }
    bindInput(parameter, expression, environment) {
      let alias = expression, fallback = null;
      if (expression.kind === 'binary' && expression.value === '??') [alias, fallback] = expression.operands;
      if (alias.kind === 'member' && alias.operands[0].kind === 'name' && alias.operands[0].value === 'input') {
        const declaration = this.declared.get(alias.value)?.declaration;
        if (declaration) this.doc.bindings.set(alias.memberToken.start, declaration);
        this.addInput({ ...parameter, name: alias.value, default: fallback || parameter.default, defaultDoc: fallback ? this.doc : parameter.defaultDoc, defaultDimension: fallback ? null : parameter.defaultDimension, sites: [expression.token] }, expression);
        if (fallback) {
          const saved = new Map(this.inputs);
          this.bindInput({ ...parameter, default: null, required: true }, fallback, environment);
          if (this.declared.get(alias.value)?.default) this.inputs = saved;
        }
        return;
      }
      const actual = this.read(this.infer(expression, environment), expression).type;
      if (parameter.type.kind === 'reference' && actual.name === 'string') return;
      if (!compatible(parameter.type, actual)) this.issue(expression, `incompatible binding for parameter: ${parameter.name}`);
    }
    checkDefaults() {
      const references = node => node.kind === 'member' && node.operands[0].kind === 'name' && node.operands[0].value === 'input' ? [node.value] : [...node.operands.flatMap(references), ...node.arguments.flatMap(a => references(a.expression))];
      const edges = new Map([...this.inputs].map(([name, p]) => [name, p.default ? references(p.default) : []]));
      for (const [name, parameter] of this.inputs) {
        const pending = [...edges.get(name)], seen = new Set();
        while (pending.length) {
          const dependency = pending.pop();
          if (dependency === name) { if (parameter.default) this.issue(parameter.default, `calculation parameter default cycle: ${name}`); break; }
          if (!seen.has(dependency)) { seen.add(dependency); pending.push(...(edges.get(dependency) || [])); }
        }
      }
    }
    parameters(value, operation, node) {
      const field = value.field;
      if (operation === 'at') { this.issue(node, '::at(...) was removed; use ::value(...) instead'); operation = 'value'; }
      if (field.mode === 'computed') {
        if (operation !== 'value') this.issue(node, 'computed fields support ::value, not stored-field operations');
        this.dependencies.add(field);
        return [...analyze(field).inputs.values()];
      }
      if (!['value', 'best_available'].includes(operation)) this.issue(node, 'stored fields support ::value or ::best_available');
      const result = [];
      for (const call of field.metadata) {
        if (call.name === 'temporal') for (const pair of call.dimensions) result.push({ name: pair.token.value, type: type('date'), required: true, default: null, sites: [node.token], declaration: parameterDeclaration(field.doc, pair.token, type('date')) });
        if (call.name === 'dimension') {
          const dimension = call.dimension || resolveDimension(field.owner, call.arguments[0]?.type.name);
          if (!dimension) continue;
          const best = operation === 'best_available' && Boolean(dimension.hierarchy);
          const valueType = new Resolver(dimension.doc, report, symbols, dimension.owner).resolve(dimension.type);
          result.push({ name: dimension.value.value, type: valueType, required: !best, default: null, sites: [node.token], declaration: parameterDeclaration(dimension.doc, dimension.value, valueType) });
          if (best) {
            const hierarchyType = type('Hierarchy', 'reference', { key: dimension.doc.scope.get('Hierarchy').key });
            result.push({ name: dimension.hierarchy.value, type: hierarchyType, required: false, default: dimension.default || null, defaultDoc: dimension.doc, defaultDimension: dimension.default ? dimension : null, sites: [node.token], declaration: parameterDeclaration(dimension.doc, dimension.hierarchy, hierarchyType) });
          }
        }
      }
      if (['snapshot', 'scd'].includes(field.mode) && !field.metadata.some(c => c.name === 'temporal')) result.unshift({ name: 'as_of_date', type: type('date'), required: true, default: null, sites: [node.token] });
      return result;
    }
    read(value, node, navigation = false) {
      if (value.field) {
        if (!(navigation && value.type.kind === 'reference')) this.issue(node, 'field retrieval requires ::value(...) or ::best_available(...)');
        for (const parameter of this.parameters(value, 'value', node)) this.addInput(parameter, node);
      }
      return { type: value.type };
    }
    infer(node, environment, expected = null) {
      const value = this.inferNode(node, environment, expected);
      node.inferred = value;
      node.environment = new Map(environment);
      return value;
    }
    inferNode(node, environment, expected) {
      if (['sequence', 'object'].includes(node.kind)) return this.literal(node, environment, expected);
      if (expected && ['string', 'integer', 'decimal'].includes(node.kind) && (['date', 'datetime', 'code'].includes(expected.name) || expected.kind === 'reference' || (numbers.includes(expected.name) && numbers.includes(node.kind) && compatible(expected, type(node.kind))))) {
        if (['date', 'datetime'].includes(expected.name)) { try { constants.conversion('parse_' + expected.name, [node.value]); } catch (error) { this.issue(node, error.message); } }
        if (expected.name === 'code') {
          const dictionary = symbols.get(expected.args[0]?.key);
          if (dictionary && !require('./decodes.cjs').codeEntries(dictionary).some(e => e.name.value === node.value)) this.issue(node, `unknown Decodes code: ${expected.args[0].name}.${node.value}`);
        }
        if (expected.kind === 'reference') {
          const entity = symbols.get(expected.key), ids = [...(entity?.effective?.values() || [])].filter(f => f.mode === 'id');
          if (ids.length !== 1) this.issue(node, 'reference literal requires one identifiable ID field');
          else { const field = ids[0], idType = new Resolver(field.doc, report, symbols, field.owner, true).resolve(field.type); if (!compatible(idType, type(node.kind, node.kind === 'string' ? 'string' : 'value', { exact: node.value }))) this.issue(node, 'incompatible reference literal ID type'); }
        }
        return { type: expected };
      }
      if (['string', 'integer', 'decimal', 'bool'].includes(node.kind)) return { type: type(node.kind, node.kind === 'string' ? 'string' : 'value', { exact: node.value }) };
      if (node.kind === 'name') {
        if (environment.has(node.value)) {
          const value = environment.get(node.value);
          if (value.declaration) this.doc.bindings.set(node.token.start, value.declaration);
          return value;
        }
        const declaration = this.doc.scope.get(node.value);
        if (declaration?.kind === 'constant') { this.doc.bindings.set(node.token.start, declaration); return { type: constant(declaration), declaration }; }
        if (declaration?.kind === 'hierarchy' || declaration?.kind === 'decodes') {
          this.doc.bindings.set(node.token.start, declaration);
          const name = declaration.kind === 'hierarchy' ? 'Hierarchy' : 'Decodes';
          return { type: type(name, 'reference', { key: this.doc.scope.get(name).key, exact: declaration.key }), declaration };
        }
        if (node.value in resultConstants && node.value !== 'PARTIAL') return { type: unknown };
        this.issue(node, `unknown calculation name: ${node.value}`); return { type: unknown };
      }
      if (node.kind === 'member') {
        const receiver = node.operands[0];
        if (receiver.kind === 'descriptor' && receiver.value === 'subtypes' && receiver.operands[0].kind === 'name') {
          const root = receiver.operands[0], syntax = { token: root.token, name: root.value, accesses: [{ operator: { value: '::', start: receiver.token.end }, token: receiver.memberToken }, { operator: { value: '.', start: node.memberToken.start - 1 }, token: node.memberToken }] };
          return { type: new Resolver(this.doc, report, symbols, this.owner).evaluate(syntax).type };
        }
        const symbol = receiver.kind === 'name' && this.doc.scope.get(receiver.value);
        if (receiver.kind === 'name' && receiver.value === 'input' && this.inputs.has(node.value)) {
          const parameter = this.inputs.get(node.value);
          if (parameter.declaration) this.doc.bindings.set(node.memberToken.start, parameter.declaration);
          return { type: parameter.type };
        }
        if (symbol?.kind === 'decodes') {
          const syntax = { token: receiver.token, name: receiver.value, accesses: [{ operator: { value: '.' }, token: node.memberToken }] };
          return { type: new Resolver(this.doc, report, symbols, this.owner).evaluate(syntax).type };
        }
        const parent = this.read(this.infer(receiver, environment), receiver, true);
        if (parent.type.kind === 'value') {
          const owner = symbols.get(parent.type.key), field = owner?.kind === 'value' && owner.fields.find(f => f.name.value === node.value);
          if (field) { this.doc.bindings.set(node.memberToken.start, field); return { type: new Resolver(field.doc, report, symbols, owner, true).resolve(field.type) }; }
        }
        if (parent.type.name === 'partial' && ['value', 'issues'].includes(node.value)) return { type: node.value === 'value' ? parent.type.args[0] : type('issues', 'collection') };
        if (parent.type.kind !== 'reference') { this.issue(node, 'member access requires a scalar entity reference'); return { type: unknown }; }
        const entity = symbols.get(parent.type.key);
        let field = entity?.effective?.get(node.value);
        if (!field && entity) {
          let root = entity; while (root.base) root = root.base;
          for (const candidate of symbols.values()) {
            let ancestor = candidate; const seen = new Set();
            while (ancestor?.base && !seen.has(ancestor)) { seen.add(ancestor); ancestor = ancestor.base; }
            if (ancestor === root && candidate.effective?.has(node.value)) { field = candidate.effective.get(node.value); break; }
          }
        }
        if (!field) { this.issue(node, `unknown entity field: ${node.value}`); return { type: unknown }; }
        this.doc.bindings.set(node.memberToken.start, field);
        return { type: new Resolver(field.doc, report, symbols, field.owner, true).resolve(field.type), field };
      }
      if (['call', 'recover'].includes(node.kind)) return this.invoke(node, environment, expected);
      if (['binary', 'unary'].includes(node.kind)) {
        if (node.value === '??') {
          const left = node.operands[0];
          if (left.kind === 'member' && left.operands[0].kind === 'name' && left.operands[0].value === 'input' && this.inputs.has(left.value)) {
            const parameter = this.inputs.get(left.value);
            this.bindInput(parameter, node, environment); return { type: parameter.type };
          }
          this.issue(node, '?? requires an input.name with an inferred or declared type'); return { type: unknown };
        }
        const operands = node.operands.map(e => this.read(this.infer(e, environment), e).type);
        if (['and', 'or', 'not'].includes(node.value)) {
          if (operands.some(t => t.name !== 'bool' && t.kind !== 'unknown')) this.issue(node, 'boolean operators require bool operands');
          return { type: type('bool') };
        }
        if (['==', '!=', '<', '<=', '>', '>='].includes(node.value)) {
          if (!['==', '!='].includes(node.value) && operands.some(t => ![...numbers, 'string', 'date', 'datetime'].includes(t.name) && t.kind !== 'unknown')) this.issue(node, 'ordered comparison requires numbers, strings, dates or datetimes');
          if (!compatible(base(operands[0]), operands[1]) && !compatible(base(operands[1]), operands[0])) this.issue(node, 'comparison requires compatible operand types');
          return { type: type('bool') };
        }
        if (operands.some(t => !numbers.includes(t.name) && t.kind !== 'unknown')) { this.issue(node, 'arithmetic requires integer, decimal or float operands'); return { type: unknown }; }
        return { type: type(node.value === '/' ? 'float' : node.value === '//' ? 'integer' : numbers[Math.max(0, ...operands.map(t => numbers.indexOf(t.name)))]) };
      }
      if (node.kind === 'conditional') {
        const condition = this.read(this.infer(node.operands[0], environment), node.operands[0]);
        if (condition.type.name !== 'bool' && condition.type.kind !== 'unknown') this.issue(node, 'if condition requires bool');
        const [left, right] = node.operands.slice(1).map(e => this.read(this.infer(e, environment, expected), e).type);
        if (compatible(base(left), right)) return { type: base(left) };
        if (compatible(base(right), left)) return { type: base(right) };
        this.issue(node, 'if branches require compatible result types'); return { type: unknown };
      }
      this.issue(node, 'expression is only valid in its binding or method context'); return { type: unknown };
    }
    literal(node, environment, expected) {
      if (node.kind === 'sequence') {
        if (expected && !['collection', 'values', 'sequence'].includes(expected.name)) { this.issue(node, 'sequence literal requires collection or values context'); return { type: unknown }; }
        let element = expected?.args[0];
        for (const operand of node.operands) {
          const actual = this.read(this.infer(operand, environment, element), operand).type;
          if (!element) element = base(actual);
          else if (!compatible(element, actual)) { if (!expected && compatible(base(actual), element)) element = base(actual); else this.issue(operand, 'incompatible sequence literal element'); }
        }
        if (!element) { this.issue(node, 'empty literal requires a contextual type'); return { type: unknown }; }
        if (element.kind === 'collection') this.issue(node, 'sequence literals cannot contain collection values');
        return { type: expected || type(element.kind === 'reference' ? 'collection' : 'values', 'collection', { args: [element] }) };
      }
      const declaration = expected?.key && symbols.get(expected.key);
      if (declaration?.kind === 'value') {
        const fields = new Map(declaration.fields.map(f => [f.name.value, f])), supplied = new Set();
        for (let i = 0; i < node.operands.length; i += 2) {
          const key = node.operands[i], value = node.operands[i + 1], field = fields.get(key.value);
          if (!['name', 'string'].includes(key.kind) || !field || supplied.has(key.value)) { this.issue(key, `unknown or duplicate value field: ${key.value}`); continue; }
          supplied.add(key.value); this.doc.bindings.set(key.token.start, field);
          const constraint = new Resolver(field.doc, report, symbols, declaration, true).resolve(field.type);
          const actual = this.read(this.infer(value, environment, constraint), value).type;
          if (!compatible(constraint, actual)) this.issue(value, `incompatible value field: ${key.value}`);
        }
        for (const name of fields.keys()) if (!supplied.has(name)) this.issue(node, `missing value field: ${name}`);
        return { type: expected };
      }
      if (expected && expected.name !== 'mapping') { this.issue(node, 'object literal requires mapping or structured value context'); return { type: unknown }; }
      let keyType = expected?.args[0], valueType = expected?.args[1];
      for (let i = 0; i < node.operands.length; i += 2) {
        for (const [offset, constraint] of [[0, keyType], [1, valueType]]) {
          const operand = node.operands[i + offset], actual = this.read(this.infer(operand, environment, constraint), operand).type;
          if (constraint && !compatible(constraint, actual)) this.issue(operand, 'incompatible mapping literal entry');
          if (offset === 0 && !keyType) keyType = base(actual);
          if (offset === 1 && !valueType) valueType = base(actual);
        }
      }
      if (!keyType || !valueType) { this.issue(node, 'empty literal requires a contextual type'); return { type: unknown }; }
      if (!(keyType.kind === 'reference' || ['string', 'snowflake_id', 'code', 'type', 'attrs'].includes(keyType.name)) || valueType.kind === 'collection') this.issue(node, 'mapping requires string-compatible or reference keys and non-collection values');
      const literalKeys = node.operands.filter((n, i) => i % 2 === 0 && ['string', 'integer', 'decimal', 'bool'].includes(n.kind)).map(n => n.kind + ':' + n.value);
      if (literalKeys.length !== new Set(literalKeys).size) this.issue(node, 'duplicate mapping literal key');
      return { type: expected || type('mapping', 'collection', { args: [keyType, valueType] }) };
    }
    invoke(node, environment, expected) {
      const selected = node.operands[0], receiver = selected.operands[0], method = selected.value;
      if (selected.kind === 'name') {
        const signature = conversions.signatures[method];
        if (!signature) { this.issue(node, `unknown calculation builtin: ${method}`); return { type: unknown }; }
        const supplied = new Set(); let named = false;
        node.parameters = signature.map(([name, expected]) => ({ name, type: type(expected), required: true }));
        for (const [index, argument] of node.arguments.entries()) {
          const name = argument.name || signature[index]?.[0] || '', expected = signature.find(p => p[0] === name)?.[1];
          if ((!argument.name && named) || supplied.has(name) || !expected) { this.issue(argument.expression, `invalid, duplicate or out-of-order builtin argument: ${name}`); continue; }
          named ||= Boolean(argument.name); supplied.add(name);
          const actual = this.read(this.infer(argument.expression, environment), argument.expression).type;
          const allowed = expected === 'scalar' ? actual.kind === 'reference' || [...numbers, 'string', 'code', 'snowflake_id', 'type', 'attrs', 'bool', 'date', 'datetime'].includes(actual.name) : expected === 'number_or_string' ? [...numbers, 'string'].includes(actual.name) : expected === 'number' ? numbers.includes(actual.name) : actual.name === expected;
          if (!allowed && actual.kind !== 'unknown') this.issue(argument.expression, `${method}.${name} requires ${expected}`);
        }
        for (const [name] of signature) if (!supplied.has(name)) this.issue(node, `missing builtin argument: ${name}`);
        return { type: type(conversions.returns[method], conversions.returns[method] === 'string' ? 'string' : 'value') };
      }
      if (!receiver) { this.issue(node, 'expression is only valid in its binding or method context'); return { type: unknown }; }
      if (selected.kind === 'descriptor') {
        const value = this.infer(receiver, environment);
        if (method === 'hierarchy') {
          this.read(value, receiver);
          const dictionary = value.declaration?.kind === 'decodes' && value.declaration;
          if (node.arguments.length) this.issue(node, '::hierarchy() does not accept arguments');
          if (value.type.name !== 'Decodes') this.issue(node, '::hierarchy() requires a Decodes reference');
          if (dictionary && require('./decodes.cjs').isFlags(dictionary)) this.issue(node, 'flags Decodes cannot be converted to Hierarchy');
          return { type: type('Hierarchy', 'reference', { key: this.doc.scope.get('Hierarchy').key }) };
        }
        if (!value.field) { this.issue(node, 'field operation requires a field descriptor'); return { type: unknown }; }
        const explicit = new Map(node.arguments.map(a => [a.name, a.expression]));
        const substitute = expression => expression.kind === 'member' && expression.operands[0].kind === 'name' && expression.operands[0].value === 'input' ? explicit.get(expression.value) || expression : { ...expression, operands: expression.operands.map(substitute), arguments: expression.arguments.map(a => ({ ...a, expression: substitute(a.expression) })) };
        const parameters = this.parameters(value, method, node).map(p => p.default ? { ...p, default: substitute(p.default) } : p), requirements = new Map(parameters.map(p => [p.name, p])), supplied = new Set();
        node.parameters = parameters;
        for (const argument of node.arguments) {
          if (!requirements.has(argument.name) || supplied.has(argument.name)) { this.issue(argument.expression, `unknown or duplicate field argument: ${argument.name}`); continue; }
          if (requirements.get(argument.name).declaration) this.doc.bindings.set(argument.token.start, requirements.get(argument.name).declaration);
          supplied.add(argument.name); this.bindInput(requirements.get(argument.name), argument.expression, environment);
        }
        for (const parameter of parameters) if (!supplied.has(parameter.name)) this.addInput(parameter, node);
        if (method === 'best_available' && value.field.metadata.filter(a => a.name === 'dimension' && a.dimension?.hierarchy && !supplied.has(a.dimension.value.value)).length > 1) this.issue(node, 'best_available supports one automatic Hierarchy; bind the other dimension values');
        if (method === 'best_available') for (const call of value.field.metadata.filter(a => a.name === 'dimension')) {
          const dimension = call.dimension;
          if (!dimension?.default || !dimension.hierarchy || supplied.has(dimension.value.value)) continue;
          const selection = explicit.get(dimension.hierarchy.value);
          const selectedName = !selection ? dimension.hierarchy.value : selection.kind === 'member' && selection.operands[0].kind === 'name' && selection.operands[0].value === 'input' ? selection.value : null;
          if (!selectedName || this.inputs.get(selectedName)?.defaultDimension !== dimension) continue;
          const owner = value.field.owner;
          const checker = new Checker(dimension.doc, owner, (item, message) => report(dimension.doc, item.token, message));
          const defaultEnvironment = new Map([['self', { type: type(owner.name.value, 'reference', { key: owner.key }) }]]);
          checker.read(checker.infer(dimension.default, defaultEnvironment), dimension.default);
          for (const parameter of checker.inputs.values()) {
            const binding = explicit.get(parameter.name);
            const conditional = { ...parameter, required: false };
            if (binding) this.bindInput(conditional, binding, environment);
            else this.addInput(conditional, node);
          }
        }
        return { type: value.type };
      }
      const value = this.read(this.infer(receiver, environment, method === 'recover' ? expected : null), receiver);
      if (method === 'recover') {
        const resultType = value.type.kind === 'unknown' && expected ? expected : base(value.type);
        if (node.arguments.length || !node.cases.length) this.issue(node, 'recover requires case branches');
        const seen = new Set();
        for (const branch of node.cases) {
          for (const status of branch.statuses) {
            if (!(status in resultConstants)) this.issue(branch.expression, `unknown recovery status: ${status}`);
            if (seen.has(status)) this.issue(branch.expression, `duplicate recovery status: ${status}`);
            seen.add(status);
          }
          const local = new Map(environment);
          if (branch.binding) {
            if (JSON.stringify(branch.statuses) !== '["PARTIAL"]' || local.has(branch.binding)) this.issue(branch.expression, 'recovery binding requires a unique PARTIAL case variable');
            const resolved = type('partial', 'value', { args: [value.type] });
            local.set(branch.binding, { type: resolved, declaration: parameterDeclaration(this.doc, branch.bindingToken, resolved) });
          }
          const alternative = this.read(this.infer(branch.expression, local, resultType), branch.expression);
          if (!compatible(base(value.type), alternative.type)) this.issue(branch.expression, 'incompatible recovery branch result');
        }
        return { type: resultType };
      }
      if (!['map', 'filter', 'flat_map', 'group_by', 'sum_by'].includes(method)) { this.issue(node, `unknown calculation method: ${method}`); return { type: unknown }; }
      if (node.arguments.length !== 1 || node.arguments[0].name || node.arguments[0].expression.kind !== 'lambda') { this.issue(node, `${method} requires one lambda argument`); return { type: unknown }; }
      if (!['collection', 'values', 'sequence', 'grouped'].includes(value.type.name) || !value.type.args.length) { this.issue(node, `${method} requires a sequence`); return { type: unknown }; }
      const grouped = value.type.name === 'grouped';
      if (grouped && method !== 'sum_by') this.issue(node, 'grouped values support sum_by');
      const fn = node.arguments[0].expression;
      if (environment.has(fn.value) || !snake(fn.value)) this.issue(fn, 'lambda requires a unique snake_case parameter');
      const local = new Map(environment); const declaration = { kind: 'calculation_binding', name: fn.token, doc: this.doc, resolvedType: value.type.args.at(-1) }; this.doc.bindings.set(fn.token.start, declaration); local.set(fn.value, { type: value.type.args.at(-1), declaration });
      const returned = base(this.read(this.infer(fn.operands[0], local), fn.operands[0]).type);
      if (method === 'filter') {
        if (returned.name !== 'bool' && returned.kind !== 'unknown') this.issue(fn, 'filter predicate requires bool');
        return value;
      }
      if (method === 'flat_map') {
        if (!['sequence', 'collection', 'values'].includes(returned.name) || !returned.args.length) { this.issue(fn, 'flat_map requires a sequence result'); return { type: unknown }; }
        return { type: type('sequence', 'collection', { args: returned.args }) };
      }
      if (method === 'group_by') {
        if (returned.kind === 'collection') this.issue(fn, 'group_by requires a scalar key');
        return { type: type('grouped', 'collection', { args: [returned, value.type.args[0]] }) };
      }
      if (method === 'sum_by') {
        if (!numbers.includes(returned.name) && returned.kind !== 'unknown') this.issue(fn, 'sum_by requires numeric contributions');
        return { type: grouped ? type('mapping', 'collection', { args: [value.type.args[0], returned] }) : returned };
      }
      return { type: type('sequence', 'collection', { args: [returned] }) };
    }
  }
  class LookupChecker extends Checker {
    inferNode(node, environment, expected) {
      let result = super.inferNode(node, environment, expected);
      if (node.kind === 'member' && result.field) {
        const receiver = symbols.get(node.operands[0].inferred?.type.key);
        if (receiver && !receiver.effective?.has(node.value) && !result.field.owner.ancestors?.includes(receiver)) {
          const descendant = [...symbols.values()].find(entity => entity.kind === 'entity' && entity.ancestors?.includes(receiver) && entity.effective?.has(node.value));
          if (descendant) {
            const field = descendant.effective.get(node.value);
            this.doc.bindings.set(node.memberToken.start, field);
            result = { type: new Resolver(field.doc, report, symbols, field.owner, true).resolve(field.type), field };
          } else {
            this.doc.bindings.delete(node.memberToken.start);
            this.issue(node, `unknown entity field: ${node.value}`);
            return { type: unknown };
          }
        }
        if (receiver && (result.field.commonType || result.field.identity?.commonType)) {
          const fields = [...symbols.values()].filter(entity => entity === receiver || entity.ancestors?.includes(receiver))
            .map(entity => entity.effective?.get(node.value)).filter(field => field?.identity === result.field.identity);
          const common = commonType(fields.map(field => new Resolver(field.doc, report, symbols, field.owner, true).resolve(field.type)), symbols);
          if (common) result = { ...result, type: common };
        }
      }
      return result;
    }
    addInput(parameter, node) {
      const prior = this.inputs.get(parameter.name);
      if (prior && !equal(prior.type, parameter.type)) {
        if (accepts(prior.type, parameter.type, symbols)) this.inputs.set(parameter.name, { ...prior, type: parameter.type });
        else if (accepts(parameter.type, prior.type, symbols)) parameter = { ...parameter, type: prior.type };
      }
      super.addInput(parameter, node);
    }
    parameters(value, operation, node) {
      if (!['id', 'static', 'scd'].includes(value.field.mode)) this.issue(node, `lookup does not support ${value.field.mode} fields`);
      if (operation !== 'value') this.issue(node, 'lookup supports only ::value()');
      return super.parameters(value, operation, node);
    }
    bindInput(parameter, expression, environment) {
      const pure = node => {
        if (['string', 'integer', 'decimal', 'bool'].includes(node.kind)) return true;
        if (node.kind === 'name') return this.doc.scope.get(node.value)?.kind === 'constant';
        if (node.kind === 'member' && node.operands[0].kind === 'name') {
          const root = node.operands[0].value;
          if (root === 'input') return true;
          return this.doc.scope.get(root)?.kind === 'decodes';
        }
        if (['binary', 'unary', 'conditional'].includes(node.kind)) return node.operands.every(pure);
        if (node.kind === 'call' && node.operands[0].kind === 'name' && node.operands[0].value in conversions.signatures) return node.arguments.every(a => pure(a.expression));
        return false;
      };
      if (!pure(expression)) { this.issue(expression, 'lookup binding requires a pure expression of inputs, literals, constants or dictionary members'); return; }
      if (expression.kind === 'member' && expression.operands[0].value === 'input') return super.bindInput(parameter, expression, environment);
      if (expression.kind === 'binary' && expression.value === '??') return super.bindInput(parameter, expression, environment);
      const inferInputs = (node, expected) => {
        if (node.kind === 'member' && node.operands[0].kind === 'name' && node.operands[0].value === 'input') {
          if (!this.inputs.has(node.value)) this.addInput({ ...parameter, name: node.value, type: expected }, node);
          return;
        }
        if (node.kind === 'conditional') {
          inferInputs(node.operands[0], type('bool'));
          node.operands.slice(1).forEach(child => inferInputs(child, expected));
          return;
        }
        if (['binary', 'unary'].includes(node.kind) && ['and', 'or', 'not'].includes(node.value)) {
          node.operands.forEach(child => inferInputs(child, type('bool')));
          return;
        }
        if (node.kind === 'call' && node.operands[0].kind === 'name') {
          const signature = conversions.signatures[node.operands[0].value];
          node.arguments.forEach((argument, index) => {
            const name = argument.name || signature[index]?.[0];
            const typeName = signature.find(([key]) => key === name)?.[1];
            inferInputs(argument.expression, ['string', 'date', 'datetime', 'integer', 'bool'].includes(typeName) ? type(typeName, typeName === 'string' ? 'string' : 'value') : expected);
          });
          return;
        }
        node.operands.forEach(child => inferInputs(child, expected));
        node.arguments.forEach(argument => inferInputs(argument.expression, expected));
      };
      inferInputs(expression, parameter.type);
      let actual = this.read(this.infer(expression, environment, parameter.type), expression).type;
      if (expression.kind === 'string' && parameter.type.name === 'string') actual = { ...parameter.type, exact: expression.value };
      if (!compatible(parameter.type, actual)) this.issue(expression, `incompatible binding for parameter: ${parameter.name}`);
    }
  }
  function lookupPath(node) {
    if (node.kind === 'name') return node.value === 'self';
    if (node.kind === 'member') return lookupPath(node.operands[0]);
    if (node.kind === 'call') {
      const selected = node.operands[0];
      return selected.kind === 'descriptor' && selected.value === 'value' && selected.operands[0].kind === 'member' && node.arguments.every(a => a.name) && lookupPath(selected.operands[0]);
    }
    return false;
  }
  function finiteValue(doc, resolved, payload) {
    if (payload instanceof Map) {
      const declaration = symbols.get(resolved.key);
      if (!declaration || declaration.kind !== 'value') throw Error('structured finite value requires a declared type');
      const fields = [...payload].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([name, value]) => {
        const field = declaration.fields.find(item => item.name.value === name);
        if (!field) throw Error('unknown structured finite value field');
        const fieldType = new Resolver(field.doc, report, symbols, declaration, true).resolve(field.type);
        return [name, JSON.parse(finiteValue(field.doc, fieldType, value))];
      });
      return JSON.stringify(['structured', resolved.key, fields]);
    }
    if (Array.isArray(payload) || payload === null || payload === undefined) throw Error('finite values must be non-collection values');
    const target = resolved.name === 'code' ? resolved.args[0].key : resolved.key;
    const value = payload instanceof constants.Ratio ? payload.text() : typeof payload === 'number' ? String(payload) : typeof payload === 'object' ? payload.iso : payload;
    return JSON.stringify([resolved.name, target, value]);
  }
  function finite(doc, node) {
    if (finiteTypes.has(node)) return finiteTypes.get(node);
    const issue = (expression, message) => report(doc, expression.token, message);
    if (finiteActive.has(node)) { issue(node, 'finite type dependency cycle'); return unknown; }
    finiteActive.add(node);
    const candidates = [];
    for (const expression of node.candidates) {
      const checker = new Checker(doc, null, issue), before = doc.diagnostics.length;
      function flagsExpression(value) {
        if (value.kind === 'member' && value.operands[0].kind === 'name') {
          const root = value.operands[0], symbol = doc.scope.get(root.value);
          if (symbol?.kind !== 'decodes' || !isFlags(symbol)) return null;
          return { token: root.token, name: root.value, args: null, params: null, accesses: [{ operator: { value: '.' }, token: value.memberToken }], operations: [] };
        }
        if (value.kind === 'binary' && ['+', '-'].includes(value.value)) {
          const left = flagsExpression(value.operands[0]), right = flagsExpression(value.operands[1]);
          if (left && right) { left.operations.push({ operator: { value: value.value }, term: right }); return left; }
        }
        return null;
      }
      const flags = flagsExpression(expression);
      if (flags) {
        const resolver = new Resolver(doc, report, symbols, null, true);
        const result = resolver.valueType(resolver.evaluate(flags));
        if (node.name === 'exact') { finiteActive.delete(node); finiteTypes.set(node, result); return result; }
        if (result.exact !== null && doc.diagnostics.length === before) candidates.push([base(result), result.exact]);
        continue;
      }
      const symbol = expression.kind === 'name' ? doc.scope.get(expression.value) : null;
      if (node.name === 'exact' && symbol && ['entity', 'decodes'].includes(symbol.kind)) {
        const resolver = new Resolver(doc, report, symbols, null, true);
        const source = { token: expression.token, name: expression.value, args: null, params: null, accesses: [], operations: [] };
        const result = resolver.valueType(resolver.evaluate(source));
        finiteActive.delete(node); finiteTypes.set(node, result); return result;
      }
      const resolved = checker.read(checker.infer(expression, new Map()), expression).type;
      pure(doc, issue, expression);
      if (['collection', 'reference'].includes(resolved.kind) || (expression.kind === 'name' && expression.value in resultConstants)) issue(expression, 'finite values must be non-collection values without entity instances');
      if (doc.diagnostics.length !== before || resolved.kind === 'unknown') { if (node.name === 'exact') issue(expression, 'exact requires a constant value'); continue; }
      try { candidates.push([base(resolved), constants.evaluate(expression, name => resolveConstant(doc, name))]); }
      catch (error) { issue(expression, `finite value evaluation failed: ${error.message}`); }
    }
    const common = commonType(candidates.map(([resolved]) => resolved), symbols);
    let result = unknown;
    if (candidates.length === node.candidates.length) {
      if (!common && candidates.length) issue(node, 'finite values require a common type; use typed constants or explicit conversions');
      else {
        try {
          const values = new Set(candidates.map(([resolved, value]) => finiteValue(doc, common?.name === 'string' ? common : resolved, common?.name === 'string' && resolved.name !== 'string' ? (value instanceof constants.Ratio ? value.text() : String(value)) : value)));
          if (node.name === 'exact' && values.size === 1) {
            const key = [...values][0], payload = JSON.parse(key)[2];
            result = { ...common, exact: typeof payload === 'boolean' ? String(payload) : typeof payload === 'object' ? '' : String(payload), exactValue: key };
          } else if (values.size < 2) issue(node, 'one_of requires at least two distinct values; use exact for one');
          else result = { ...common, allowed: [...values].sort() };
        } catch (error) { issue(node, error.message); }
      }
    }
    finiteActive.delete(node); finiteTypes.set(node, result);
    return result;
  }
  function run() {
  for (const doc of documents.filter(d => !d.errors.length)) for (const declaration of doc.declarations) {
    if (declaration.kind === 'constant') constant(declaration);
    for (const dimension of declaration.kind === 'dimension' ? [declaration] : declaration.dimensions || []) if (dimension.default) {
      const checker = new Checker(doc, dimension.owner, (node, message) => report(doc, node.token, message));
      const environment = dimension.owner ? new Map([['self', { type: type(dimension.owner.name.value, 'reference', { key: dimension.owner.key }) }]]) : new Map();
      const actual = checker.read(checker.infer(dimension.default, environment), dimension.default).type;
      const resultLiteral = node => (node.kind === 'name' && node.value in resultConstants) || node.operands.some(resultLiteral) || node.arguments.some(a => resultLiteral(a.expression)) || node.cases.some(c => resultLiteral(c.expression));
      if (resultLiteral(dimension.default) || (actual.name !== 'Hierarchy' && !(actual.name === 'string' && dimension.default.kind === 'string') && actual.kind !== 'unknown')) checker.issue(dimension.default, 'hierarchy default requires a Hierarchy reference or view');
    }
    for (const dimension of declaration.kind === 'dimension' ? [declaration] : declaration.dimensions || []) if (dimension.fallback) {
      const checker = new Checker(doc, dimension.owner, (node, message) => report(doc, node.token, message));
      const environment = dimension.owner ? new Map([['self', { type: type(dimension.owner.name.value, 'reference', { key: dimension.owner.key }) }]]) : new Map();
      const actual = checker.read(checker.infer(dimension.fallback, environment), dimension.fallback);
      if (actual.type.name !== 'integer' && actual.type.kind !== 'unknown') checker.issue(dimension.fallback, 'fallback_days requires an integer expression');
      if (checker.inputs.size || checker.dependencies.size) checker.issue(dimension.fallback, 'fallback_days requires stored static or config dependencies without external parameters');
    }
    for (const field of declaration.fields) if ((field.calculation || field.abstract) && field.owner?.kind === 'entity') analyze(field);
    for (const lookup of declaration.lookups || []) {
      const owner = lookup.entity;
      if (!owner) continue;
      let descriptorError = false;
      const checker = new LookupChecker(doc, owner, (node, message) => {
        if (message === 'field operation requires a field descriptor') {
          if (descriptorError) return;
          descriptorError = true;
        }
        const selected = node.kind === 'call' ? node.operands[0] : node;
        const operator = selected.kind === 'descriptor' ? '::' : selected.kind === 'member' ? '.' : '';
        const token = operator && doc.tokens.findLast(t => t.end <= selected.memberToken.start && t.value === operator);
        report(doc, token || node.token, message);
      });
      declareInputs(checker, lookup, checker.issue);
      const environment = new Map([['self', { type: type(owner.name.value, 'reference', { key: owner.key }) }]]);
      for (const key of lookup.keys) {
        descriptorError = false;
        const source = key.expression;
        if (source.kind !== 'call' || !lookupPath(source)) { checker.issue(source, 'lookup key requires a self field path ending in ::value()'); continue; }
        const result = checker.read(checker.infer(source, environment), source);
        key.resolvedType = result.type;
        if (!lookupSupported(result.type, symbols)) checker.issue(source, 'lookup key requires a supported non-collection type');
      }
      checker.checkDefaults();
      lookup.inferredInputs = [...checker.inputs.values()].sort((a, b) => a.name.localeCompare(b.name));
      const inputs = new Map();
      for (const node of require('./calculation-tools.cjs').nodes(lookup)) {
        if (node.kind !== 'member' || node.operands[0].kind !== 'name' || node.operands[0].value !== 'input') continue;
        const parameter = checker.inputs.get(node.value);
        if (!parameter) continue;
        if (!inputs.has(node.value)) inputs.set(node.value, { kind: 'lookup_input', name: node.memberToken, doc, resolvedType: parameter.type, required: parameter.required, default: parameter.default });
        doc.bindings.set(node.memberToken.start, inputs.get(node.value));
      }
    }
  }
  const contracts = new Map();
  for (const [field, checker] of completed) {
    if (field.abstract) continue;
    const contract = JSON.stringify([...checker.inputs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(p => [p.name, canonical(p.type), p.required, scopedSemantic(p.default, p.defaultDoc || field.doc)]));
    const prior = contracts.get(field.identity);
    if (prior && prior.contract !== contract) {
      const location = prior.field.token.range.start;
      const path = prior.field.doc.uri.startsWith('file:') ? require('node:url').fileURLToPath(prior.field.doc.uri) : prior.field.doc.uri;
      report(field.doc, field.calculation.result.token, `computed parameter signature mismatch: ${field.name.value}; conflicts with ${path}:${location.line + 1}:${location.character + 1}`);
    }
    contracts.set(field.identity, { contract, field });
  }
  }
  return { run, finite };
}

module.exports = { checkComputations, lookupSupported };
