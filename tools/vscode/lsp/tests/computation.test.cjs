'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, format } = require('../language/syntax.cjs');
const { validate } = require('../language/validation.cjs');
const { Service } = require('../service.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { position } = require('../language/syntax.cjs');

test('shared dimensions and hierarchies resolve across namespaces with local precedence', () => {
  const shared = parse(`namespace common
decodes Sources { - 1 Wind: 'Wind' }
hierarchy Preferred { - 1 Sources.Wind - 2 'Manual' }
dimension source_dim { value source: code<Sources> hierarchy order: Hierarchy = Preferred }
`, 'common.yambl');
  const model = parse(`namespace model
from common import source_dim
from common import Preferred
entity Shared { @dimension(source_dim) snapshot attr price: integer }
entity Local { dimension source_dim { value local: string } @dimension(source_dim) static attr price: integer }
`, 'model.yambl');
  validate([shared, model]);
  assert.deepEqual(shared.errors, []); assert.deepEqual(model.errors, []);
  assert.deepEqual(shared.diagnostics, []); assert.deepEqual(model.diagnostics, []);
  const [dictionary, hierarchy, dimension] = shared.declarations;
  const [entity, local] = model.declarations;
  assert.equal(entity.fields[0].metadata[0].dimension, dimension);
  assert.equal(local.fields[0].metadata[0].dimension, local.dimensions[0]);
  assert.equal(shared.bindings.get(dimension.default.token.start), hierarchy);
  assert.equal(shared.bindings.get(hierarchy.entries[0].value.start), dictionary);
  assert.equal(shared.bindings.get(hierarchy.entries[0].code.start).name.value, 'Wind');
  assert.equal(format(parse(format(shared))), format(shared));
});

test('hierarchy conversion and shared dimension validation distinguish flags and self', () => {
  const doc = parse(`decodes Sources { - 1 Wind: 'Wind' }
@flags decodes Flags { - 1 One: 'One' }
hierarchy Preference { - 1 Sources.Wind - 2 'Manual' }
dimension shared { value source: string hierarchy preference: Hierarchy = Sources::hierarchy() }
entity E {
  @dimension(shared) snapshot attr price: integer
  computed attr selected: integer { return self.price::best_available(preference=Sources::hierarchy()).value }
}
`, 'model.yambl');
  validate([doc]); assert.deepEqual(doc.diagnostics, []);
  const invalid = parse(`@flags decodes Flags { - 1 One: 'One' }
hierarchy Bad { - 1 Flags.One - 1 'same' }
dimension wrong { value source: string fallback_days = self.days::value() }
`, 'invalid.yambl');
  validate([invalid]);
  assert.ok(invalid.diagnostics.some(d => /ordinary Decodes/.test(d.message)));
  assert.ok(invalid.diagnostics.some(d => /duplicate Hierarchy ordering/.test(d.message)));
  assert.ok(invalid.diagnostics.some(d => /shared dimension cannot use self/.test(d.message)));
});

test('shared dimension and hierarchy references navigate and complete', () => {
  const text = `decodes Sources { - 1 Wind: 'Wind' }
hierarchy Preferred { - 1 Sources.Wind }
dimension shared { value source: string hierarchy order: Hierarchy = Preferred }
entity E { @dimension(shared) snapshot attr price: integer }
`;
  const service = new Service(() => {}), uri = 'untitled:shared-dimensions';
  service.open.set(uri, { text, version: 1 }); service.refresh();
  const feature = (method, offset) => service.feature('textDocument/' + method, { textDocument: { uri }, position: position(text, offset), context: { includeDeclaration: false } });
  assert.equal(feature('definition', text.lastIndexOf('shared') + 1).range.start.line, 2);
  assert.equal(feature('definition', text.lastIndexOf('Preferred') + 1).range.start.line, 1);
  assert.equal(feature('definition', text.lastIndexOf('Wind') + 1).range.start.line, 0);
  const completion = feature('completion', text.lastIndexOf('shared') + 2).items.map(item => item.label);
  assert.ok(completion.includes('shared'));
  const defaults = feature('completion', text.lastIndexOf('Preferred') + 3).items.map(item => item.label);
  assert.ok(defaults.includes('Preferred')); assert.ok(defaults.includes('Sources'));
});

test('hierarchy entry diagnostics point to the start of each entry', () => {
  const doc = parse(`decodes D { - 1 A: 'a' }
@flags decodes Flags { - 1 A: 'a' }
hierarchy H {
  - 1 D.Bad
  - 1 Missing.X
  - 2 Flags.A
}`, 'invalid-hierarchy.yambl');
  validate([doc]);
  assert.deepEqual(doc.diagnostics.map(d => [d.message, d.range.start.line + 1, d.range.start.character + 1]), [
    ['unknown Decodes code: D.Bad', 4, 3],
    ['duplicate Hierarchy ordering', 5, 3],
    ['unknown Decodes: Missing', 5, 3],
    ['Hierarchy entries require ordinary Decodes', 6, 3],
  ]);
});

test('hierarchy defaults infer temporal inputs only when the default is used', () => {
  const doc = parse(`hierarchy Preferred { - 1 'A' }
entity E {
  @temporal(day: date) scd attr dictionary: Decodes
  dimension d { value source: string hierarchy h: Hierarchy = self.dictionary::value()::hierarchy() }
  dimension d2 { value origin: string hierarchy h2: Hierarchy = self.dictionary::value(day=input.history_day)::hierarchy() }
  @dimension(d) static attr label: string
  @dimension(d2) static attr market: string
  @dimension(d) @temporal(day: date) snapshot attr observed: string
  computed attr automatic: string { return self.label::best_available().value }
  computed attr explicit_hierarchy: string { return self.label::best_available(h=Preferred).value }
  computed attr explicit_source: string { return self.label::best_available(source='A').value }
  computed attr alias: string { return self.label::best_available(h=input.choice).value }
  @extra_input_param(choice: Hierarchy = 'Preferred')
  computed attr alias_declared: string { return self.label::best_available(h=input.choice).value }
  computed attr fallback: string { return self.label::best_available(h=input.choice ?? Preferred).value }
  @extra_input_param(h: Hierarchy = 'Preferred')
  computed attr declared: string { return self.label::best_available().value }
  computed attr renamed: string { return self.observed::best_available(day=input.query).value }
  computed attr nested: string { return self.renamed::value(query=input.nested_day) }
  computed attr source_date: string { return self.market::best_available().value }
}`, 'temporal-hierarchy.yambl');
  validate([doc]);
  assert.deepEqual(doc.diagnostics, []);
  const entity = doc.declarations[1];
  const inputs = name => entity.fields.find(f => f.name.value === name).inferredInputs.map(p => [p.name, p.type.name, p.required]);
  assert.deepEqual(inputs('automatic'), [['day', 'date', false], ['h', 'Hierarchy', false], ['source', 'string', false]]);
  assert.deepEqual(inputs('explicit_hierarchy'), [['source', 'string', false]]);
  assert.deepEqual(inputs('explicit_source'), [['h', 'Hierarchy', false]]);
  assert.deepEqual(inputs('alias'), [['choice', 'Hierarchy', false], ['day', 'date', false], ['source', 'string', false]]);
  assert.deepEqual(inputs('alias_declared'), [['choice', 'Hierarchy', false], ['source', 'string', false]]);
  assert.deepEqual(inputs('fallback'), [['choice', 'Hierarchy', false], ['source', 'string', false]]);
  assert.deepEqual(inputs('declared'), [['h', 'Hierarchy', false], ['source', 'string', false]]);
  assert.deepEqual(inputs('renamed'), [['h', 'Hierarchy', false], ['query', 'date', true], ['source', 'string', false]]);
  assert.deepEqual(inputs('nested'), [['h', 'Hierarchy', false], ['nested_day', 'date', true], ['source', 'string', false]]);
  assert.deepEqual(inputs('source_date'), [['h2', 'Hierarchy', false], ['history_day', 'date', false], ['origin', 'string', false]]);
});

test('hierarchy defaults compare their declaration identities across scopes', () => {
  const one = parse("namespace one hierarchy H { - 1 'A' } dimension d_one { value source: string hierarchy h: Hierarchy = H }", 'one.yambl');
  const use = parse('namespace use from one import d_one from two import d_two entity E { @dimension(d_one) attr x:string @dimension(d_two) attr y:string computed attr z:bool { return self.x::best_available().value == self.y::best_available().value } }', 'use.yambl');
  for (const [text, conflict] of [
    ["namespace two hierarchy H { - 1 'B' } dimension d_two { value source: string hierarchy h: Hierarchy = H }", true],
    ["namespace two from one import H dimension d_two { value source: string hierarchy h: Hierarchy = H }", false],
  ]) {
    const two = parse(text, 'two.yambl'); validate([one, two, use]);
    assert.equal(use.diagnostics.some(d => d.message === 'conflicting inferred parameter: h'), conflict);
  }
  const shared = parse("namespace one dimension d_one { value source:string hierarchy h:Hierarchy = 'same' }", 'one.yambl');
  const same = parse("namespace two dimension d_two { value source:string hierarchy h:Hierarchy = 'same' }", 'two.yambl');
  validate([shared, same, use]);
  assert.ok(!use.diagnostics.some(d => d.message === 'conflicting inferred parameter: h'));
});

function exampleEditor() {
  const filename = path.resolve(__dirname, 'fixtures/example/model/core/computations.yambl');
  const uri = pathToFileURL(filename).href, original = fs.readFileSync(filename, 'utf8');
  const service = new Service(() => {});
  let text, version = 0;
  const open = source => { text = source; service.open.set(uri, { text, version: ++version }); service.refresh(); };
  const feature = (method, offset) => service.feature('textDocument/' + method, { textDocument: { uri }, position: position(text, offset), context: { includeDeclaration: false } });
  open(original);
  assert.deepEqual(service.document(uri).diagnostics.filter(d => d.severity === 1), []);
  return { uri, original, service, open, feature };
}

test('contextual literals, typed locals, constant navigation and conversion signatures', () => {
  const service = new Service(() => {}), uri = 'untitled:literal-editor';
  const text = `const OTHER_INDUSTRY: string = 'Other'
value amount { static attr quantity: decimal static attr label: string }
entity E {
    id key: string
    computed attr total: decimal {
        let a: amount = {quantity: 1.25, label: OTHER_INDUSTRY}
        let numbers: values<integer> = [1, 2]
        return round(a.quantity, scale=1, mode='half_even')
    }
}`;
  service.open.set(uri, { text, version: 1 }); service.refresh();
  assert.deepEqual(service.document(uri).diagnostics, []);
  const feature = (method, at) => service.feature('textDocument/' + method, { textDocument: { uri }, position: position(text, at), context: { includeDeclaration: false } });
  const member = text.indexOf('a.quantity');
  const completion = feature('completion', member + 2).items.map(i => i.label);
  for (const name of ['quantity', 'label', 'recover']) assert.ok(completion.includes(name), name);
  assert.equal(feature('definition', member + 2).range.start.character, 'value amount { static attr '.length);
  const constant = text.lastIndexOf('OTHER_INDUSTRY');
  assert.equal(feature('definition', constant).range.start.line, 0);
  assert.equal(feature('references', text.indexOf('OTHER_INDUSTRY')).length, 1);
  assert.match(feature('hover', constant).contents.value, /const OTHER_INDUSTRY: string = 'Other'/);
  assert.match(feature('hover', text.indexOf('round(')).contents.value, /half_even/);
  assert.match(feature('signatureHelp', text.indexOf('scale=') + 2).signatures[0].label, /round\(value: number, scale: integer, mode: string\)/);
  assert.equal(format(parse(format(parse(text)))), format(parse(text)));
});

test('descriptor completions use the receiver and reject invalid member contexts', () => {
  const service = new Service(() => {}), uri = 'untitled:descriptor-completions';
  for (const [text, marker, labels] of [
    ['entity E { static attr n: integer computed attr c: integer { return self.n::value() } }', 'self.n::', ['value', 'best_available', 'records']],
    ['entity E { computed attr n: integer { return 1 } computed attr c: integer { return self.n::value() } }', 'self.n::', ['value']],
    ['entity E { computed attr c: integer { let n = 1 return n::value() } }', 'n::', []],
    ['entity E { static attr n: integer static attr related: self.n::type }', 'self.n::', ['type', 'value', 'entity']],
    ['entity E { static attr n: integer static attr related: self.n:: }', 'self.n::', ['type', 'value', 'entity']],
    ['type fields<t: type<Entity>> = mapping<attrs<AttrCats.Static, t> as Attr, Attr::>', 'Attr::', ['type']],
    ['type fields<t: type<Entity>> = mapping<attrs<AttrCats.Static, t> as Attr, Attr::type>', 'Attr::', ['type']],
    ['entity E { computed attr c: integer { return unknown.member } }', 'unknown.', []],
  ]) {
    service.open.set(uri, { text, version: 1 }); service.refresh();
    const result = service.feature('textDocument/completion', { textDocument: { uri }, position: position(text, text.indexOf(marker) + marker.length) });
    assert.deepEqual(result.items.map(i => i.label), labels, marker);
  }
});

test('example model completion handles unfinished inputs and typed collection/reference members', () => {
  const { original, open, feature } = exampleEditor();
  for (const [prefix, name, expected] of [
    ['input.', 'industry_date', ['industry_date', 'price_date', 'as_of_date', 'price_source', 'price_hierarchy']],
    ['holdings.', 'group_by', ['map', 'filter', 'flat_map', 'group_by', 'sum_by', 'all', 'recover']],
    ['h.security.', 'wind_level1_industry', ['issuer', 'currency', 'price', 'wind_level1_industry']],
  ]) {
    const start = original.indexOf(prefix + name) + prefix.length;
    assert.ok(start >= prefix.length);
    for (const fragment of ['', name.slice(0, 2), name]) {
      open(original.slice(0, start) + fragment + original.slice(start + name.length));
      const items = feature('completion', start + fragment.length).items;
      for (const label of expected) assert.ok(items.some(i => i.label === label), `${prefix}${fragment}: ${label}`);
      assert.ok(!items.some(i => i.label.startsWith('__')), 'recovery placeholders must stay internal');
      if (prefix === 'input.') {
        assert.match(items.find(i => i.label === 'industry_date').documentation, /industry date/);
        assert.match(items.find(i => i.label === 'price_source').detail, /code<.*PriceSources>/);
      }
    }
  }
});

test('example model input hover shows the complete inferred input structure', () => {
  const { original, feature } = exampleEditor();
  const first = feature('hover', original.indexOf('input.industry_date'));
  const second = feature('hover', original.indexOf('input.price_date'));
  assert.equal(first.contents.value, second.contents.value);
  assert.match(first.contents.value, /^input: \{\n/);
  for (const entry of [
    'as_of_date: date (required)',
    'industry_date: date = input.as_of_date',
    'price_date: date = input.as_of_date',
    'price_hierarchy: Hierarchy (optional)',
    'price_source: code<PriceSources> (optional)',
    "Additional issuer's industry date",
  ]) assert.ok(first.contents.value.includes(entry), entry);
  assert.ok(!first.contents.value.includes('industry_type:'), 'bound dimensions are not external inputs');
  assert.ok(!first.contents.value.includes('price_fallback_days:'), 'instance config is not an input');
  const member = feature('hover', original.indexOf('input.industry_date') + 'input.'.length);
  assert.match(member.contents.value, /input.industry_date: date = input.as_of_date/);
  assert.match(member.contents.value, /Additional issuer's industry date/);
});

test('example model field calls offer signatures while parentheses and argument values are unfinished', () => {
  const { original, open, feature } = exampleEditor();
  for (const [needle, parameters] of [
    ['holdings::value(', ['as_of_date']],
    ['industry::value(', ['as_of_date', 'industry_type']],
    ['wind_level1_industry::value(', ['as_of_date']],
    ['market_value::value(', ['as_of_date', 'price_source', 'price_hierarchy']],
  ]) {
    const offset = original.indexOf(needle) + needle.length, end = original.indexOf(')', offset);
    for (const closing of ['', ')']) {
      for (const fragment of ['', 'as_of_date=', 'as_of_date=input.as_of_date, ']) {
        open(original.slice(0, offset) + fragment + closing + original.slice(end + 1));
        const cursor = offset + fragment.length;
        const signature = feature('signatureHelp', cursor);
        assert.ok(signature, `${needle}${fragment}${closing}`);
        assert.deepEqual(signature.signatures[0].parameters.map(p => p.label.split(':')[0]), parameters);
        if (!fragment.endsWith('=')) {
          const expected = parameters.filter(p => !fragment.includes(p + '='));
          assert.deepEqual(feature('completion', cursor).items.map(i => i.label), expected);
          if (expected.length) assert.equal(signature.activeParameter, parameters.indexOf(expected[0]));
        }
      }
    }
  }
});

test('example model calculated paths navigate across files and appear in reverse references', () => {
  const { uri, original, service, feature } = exampleEditor();
  for (const [use, file, declaration] of [
    ['security.wind_level1_industry', 'holdings_entry.yambl', 'security: Security'],
    ['wind_level1_industry::value', 'computations.yambl', 'wind_level1_industry: string'],
    ['issuer.industry', 'security/security.yambl', 'issuer: Issuer'],
    ['industry::value', 'issuer.yambl', 'industry: string'],
    ['holdings::value', 'portfolio/portfolio.yambl', 'holdings: collection<HoldingEntry>'],
  ]) {
    const offset = original.indexOf(use), target = feature('definition', offset);
    assert.ok(target.uri.endsWith('/' + file));
    const targetDoc = service.document(target.uri);
    assert.deepEqual(target.range.start, position(targetDoc.text, targetDoc.text.indexOf(declaration)));
    const references = service.feature('textDocument/references', { textDocument: { uri: target.uri }, position: target.range.start, context: { includeDeclaration: false } });
    assert.ok(references.some(r => r.uri === uri && JSON.stringify(r.range.start) === JSON.stringify(position(original, offset))));
  }
});

const source = `entity E {
    dimension prices { value source: string hierarchy hierarchy: Hierarchy = 'Local' fallback_days = self.days::value() }
    config attr days: integer = 2
    @dimension(prices) snapshot attr price: decimal
    computed attr value: decimal { return self.price::best_available().value }
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

test('records infer custom time and dimension members for completion', () => {
  const service = new Service(() => {}), uri = 'untitled:records';
  const text = "dimension source { value source: string } entity A { @dimension(source) @temporal(day: date) snapshot attr price: integer computed attr valid: bool { return self.price::records().all(r -> r.value > 0) } }";
  service.open.set(uri, { text, version: 1 }); service.refresh();
  const offset = text.indexOf('r.value') + 'r.'.length;
  const result = service.feature('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: offset } });
  assert.deepEqual(result.items.map(item => item.label), ['day', 'source', 'value']);
  assert.deepEqual(service.document(uri).declarations.find(item => item.name.value === 'A').fields.find(field => field.name.value === 'valid').inferredInputs, []);
});

test('best available exposes value and typed selected dimensions', () => {
  const service = new Service(() => {}), uri = 'untitled:selection';
  const text = "decodes Sources { - 1 Wind: 'Wind' } dimension feed { value source: code<Sources> hierarchy h: Hierarchy } entity A { @dimension(feed) attr price: integer computed attr chosen: code<Sources> { let selected = self.price::best_available() return selected.dimensions.source } }";
  service.open.set(uri, { text, version: 1 }); service.refresh();
  const labels = marker => service.feature('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: text.indexOf(marker) + marker.length } }).items.map(item => item.label);
  assert.deepEqual(labels('return selected.'), ['value', 'dimensions']);
  assert.deepEqual(labels('return selected.dimensions.'), ['source']);
  assert.deepEqual(service.document(uri).diagnostics.filter(item => item.severity === 1), []);
  const bad = parse('entity A { attr price: integer computed attr result: integer { return self.price::best_available() * 2 } }');
  validate([bad]);
  assert.ok(bad.diagnostics.some(item => item.severity === 1));
});

test('constraints preserve statement order and offer record members', () => {
  const service = new Service(() => {}), uri = 'untitled:constraints';
  const text = "entity A { snapshot attr price: integer constraint valid { let records = self.price::records() assert records.all(r -> r.value > 0) let x = 2 assert x > 0 } }";
  service.open.set(uri, { text, version: 1 }); service.refresh();
  const doc = service.document(uri);
  assert.deepEqual(doc.diagnostics.filter(item => item.severity === 1), []);
  const offset = text.indexOf('r.value') + 'r.'.length;
  const completion = service.feature('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: offset } });
  assert.deepEqual(completion.items.map(item => item.label), ['as_of_date', 'value']);
  const invalid = parse('entity A { constraint c { assert later > 0 let later = 1 assert 2 } } entity B inherits A { constraint c {} }');
  validate([invalid]);
  const errors = invalid.diagnostics.map(item => item.message);
  assert.ok(errors.some(item => item.includes('unknown calculation name: later')));
  assert.ok(errors.some(item => item.includes('constraint assert requires bool')));
  assert.ok(errors.some(item => item.includes('duplicate inherited constraint')));
});

test('calculated descriptors, arguments, inferred hover and field navigation', () => {
  const service = new Service(() => {}), uri = 'untitled:computations';
  service.open.set(uri, { text: source, version: 1 }); service.refresh();
  const request = (method, offset) => {
    const prefix = source.slice(0, offset).split('\n');
    return service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: prefix.length - 1, character: prefix.at(-1).length } });
  };
  const labels = offset => request('completion', offset).items.map(i => i.label);
  assert.deepEqual(labels(source.indexOf('::best_available') + 2), ['value', 'best_available', 'records']);
  assert.deepEqual(labels(source.indexOf('self.value::value') + 'self.value::'.length), ['value']);
  assert.deepEqual(labels(source.indexOf('best_available(') + 'best_available('.length), ['as_of_date', 'source', 'hierarchy']);
  assert.ok(request('hover', source.indexOf('total:')).contents.value.includes('price_date: date = input.as_of_date'));
  assert.equal(request('definition', source.indexOf('self.price') + 5).range.start.line, 3);
  assert.deepEqual(labels(source.indexOf('input.price_date') + 'input.'.length), ['as_of_date', 'hierarchy', 'price_date', 'source']);
});

test('computed target filtering excludes storage metadata and descendant fields resolve', () => {
  const doc = parse('entity E { computed attr value: integer { return self.child::value() } } entity F inherits E { static attr child: integer }');
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
  const text = "entity E { id key: string static attr children: collection<E> computed attr n: integer { let rows = self.children::value() return rows.sum_by(child -> if child.key::value() == 'x' then 1 else 0) } }";
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
        let holdings = self.holdings::value()
        return holdings.group_by(h ->
            h.security.industry::value()
        ).sum_by(h -> h.security.quantity::value())
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
  assert.deepEqual(feature('completion', text.indexOf('holdings.group_by') + 'holdings.'.length).items.map(i => i.label), ['map', 'filter', 'flat_map', 'group_by', 'sum_by', 'all', 'recover']);
  assert.ok(feature('completion', text.indexOf('h.security') + 2).items.some(i => i.label === 'security'));
  assert.ok(feature('completion', text.indexOf('h.security.industry') + 'h.security.'.length).items.some(i => i.label === 'industry'));
  for (const [use, declaration] of [['security.industry', 'security: Security'], ['industry::value', 'industry: string']]) {
    const definition = feature('definition', text.indexOf(use));
    assert.deepEqual(definition.range.start, require('../language/syntax.cjs').position(text, text.indexOf(declaration)));
    const references = feature('references', text.indexOf(declaration));
    assert.ok(references.some(r => r.range.start.line === 7));
  }
  const signature = feature('signatureHelp', text.indexOf('holdings::value(') + 'holdings::value('.length);
  assert.match(signature.signatures[0].label, /value\(as_of_date: date\)/);
  const incomplete = text.replace('h.security.industry', 'h.security.');
  open(incomplete);
  assert.ok(feature('completion', incomplete.indexOf('h.security.') + 'h.security.'.length, incomplete).items.some(i => i.label === 'industry'));
});

test('extra inputs merge, declared defaults win, descriptions and lambda layout survive formatting', () => {
  const text = `entity E {
    snapshot attr n: integer
    @extra_input_param(day: date = '2026-01-01', 'Optional date')
    computed attr x: integer {
        return self.n::value(as_of_date=input.day ?? input.as_of_date)
    }
}`;
  const doc = parse(text); validate([doc]);
  assert.deepEqual(doc.diagnostics, []);
  const inputs = doc.declarations[0].fields[1].inferredInputs;
  assert.equal(inputs.find(p => p.name === 'day').default.value, '2026-01-01');
  const layout = `entity E {
    static attr entries: collection<E>
    computed attr n: integer {
        return self.entries::value().map(h ->
            h.n::value()
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
    '@extra_input_param(day: date) @extra_input_param(day: date)',
    "@extra_input_param(day: date = '2026-02-30')",
    '@extra_input_param(day: collection<E>)',
  ]) {
    const bad = parse(`entity E { ${declaration} computed attr x: integer { return 0 } }`); validate([bad]);
    assert.ok(bad.diagnostics.some(d => d.severity === 1));
  }
});


test('unfinished double-colon calls complete stored and computed example fields', () => {
  const { original, open, feature } = exampleEditor();
  for (const [needle, expected] of [
    ['self.holdings::value()', ['value', 'best_available', 'records']],
    ['h.market_value::value(as_of_date=input.price_date ?? input.as_of_date)', ['value']],
    ['self.security.price::best_available()', ['value', 'best_available', 'records']],
  ]) {
    const start = original.indexOf(needle), end = start + needle.indexOf('::') + 2;
    assert.ok(start >= 0);
    for (const fragment of ['', 'v']) {
      open(original.slice(0, end) + fragment + original.slice(start + needle.length));
      const items = feature('completion', end + fragment.length).items;
      assert.deepEqual(items.map(i => i.label), expected);
      assert.equal(items[0].insertText, 'value($0)');
      assert.match(items[0].detail, /stored coordinate or evaluate a computed field/);
    }
  }
});
