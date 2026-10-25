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
    computed attr total: decimal { return self.value::value(as_of_date=input.price_date ?? input.as_of_date) }
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

test('typed calculation members, methods, signatures and reverse references share analysis', () => {
  const text = `entity Security { static attr quantity: integer computed attr industry: string { return 'Industry' } }
entity HoldingEntry { static attr security: Security }
entity Fund {
    snapshot attr holdings: collection<HoldingEntry>
    computed attr grouped: mapping<string, integer> {
        let holdings = self.holdings::at()
        return holdings.group_by(h ->
            h.security.industry::value()
        ).sum_by(h -> h.security.quantity)
    }
}`;
  const uri = 'untitled:typed-members', service = new Service(() => {});
  const open = value => { service.open.set(uri, { text: value, version: 1 }); service.refresh(); };
  open(text);
  assert.deepEqual(service.document(uri).diagnostics, []);
  const feature = (method, offset, source = text) => {
    const lines = source.slice(0, offset).split('\n');
    return service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: lines.length - 1, character: lines.at(-1).length }, context: { includeDeclaration: false } });
  };
  assert.match(feature('hover', text.indexOf('holdings.group_by')).contents.value, /collection<HoldingEntry>/);
  assert.match(feature('hover', text.indexOf('group_by(h')).contents.value, /Grouped<string, HoldingEntry>/);
  assert.match(feature('hover', text.indexOf('h.security')).contents.value, /h: HoldingEntry/);
  assert.deepEqual(feature('completion', text.indexOf('holdings.group_by') + 'holdings.'.length).items.map(i => i.label), ['map', 'filter', 'flat_map', 'group_by', 'sum_by', 'recover']);
  assert.ok(feature('completion', text.indexOf('h.security') + 2).items.some(i => i.label === 'security'));
  assert.ok(feature('completion', text.indexOf('h.security.industry') + 'h.security.'.length).items.some(i => i.label === 'industry'));
  for (const [use, declaration] of [['security.industry', 'security: Security'], ['industry::value', 'industry: string']]) {
    const definition = feature('definition', text.indexOf(use));
    assert.deepEqual(definition.range.start, require('../language/syntax.cjs').position(text, text.indexOf(declaration)));
    const references = feature('references', text.indexOf(declaration));
    assert.ok(references.some(r => r.range.start.line === 7));
  }
  const signature = feature('signatureHelp', text.indexOf('holdings::at(') + 'holdings::at('.length);
  assert.match(signature.signatures[0].label, /at\(as_of_date: date\)/);
  const incomplete = text.replace('h.security.industry', 'h.security.');
  open(incomplete);
  assert.ok(feature('completion', incomplete.indexOf('h.security.') + 'h.security.'.length, incomplete).items.some(i => i.label === 'industry'));
});

test('extra inputs merge, declared defaults win, descriptions and lambda layout survive formatting', () => {
  const text = `entity E {
    snapshot attr n: integer
    @extra_input_params(day: date = '2026-01-01', 'Optional date')
    computed attr x: integer {
        return self.n::at(as_of_date=input.day ?? input.as_of_date)
    }
}`;
  const doc = parse(text); validate([doc]);
  assert.deepEqual(doc.diagnostics, []);
  const inputs = doc.declarations[0].fields[1].inferredInputs;
  assert.equal(inputs.find(p => p.name === 'day').default.value, '2026-01-01');
  const layout = `entity E {
    static attr entries: collection<E>
    computed attr n: integer {
        return self.entries.map(h ->
            h.n
            .recover(case EMPTY -> 0)
        ).sum_by(v ->
            v
        )
    }
}
`;
  assert.equal(format(parse(layout)), layout);
  assert.equal(format(parse(format(doc))), format(doc));
  for (const declaration of [
    '@extra_input_params(day: date) @extra_input_params(day: date)',
    "@extra_input_params(day: date = '2026-02-30')",
    '@extra_input_params(day: collection<E>)',
  ]) {
    const bad = parse(`entity E { ${declaration} computed attr x: integer { return 0 } }`); validate([bad]);
    assert.ok(bad.diagnostics.some(d => d.severity === 1));
  }
});
