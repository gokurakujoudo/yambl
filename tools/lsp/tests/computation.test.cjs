'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, format } = require('../language/syntax.cjs');
const { validate } = require('../language/validation.cjs');
const { Service } = require('../service.cjs');

const source = `entity E {
    dimension prices { value source: string hierarchy hierarchy: Hierarchy = 'Local' fallback_days = self.days }
    config attr days: integer = 2
    @dimension(prices) snapshot attr price: decimal
    computed attr value: decimal { return self.price::best_available() }
    computed attr total: decimal { return self.value::value(as_of_date=input.price_date.default(input.as_of_date)) }
}`;

test('named dimensions infer dates and selectors and survive repeated analysis', () => {
  const doc = parse(source); validate([doc]); validate([doc]);
  assert.deepEqual(doc.diagnostics, []);
  const total = doc.declarations[0].fields.find(f => f.name.value === 'total');
  assert.deepEqual(total.inferredInputs.map(p => p.name), ['as_of_date', 'hierarchy', 'price_date', 'source']);
  assert.equal(total.inferredInputs.find(p => p.name === 'price_date').default.value, 'as_of_date');
  const formatted = format(doc);
  assert.equal(format(parse(formatted)), formatted);
  assert.ok(formatted.includes('        return self.price::best_available()'));
});

test('calculation comments retain branch boundaries and formatting is idempotent', () => {
  const doc = parse('entity E { computed attr n: integer { let n=2 return if n>0 then n*2 # positive\nelse 0 } }');
  validate([doc]); assert.deepEqual(doc.diagnostics, []);
  const text = format(doc);
  assert.ok(text.includes('n > 0 then n * 2  # positive\n        else 0'));
  assert.equal(format(parse(text)), text);
});

test('calculated descriptors, arguments, inferred hover and field navigation', () => {
  const service = new Service(() => {}), uri = 'untitled:computations';
  service.open.set(uri, { text: source, version: 1 }); service.refresh();
  const request = (method, offset) => {
    const prefix = source.slice(0, offset).split('\n');
    return service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: prefix.length - 1, character: prefix.at(-1).length } });
  };
  const labels = offset => request('completion', offset).items.map(i => i.label);
  assert.deepEqual(labels(source.indexOf('::best_available') + 2), ['at', 'best_available']);
  assert.deepEqual(labels(source.indexOf('::value') + 2), ['value']);
  assert.deepEqual(labels(source.indexOf('best_available(') + 'best_available('.length), ['as_of_date', 'source', 'hierarchy']);
  assert.ok(request('hover', source.indexOf('total:')).contents.value.includes('price_date: date = input.as_of_date'));
  assert.equal(request('definition', source.indexOf('self.price') + 5).range.start.line, 3);
  assert.deepEqual(labels(source.indexOf('input.price_date') + 'input.'.length), ['as_of_date', 'hierarchy', 'price_date', 'source']);
});

test('computed target filtering excludes storage metadata and descendant fields resolve', () => {
  const doc = parse('entity E { computed attr value: integer { return self.child } } entity F inherits E { static attr child: integer }');
  validate([doc]); assert.deepEqual(doc.diagnostics, []);
  for (const decorator of ['temporal(day: date)', 'dimension(p)', "sparse('x')", "dense('x')"]) {
    const invalid = parse(`entity E { @${decorator} computed attr value: integer { return 1 } }`);
    validate([invalid]); assert.ok(invalid.diagnostics.some(d => d.severity === 1));
  }
  for (const group of require('./computation-cases.json')) for (const text of group) {
    const parsed = parse(text); validate([parsed]);
    if (!parsed.errors.length) assert.equal(format(parse(format(parsed))), format(parsed));
  }
});

test('immutable locals and lambda variables navigate to their declarations', () => {
  const text = 'entity E { id key: string static attr children: collection<E> computed attr n: integer { let rows = self.children return rows.sum_by(child -> if child.key == \'x\' then 1 else 0) } }';
  const service = new Service(() => {}), uri = 'untitled:locals';
  service.open.set(uri, { text, version: 1 }); service.refresh();
  for (const [use, declaration] of [['rows.sum_by', 'rows ='], ['child.key', 'child ->']]) {
    const result = service.feature('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: text.indexOf(use) } });
    assert.equal(result.range.start.character, text.indexOf(declaration));
  }
});
