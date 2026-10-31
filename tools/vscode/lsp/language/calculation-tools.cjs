'use strict';

// Editor views of the checker's resolved expressions. No separate type inference.
function typeLabel(type) {
  if (!type) return '?';
  const args = type.args?.length ? '<' + type.args.map(typeLabel).join(', ') + '>' : '';
  const params = type.params?.length ? '[' + type.params.map(([key, value]) => `${key}: ${value}`).join(', ') + ']' : '';
  const name = (!type.key && { sequence: 'Seq', grouped: 'Grouped', partial: 'Partial' }[type.name]) || type.name;
  const dictionary = type.name === 'code' && type.key ? '<' + type.key.split('\0').slice(-2).filter(Boolean).join('.') + '>' : '';
  return name + args + dictionary + params;
}

const methods = {
  map: ['map(f: T -> U) -> Seq<U>', 'Transform each contribution once. Preserve order, row count and duplicates.'],
  filter: ['filter(predicate: T -> bool) -> Seq<T>', 'Keep contributions whose predicate is true. Failures and Partial issues are preserved.'],
  all: ['all(predicate: T -> bool) -> bool', 'Check each element in order, stopping at the first false or non-normal result. An empty sequence returns true.'],
  flat_map: ['flat_map(f: T -> Seq<U>) -> Seq<U>', 'Expand exactly one sequence level. Preserve duplicate contributions.'],
  group_by: ['group_by(key: T -> K) -> Grouped<K, T>', 'Group by typed key equality. Do not deduplicate contributions.'],
  sum_by: ['sum_by(value: T -> Number) -> Number | mapping<K, Number>', 'Sum numeric contributions; grouped input returns a mapping. Empty input produces zero or an empty mapping. Integer and decimal arithmetic is exact.'],
  recover: ['recover(case STATUS[, STATUS] -> value, ...)', 'Evaluate only the matched branch. Normal results and unmatched states remain unchanged. case PARTIAL as p exposes p.value and p.issues; accepting p.value explicitly clears Partial.'],
  best_available: ['field::best_available(named_parameters...) -> ReadResult<Selection<T>>', 'Read .value and .dimensions from the selected record. Explicit dimension value overrides Hierarchy. Choose the latest date within the per-instance config fallback window, then source priority. SCD never crosses gaps.'],
  value: ['field::value(named_parameters...) -> ReadResult<T>', 'Read a stored coordinate or evaluate a computed field. Snapshot reads match the exact date; SCD reads match the active interval. Unbound parameters merge by name; explicit bindings affect only this dependency.'],
  records: ['field::records() -> Seq<Record>', 'Read the physically stored coordinates and their native value results without applying configuration defaults.'],
};
const conversions = require('./conversions.cjs');
for (const [name, parameters] of Object.entries(conversions.signatures)) {
  methods[name] = [`${name}(${parameters.map(p => p.join(': ')).join(', ')}) -> ${conversions.returns[name]}`,
    name === 'round' ? 'Explicit scale and required rounding mode: half_even, half_up, floor, ceil or toward_zero. No implicit rounding.' : name === 'truncate' ? 'Truncate toward zero at the explicitly supplied scale; return decimal.' : name.includes('datetime') ? 'ISO datetime with an explicit timezone; normalize to UTC. Invalid or lossy input returns ERROR.' : name.includes('date') ? 'ISO calendar date in YYYY-MM-DD form. Invalid input returns ERROR.' : 'Strict scalar conversion. Nonfinite values and implicit truncation or precision loss return ERROR.'];
}

function methodNames(type) {
  return type?.kind === 'collection' && ['collection', 'values', 'sequence'].includes(type.name)
    ? ['map', 'filter', 'flat_map', 'group_by', 'sum_by', 'all', 'recover']
    : type?.kind === 'collection' && type.name === 'grouped' ? ['sum_by', 'recover'] : ['recover'];
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

function inputTypeHelp(field) {
  const entries = (field.inferredInputs || []).map(p =>
    `    ${p.name}: ${typeLabel(p.type)}${p.default ? ' = ' + defaultLabel(p.default) : p.required ? ' (required)' : ' (optional)'}` +
    (p.description ? '\n        ' + p.description : ''));
  return ['input: {', ...entries, '}', '', 'Inferred inputs for ' + field.name.value + '. Defaults apply only when omitted.'].join('\n');
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
  if (field.initializer) visit(field.initializer);
  for (const key of field.keys || []) visit(key.expression);
  for (const statement of field.statements || []) visit(statement.expression);
  return result;
}

module.exports = { typeLabel, methodNames, methodHelp, methods, nodes, defaultLabel, inputTypeHelp };
