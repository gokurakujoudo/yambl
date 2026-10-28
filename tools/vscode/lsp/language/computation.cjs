'use strict';

const { Resolver, type, accepts, equal, base, canonical, unknown } = require('./expressions.cjs');
const { semantic, resolveDimension } = require('./dimensions.cjs');
const { resultConstants } = require('./syntax.cjs');
const numbers = ['integer', 'decimal', 'float'];
const conversions = require('./conversions.cjs');
const constants = require('./constant-evaluation.cjs');
const snake = name => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name);

function checkComputations(documents, symbols, report) {
  const completed = new Map(), active = new Set();
  const constantTypes = new Map(), constantActive = new Set(), constantValues = new Map();
  function constant(declaration) {
    if (constantTypes.has(declaration)) return constantTypes.get(declaration);
    const node = declaration.initializer, issue = (node, message) => report(declaration.doc, node.token, message);
    if (constantActive.has(declaration)) { issue(node, `constant dependency cycle: ${declaration.name.value}`); return unknown; }
    constantActive.add(declaration);
    const checker = new Checker(declaration.doc, declaration, issue);
    const expected = new Resolver(declaration.doc, report, symbols, declaration, true).resolve(declaration.type);
    const before = declaration.doc.diagnostics.length;
    const actual = checker.infer(node, new Map(), expected).type;
    function pure(expression, keyPosition = false) {
      if (expression.kind === 'name' && !keyPosition) {
        const symbol = declaration.doc.scope.get(expression.value);
        if (!(expression.value in conversions.signatures) && !['constant', 'decodes'].includes(symbol?.kind)) issue(expression, `not a pure constant dependency: ${expression.value}`);
      }
      if (['descriptor', 'recover', 'lambda'].includes(expression.kind) || (expression.kind === 'call' && expression.operands[0].kind !== 'name')) issue(expression, 'constant expressions cannot read fields, inputs or non-normal results');
      expression.operands.forEach((child, i) => pure(child, expression.kind === 'object' && expression.inferred?.type?.key && i % 2 === 0));
      expression.arguments.forEach(a => pure(a.expression));
    }
    pure(node);
    if (!compatible(expected, actual)) issue(node, `incompatible constant result: expected ${expected.name}, got ${actual.name}`);
    if (declaration.doc.diagnostics.length === before) {
      try {
        const payload = constants.evaluate(node, name => {
          const [root, code] = name.split('.'), target = declaration.doc.scope.get(root);
          if (target?.kind === 'constant') { constant(target); if (constantValues.has(target)) { const value = constantValues.get(target); if (code === undefined) return value; if (value instanceof Map && value.has(code)) return value.get(code); } }
          if (target?.kind === 'decodes' && code !== undefined) return code;
          throw Error(`not a pure constant dependency: ${name}`);
        });
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
    if (numbers.includes(expected.name) && numbers.includes(actual.name)) return numbers.indexOf(actual.name) <= numbers.indexOf(expected.name);
    if (expected.name === actual.name && expected.args.length && expected.args.length === actual.args.length) return expected.args.every((t, i) => compatible(t, actual.args[i]));
    return accepts(expected, actual, symbols);
  }
  function analyze(field) {
    if (completed.has(field)) return completed.get(field);
    const issue = (node, message) => report(field.doc, node.token, message);
    if (active.has(field)) { issue(field.calculation.result, `computed field dependency cycle: ${field.name.value}`); return { inputs: new Map() }; }
    active.add(field);
    const checker = new Checker(field.doc, field.owner, issue);
    for (const call of field.metadata.filter(c => c.name === 'extra_input_params')) {
      const values = new Map(); require('./decorators.cjs').bindCall(call, field, () => {}, symbols, values);
      const pair = call.arguments.find(a => a.mode === 'pair'), constraint = values.get('parameter');
      if (!pair || !constraint) continue;
      const name = pair.key.value, defaultType = values.get('parameter_default');
      if (checker.declared.has(name)) issue({ token: pair.key }, `duplicate extra input parameter: ${name}`);
      const defaultValue = defaultType?.exact == null ? null : { kind: ['integer', 'snowflake_id'].includes(constraint.name) ? 'integer' : ['decimal', 'float'].includes(constraint.name) ? 'decimal' : constraint.name === 'bool' ? 'bool' : 'string', value: defaultType.exact, token: pair.default.token, end: pair.default.token.end, operands: [], arguments: [], cases: [] };
      const parameter = { name, type: constraint, required: false, default: defaultValue, sites: [pair.key], description: values.get('description')?.exact || '' };
      checker.addInput(parameter, { token: pair.key }); checker.declared.set(name, parameter);
      const declaration = { kind: 'calculation_binding', name: pair.key, doc: field.doc, resolvedType: constraint };
      field.doc.bindings.set(pair.key.start, declaration); parameter.declaration = declaration;
    }
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
      if (declared) parameter = { ...parameter, required: false, default: declared.default || parameter.default };
      if (prior) {
        if (!equal(prior.type, parameter.type) || (prior.default && parameter.default && JSON.stringify(semantic(prior.default)) !== JSON.stringify(semantic(parameter.default)))) this.issue(node, `conflicting inferred parameter: ${name}`);
        parameter = { ...prior, required: prior.required || parameter.required, default: prior.default || parameter.default, sites: [...prior.sites, ...parameter.sites] };
      }
      this.inputs.set(name, parameter);
    }
    bindInput(parameter, expression, environment) {
      let alias = expression, fallback = null;
      if (expression.kind === 'binary' && expression.value === '??') [alias, fallback] = expression.operands;
      if (alias.kind === 'member' && alias.operands[0].kind === 'name' && alias.operands[0].value === 'input') {
        const declaration = this.declared.get(alias.value)?.declaration;
        if (declaration) this.doc.bindings.set(alias.memberToken.start, declaration);
        this.addInput({ ...parameter, name: alias.value, default: fallback || parameter.default, sites: [expression.token] }, expression);
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
            result.push({ name: dimension.hierarchy.value, type: hierarchyType, required: false, default: dimension.default || null, sites: [node.token], declaration: parameterDeclaration(dimension.doc, dimension.hierarchy, hierarchyType) });
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
        if (node.value in resultConstants && node.value !== 'PARTIAL') return { type: unknown };
        this.issue(node, `unknown calculation name: ${node.value}`); return { type: unknown };
      }
      if (node.kind === 'member') {
        const receiver = node.operands[0], symbol = receiver.kind === 'name' && this.doc.scope.get(receiver.value);
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
  for (const doc of documents.filter(d => !d.errors.length)) for (const declaration of doc.declarations) {
    if (declaration.kind === 'constant') constant(declaration);
    for (const dimension of declaration.dimensions || []) if (dimension.fallback && dimension.owner) {
      const checker = new Checker(doc, dimension.owner, (node, message) => report(doc, node.token, message));
      const actual = checker.read(checker.infer(dimension.fallback, new Map([['self', { type: type(dimension.owner.name.value, 'reference', { key: dimension.owner.key }) }]])), dimension.fallback);
      if (actual.type.name !== 'integer' && actual.type.kind !== 'unknown') checker.issue(dimension.fallback, 'fallback_days requires an integer expression');
      if (checker.inputs.size || checker.dependencies.size) checker.issue(dimension.fallback, 'fallback_days requires stored static or config dependencies without external parameters');
    }
    for (const field of declaration.fields) if (field.calculation && field.owner?.kind === 'entity') analyze(field);
  }
  const contracts = new Map();
  for (const [field, checker] of completed) {
    const contract = JSON.stringify([...checker.inputs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(p => [p.name, canonical(p.type), p.required, semantic(p.default)]));
    if (contracts.has(field.identity) && contracts.get(field.identity) !== contract) report(field.doc, field.calculation.result.token, `computed parameter signature mismatch: ${field.name.value}`);
    contracts.set(field.identity, contract);
  }
}

module.exports = { checkComputations };
