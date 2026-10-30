'use strict';

const types = {
  bool: 'Boolean value.',
  string: "String value. Use string['regex'] or string[regex: 'regex'] to describe a regular-expression constraint. ${type_name} embeds a constrained string type's format. An unparameterized string has no constraint. Runtime matching is not performed and the regex dialect is not specified.",
  integer: 'Integer value.',
  float: 'Approximate floating-point value.',
  decimal: 'Decimal number. Use decimal[precision, scale] or decimal[precision: 18, scale: 4] to specify total digits and fractional digits. Unparameterized decimal has no implicit precision or scale.',
  date: 'Calendar date.',
  datetime: 'Date and time; conversions require a timezone and normalize to UTC.',
  snowflake_id: 'Built-in identifier value. Its bit structure and generation policy are not specified.',
  collection: 'Unordered collection of unique entity references.',
  values: 'Unordered collection of unique values.',
  mapping: 'Unordered mapping with unique string-compatible or entity-reference keys and non-collection values.',
  code: 'A code from a Decodes instance. A quoted unresolved name can identify an external dynamic dictionary.',
  type: 'Entity type value constrained by Entity or a specific entity and its descendants.',
  attrs: 'Field identities selected by attribute category and target entity; excludes IDs and collection attributes.',
  field_mapping: 'Mapping from selected entity fields to their declared value types.',
  alias: 'Same value as an instance-rooted field expression.',
  exact: 'Singleton value constraint.',
  one_of: 'Finite set of compile-time values.',
};

const signatures = {
  decimal: { open: '[', parameters: [['precision: integer', 'Total number of decimal digits.'], ['scale: integer', 'Number of fractional decimal digits.']], label: 'decimal[precision: integer, scale: integer]' },
  string: { open: '[', parameters: [['regex: string', 'Regular-expression constraint, as a single-quoted string; the regex dialect is not specified.']], label: 'string[regex: string]' },
  collection: { open: '<', parameters: [['T: entity reference', 'Entity type whose references form the collection.']], label: 'collection<T>' },
  values: { open: '<', parameters: [['T: value type', 'Value type of the collection elements.']], label: 'values<T>' },
  mapping: { open: '<', parameters: [['TKey: string-compatible type or entity reference', 'Unique mapping key type.'], ['TValue: non-collection value or entity reference', 'Mapping value type.']], label: 'mapping<TKey, TValue>' },
  code: { open: '<', parameters: [['dictionary: Decodes instance', 'Visible Decodes instance name, or a quoted name for an external dynamic dictionary.']], label: 'code<dictionary>' },
  type: { open: '<', parameters: [['T: entity type', 'Entity or a visible entity type.']], label: 'type<T>' },
  attrs: { open: '<', parameters: [['category: code<AttrCats>', 'Attribute categories to select.'], ['target: entity type', 'Entity type whose fields are selected.']], label: 'attrs<category, target>' },
  field_mapping: { open: '<', parameters: [['category: code<AttrCats>', 'Attribute categories to select.'], ['target: entity type', 'Entity type whose fields are selected.']], label: 'field_mapping<category, target>' },
  alias: { open: '<', parameters: [['value: instance field value', 'An instance-rooted field expression ending in ::value.']], label: 'alias<value>' },
  exact: { open: '<', parameters: [['value: constant', 'A compile-time constant value.']], label: 'exact<value>' },
  one_of: { open: '[', parameters: [['value: constant', 'A compile-time non-collection value.']], label: 'one_of[value, ...]' },
};

// Keep nesting so commas inside a child generic do not change the enclosing parameter.
function context(doc, offset) {
  const stack = [], tokens = doc.tokens.filter(t => t.end <= offset);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], value = token.value;
    if (['{', '(', '[', '<'].includes(value)) {
      const name = tokens[i - 1], before = tokens[i - 2];
      const signature = signatures[name?.value];
      const parent = stack.at(-1);
      const inType = parent?.signature || [':', '=', ',', '<'].includes(before?.value);
      stack.push({ open: value, token, name, signature: signature?.open === value && inType ? signature : null, commas: [] });
    } else if (['}', ')', ']', '>'].includes(value)) {
      const open = { '}': '{', ')': '(', ']': '[', '>': '<' }[value];
      if (stack.at(-1)?.open === open) stack.pop();
    } else if (value === ',' && stack.at(-1)?.signature) stack.at(-1).commas.push(token);
  }
  const current = stack.at(-1);
  if (!current?.signature) return null;
  const root = stack.find(frame => frame.signature) || current;
  const lastComma = current.commas.at(-1);
  const segment = doc.text.slice(lastComma?.end ?? current.token.end, offset);
  const prefix = doc.text.slice(current.token.end, offset);
  const named = /^\s*(precision|scale|regex)(?:\s*:|\s*$)/.exec(segment);
  const used = new Set([...prefix.matchAll(/\b(precision|scale|regex)\s*:/g)].map(match => match[1]));
  const active = named ? current.signature.parameters.findIndex(([label]) => label.startsWith(named[1] + ':')) : used.size ? current.signature.parameters.findIndex(([label]) => !used.has(label.split(':')[0])) : current.commas.length;
  return { ...current, root, segment, prefix, active: Math.max(0, Math.min(active, current.signature.parameters.length - 1)) };
}

function signatureHelp(typeContext) {
  const { signature, active, name } = typeContext;
  return { signatures: [{ label: signature.label, documentation: types[name.value], parameters: signature.parameters.map(([label, documentation]) => ({ label, documentation })) }], activeSignature: 0, activeParameter: active };
}

function completions(typeContext, scope, symbols, describe, Resolver) {
  const { name, segment, commas, signature } = typeContext;
  if (name.value === 'one_of' || name.value === 'exact') {
    if (!/^\s*[A-Za-z_0-9]*$/.test(segment)) return [];
    return [
      ...['true', 'false'].map(label => ({ label, kind: 21, detail: 'Constant value' })),
      ...[...scope].filter(([, d]) => ['constant', 'decodes'].includes(d.kind) || name.value === 'exact' && d.kind === 'entity').map(([label, d]) => ({ label, kind: 21, detail: describe(d) })),
      ...Object.keys(require('./conversions.cjs').signatures).map(label => ({ label, kind: 3, insertText: label + '(', detail: 'Pure conversion' })),
    ];
  }
  if (commas.length >= signature.parameters.length || !/^\s*[A-Za-z_0-9]*$/.test(segment)) return [];
  if (signature.open === '[') {
    const used = new Set([...typeContext.prefix.matchAll(/\b(precision|scale|regex)\s*:/g)].map(match => match[1]));
    if (commas.length && !used.size) return [];
    return signature.parameters.filter(([label]) => !used.has(label.split(':')[0])).map(([label, documentation]) => ({ label: label.split(':')[0], kind: 5, insertText: label.split(':')[0] + ': ', detail: label, documentation }));
  }
  const slot = commas.length, kind = name.value;
  if (kind === 'alias') return [{ label: 'self', kind: 6, insertText: 'self.', detail: 'Instance field value ending in ::value.' }];
  if (['attrs', 'field_mapping'].includes(kind) && slot === 0) return [{ label: 'AttrCats', kind: 20, detail: 'Attribute category flags.' }];
  if (kind === 'code') return [...scope].filter(([, d]) => d.kind === 'decodes').map(([label, d]) => ({ label, kind: 20, detail: describe(d) }));
  const reference = ['collection', 'type', 'attrs', 'field_mapping'].includes(kind);
  const key = kind === 'mapping' && slot === 0;
  const value = kind === 'values' || kind === 'mapping' && slot === 1;
  const result = [];
  const names = reference ? ['Entity'] : key ? ['string', 'snowflake_id', 'code', 'type', 'attrs'] : value ? ['bool', 'string', 'integer', 'float', 'decimal', 'date', 'datetime', 'snowflake_id', 'code', 'type', 'attrs'] : [];
  for (const label of names) result.push({ label, kind: 7, detail: types[label], documentation: types[label] });
  for (const [label, declaration] of scope) {
    let resolved = declaration.kind === 'entity' ? { kind: 'reference' } : declaration.kind === 'value' ? { kind: 'value' } : null;
    if (declaration.kind === 'type_alias' && !declaration.parameters.length) resolved = new Resolver(declaration.doc, () => {}, symbols, null).resolve(declaration.type);
    if (reference && resolved?.kind !== 'reference' || key && resolved?.kind !== 'reference' && !['string', 'snowflake_id', 'code', 'type', 'attrs'].includes(resolved?.name) || value && !['reference', 'value', 'string'].includes(resolved?.kind) || kind === 'values' && resolved?.kind === 'reference') continue;
    if (resolved) result.push({ label, kind: declaration.kind === 'entity' ? 7 : 20, detail: describe(declaration) });
  }
  return result;
}

module.exports = { types, signatures, context, signatureHelp, completions };
