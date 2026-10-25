'use strict';

const { Resolver, type, accepts, equal, base, canonical, unknown } = require('./expressions.cjs');
const { semantic, resolveDimension } = require('./dimensions.cjs');
const { resultConstants } = require('./syntax.cjs');
const numbers = ['integer', 'decimal', 'float'];
const snake = name => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name);

function checkComputations(documents, symbols, report) {
  const completed = new Map(), active = new Set();
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
      const value = checker.read(checker.infer(binding.expression, environment), binding.expression);
      const declaration = { kind: 'calculation_binding', name: binding.token, doc: field.doc, resolvedType: value.type };
      field.doc.bindings.set(binding.token.start, declaration);
      environment.set(binding.name, { ...value, declaration });
    }
    const actual = checker.read(checker.infer(field.calculation.result, environment), field.calculation.result).type;
    const expected = new Resolver(field.doc, report, symbols, field.owner, true).resolve(field.type);
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
      if (field.mode === 'computed') {
        if (operation !== 'value') this.issue(node, 'computed fields support ::value, not stored-field operations');
        this.dependencies.add(field);
        return [...analyze(field).inputs.values()];
      }
      if (!['at', 'best_available'].includes(operation)) this.issue(node, 'stored fields support ::at or ::best_available');
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
    read(value, node) {
      if (value.field) for (const parameter of this.parameters(value, value.field.mode === 'computed' ? 'value' : 'at', node)) this.addInput(parameter, node);
      return { type: value.type };
    }
    infer(node, environment) {
      const value = this.inferNode(node, environment);
      node.inferred = value;
      node.environment = new Map(environment);
      return value;
    }
    inferNode(node, environment) {
      if (['string', 'integer', 'decimal', 'bool'].includes(node.kind)) return { type: type(node.kind, node.kind === 'string' ? 'string' : 'value', { exact: node.value }) };
      if (node.kind === 'name') {
        if (environment.has(node.value)) {
          const value = environment.get(node.value);
          if (value.declaration) this.doc.bindings.set(node.token.start, value.declaration);
          return value;
        }
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
        const parent = this.read(this.infer(receiver, environment), receiver);
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
      if (['call', 'recover'].includes(node.kind)) return this.invoke(node, environment);
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
          if (!compatible(base(operands[0]), operands[1]) && !compatible(base(operands[1]), operands[0])) this.issue(node, 'comparison requires compatible operand types');
          return { type: type('bool') };
        }
        if (operands.some(t => !numbers.includes(t.name) && t.kind !== 'unknown')) { this.issue(node, 'arithmetic requires integer, decimal or float operands'); return { type: unknown }; }
        return { type: type(numbers[Math.max(0, ...operands.map(t => numbers.indexOf(t.name)))]) };
      }
      if (node.kind === 'conditional') {
        const condition = this.read(this.infer(node.operands[0], environment), node.operands[0]);
        if (condition.type.name !== 'bool' && condition.type.kind !== 'unknown') this.issue(node, 'if condition requires bool');
        const [left, right] = node.operands.slice(1).map(e => this.read(this.infer(e, environment), e).type);
        if (compatible(base(left), right)) return { type: base(left) };
        if (compatible(base(right), left)) return { type: base(right) };
        this.issue(node, 'if branches require compatible result types'); return { type: unknown };
      }
      this.issue(node, 'expression is only valid in its binding or method context'); return { type: unknown };
    }
    invoke(node, environment) {
      const selected = node.operands[0], receiver = selected.operands[0], method = selected.value;
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
      const value = this.read(this.infer(receiver, environment), receiver);
      if (method === 'recover') {
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
          const alternative = this.read(this.infer(branch.expression, local), branch.expression);
          if (!compatible(base(value.type), alternative.type)) this.issue(branch.expression, 'incompatible recovery branch result');
        }
        return { type: base(value.type) };
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
    for (const dimension of declaration.dimensions || []) if (dimension.fallback) {
      const checker = new Checker(doc, dimension.owner, (node, message) => report(doc, node.token, message));
      const actual = checker.read(checker.infer(dimension.fallback, new Map([['self', { type: type(dimension.owner.name.value, 'reference', { key: dimension.owner.key }) }]])), dimension.fallback);
      if (actual.type.name !== 'integer' && actual.type.kind !== 'unknown') checker.issue(dimension.fallback, 'fallback_days requires an integer expression');
      if (checker.inputs.size || checker.dependencies.size) checker.issue(dimension.fallback, 'fallback_days requires stored static or config dependencies without external parameters');
    }
    for (const field of declaration.fields) if (field.calculation) analyze(field);
  }
  const contracts = new Map();
  for (const [field, checker] of completed) {
    const contract = JSON.stringify([...checker.inputs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(p => [p.name, canonical(p.type), p.required, semantic(p.default)]));
    if (contracts.has(field.identity) && contracts.get(field.identity) !== contract) report(field.doc, field.calculation.result.token, `computed parameter signature mismatch: ${field.name.value}`);
    contracts.set(field.identity, contract);
  }
}

module.exports = { checkComputations };
