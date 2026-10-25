'use strict';

// Editor views of the checker's resolved expressions. No separate type inference.
function typeLabel(type) {
  if (!type) return '?';
  const args = type.args?.length ? '<' + type.args.map(typeLabel).join(', ') + '>' : '';
  const params = type.params?.length ? '[' + type.params.map(([key, value]) => `${key}: ${value}`).join(', ') + ']' : '';
  const name = { sequence: 'Seq', grouped: 'Grouped', partial: 'Partial' }[type.name] || type.name;
  const dictionary = type.name === 'code' && type.key ? '<' + type.key.split('\0').slice(-2).filter(Boolean).join('.') + '>' : '';
  return name + args + dictionary + params;
}

const methods = {
  map: ['map(f: T -> U) -> Seq<U>', 'Transform each contribution once. Preserve order, row count and duplicates.'],
  filter: ['filter(predicate: T -> bool) -> Seq<T>', 'Keep contributions whose predicate is true. Failures and Partial issues are preserved.'],
  flat_map: ['flat_map(f: T -> Seq<U>) -> Seq<U>', 'Expand exactly one sequence level. Preserve duplicate contributions.'],
  group_by: ['group_by(key: T -> K) -> Grouped<K, T>', 'Group by typed key equality. Do not deduplicate contributions.'],
  sum_by: ['sum_by(value: T -> Number) -> Number | mapping<K, Number>', 'Sum numeric contributions; grouped input returns a mapping. Empty input produces zero or an empty mapping. Integer and decimal arithmetic is exact.'],
  recover: ['recover(case STATUS[, STATUS] -> value, ...)', 'Evaluate only the matched branch. Normal results and unmatched states remain unchanged. case PARTIAL as p exposes p.value and p.issues; accepting p.value explicitly clears Partial.'],
  at: ['field::at(named_parameters...) -> ReadResult<T>', 'Read the exact snapshot date, the active SCD interval, or the static coordinate. Unbound parameters are inferred into the enclosing computation.'],
  best_available: ['field::best_available(named_parameters...) -> ReadResult<T>', 'Explicit dimension value overrides Hierarchy. Choose the latest date within the per-instance config fallback window, then source priority. SCD never crosses gaps.'],
  value: ['computed_field::value(named_parameters...) -> ReadResult<T>', 'Bind parameters of a dependent computed field. Unbound parameters merge by name; explicit bindings affect only this dependency.'],
};

function methodNames(type) {
  return ['collection', 'values', 'sequence'].includes(type?.name)
    ? ['map', 'filter', 'flat_map', 'group_by', 'sum_by', 'recover']
    : type?.name === 'grouped' ? ['sum_by', 'recover'] : ['recover'];
}

function methodHelp(name, node) {
  if (!methods[name]) return null;
  const receiver = node?.operands[0]?.operands[0]?.inferred?.type;
  const result = node?.inferred?.type;
  const signature = node?.parameters
    ? `${name}(${node.parameters.map(p => `${p.name}: ${typeLabel(p.type)}${p.default ? ' = ' + defaultLabel(p.default) : p.required ? '' : ' (optional)'}`).join(', ')})`
    : methods[name][0];
  return signature + (receiver ? '\nReceiver: ' + typeLabel(receiver) : '') +
    (result ? '\nResult: ReadResult<' + typeLabel(result) + '>' : '') + '\n\n' + methods[name][1];
}

function defaultLabel(node) {
  if (node.kind === 'member') return defaultLabel(node.operands[0]) + '.' + node.value;
  if (node.kind === 'binary') return node.operands.map(defaultLabel).join(' ' + node.value + ' ');
  return node.token?.value || node.value;
}

function nodes(field) {
  const result = [];
  function visit(node) {
    result.push(node);
    node.operands.forEach(visit);
    node.arguments.forEach(a => visit(a.expression));
    node.cases.forEach(c => visit(c.expression));
  }
  field.calculation?.bindings.forEach(b => visit(b.expression));
  if (field.calculation) visit(field.calculation.result);
  return result;
}

module.exports = { typeLabel, methodNames, methodHelp, methods, nodes, defaultLabel };
