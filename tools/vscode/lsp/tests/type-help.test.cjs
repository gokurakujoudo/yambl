'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Service } = require('../service.cjs');
const { parse, position } = require('../language/syntax.cjs');
const { validate } = require('../language/validation.cjs');

function request(source, method) {
  const offset = source.indexOf('|');
  const text = source.replace('|', '');
  const uri = 'untitled:type-help', service = new Service(() => {});
  service.open.set(uri, { text, version: 1 });
  service.refresh();
  return service.feature('textDocument/' + method, { textDocument: { uri }, position: position(text, offset) });
}

function labels(source) { return request(source, 'completion').items.map(item => item.label); }

test('unfinished one_of completes visible constants and conversions', () => {
  const source = "const LOW: integer = 1\ndecodes D { - 1 One: 'one' }\nentity E { attr choice: one_of[LOW, |";
  const choices = labels(source);
  assert.ok(choices.includes('LOW'));
  assert.ok(choices.includes('D'));
  assert.ok(choices.includes('parse_datetime'));
  assert.ok(choices.includes('true'));
  assert.match(request(source, 'signatureHelp').signatures[0].label, /one_of\[value/);
  const exact = labels("const LOW: integer = 1\nentity Root {}\nentity E { attr choice: exact<|");
  assert.ok(exact.includes('LOW'));
  assert.ok(exact.includes('Root'));
  assert.ok(exact.includes('parse_datetime'));
});

test('built-in value types explain their meaning and parameterization', () => {
  for (const [name, expression] of [['decimal', /decimal\[precision, scale\].*total digits.*fractional digits/i], ['string', /regex.*dialect/i], ['integer', /integer/i]]) {
    const text = `entity E { attr field: ${name.slice(0, 1)}|${name.slice(1)} }`;
    assert.match(request(text, 'hover').contents.value, expression);
    assert.match(request('entity E { attr field: | }', 'completion').items.find(item => item.label === name).detail, expression);
  }
});

test('scalar parameter completion and signature help respect named and positional arguments', () => {
  assert.deepEqual(labels('entity E { attr field: decimal[|] }'), ['precision', 'scale']);
  const options = request('entity E { attr field: decimal[|] }', 'completion').items;
  assert.equal(options[0].insertText, 'precision: ');
  assert.deepEqual(labels('entity E { attr field: decimal[scale: 4, |] }'), ['precision']);
  assert.deepEqual(labels('entity E { attr field: decimal[18, |] }'), []);
  assert.deepEqual(labels('entity E { attr field: string[|] }'), ['regex']);
  assert.equal(request('entity E { attr field: decimal[scale: 4, |] }', 'signatureHelp').activeParameter, 0);
  assert.equal(request('entity E { attr field: decimal[precision: 18, scale: |] }', 'signatureHelp').activeParameter, 1);
  assert.match(request('entity E { attr field: decimal[18, |] }', 'signatureHelp').signatures[0].parameters[1].documentation, /fractional/i);
  assert.match(request('entity E { attr field: string[|] }', 'signatureHelp').signatures[0].parameters[0].documentation, /string.*dialect/i);
});

test('generic parameters complete visible types and preserve nested argument positions', () => {
  const declarations = 'entity Security {}\nvalue address { attr text: string }\ntype security_ref = Security\ntype amount = decimal\ndecodes Kinds { - 1 First: \'First\' }\n';
  const references = labels(declarations + 'entity E { attr field: collection<|> }');
  assert.ok(references.includes('Security'));
  assert.ok(references.includes('security_ref'));
  assert.ok(!references.includes('address'));
  assert.ok(!references.includes('decimal'));
  const values = labels(declarations + 'entity E { attr field: values<|> }');
  assert.ok(values.includes('decimal'));
  assert.ok(values.includes('address'));
  assert.ok(values.includes('amount'));
  assert.ok(!values.includes('Security'));
  assert.ok(!values.includes('security_ref'));
  const keys = labels(declarations + 'entity E { attr field: mapping<|, decimal> }');
  assert.ok(keys.includes('Security'));
  assert.ok(keys.includes('string'));
  assert.ok(!keys.includes('integer'));
  assert.ok(!keys.includes('amount'));
  assert.ok(labels(declarations + 'entity E { attr field: code<|> }').includes('Kinds'));
  assert.ok(!labels(declarations + 'entity E { attr field: code<|> }').includes('Security'));
  assert.match(request(declarations + 'entity E { attr field: code<|> }', 'signatureHelp').signatures[0].label, /code<dictionary>/);
  assert.ok(labels(declarations + 'entity E { attr field: type<|> }').includes('Security'));
  assert.deepEqual(labels('entity E { attr field: attrs<|> }'), ['AttrCats']);
  assert.deepEqual(labels('entity E { attr field: field_mapping<|> }'), ['AttrCats']);
  assert.deepEqual(labels('entity E { attr field: alias<|> }'), ['self']);
  assert.ok(labels('entity E { @override attr field: exact<|> }').includes('true'));
  const outer = request(declarations + 'entity E { attr field: mapping<code<Kinds>, | > }', 'signatureHelp');
  assert.match(outer.signatures[0].label, /mapping<TKey, TValue>/);
  assert.equal(outer.activeParameter, 1);
  assert.match(request(declarations + 'entity E { attr field: mapping<string, values<|> > }', 'signatureHelp').signatures[0].label, /values<T>/);
});

test('unfinished type expressions retain local declarations and do not trigger inside comments or strings', () => {
  assert.ok(labels('entity Before {}\nentity E { attr field: collection<|').includes('Before'));
  assert.ok(labels('entity E { attr field: collection<|\n}\nentity After {}').includes('After'));
  assert.deepEqual(labels("entity E { attr field: string['abc|'] }"), []);
  assert.equal(request("entity E { attr field: string['abc|'] }", 'signatureHelp'), null);
  assert.equal(request("entity E { attr field: string['abc|", 'signatureHelp'), null);
  assert.deepEqual(labels('entity E { attr field: decimal # collection<|\n}'), []);
  assert.equal(request('entity E { attr field: decimal # collection<|\n}', 'signatureHelp'), null);
});

test('string format references resolve, navigate and complete constrained aliases', () => {
  const source = "type first = string['[A-Z]+']\ntype plain = string\ntype combined = string['${first}_${first}']";
  const doc = parse(source); validate([doc]);
  assert.deepEqual(doc.diagnostics, []);
  const { Resolver } = require('../language/expressions.cjs');
  const symbols = new Map([...doc.scope.values()].map(d => [d.key, d]));
  const resolved = new Resolver(doc, () => {}, symbols, null).resolve(doc.declarations[2].type);
  assert.deepEqual(resolved.params, [['regex', '(?:[A-Z]+)_(?:[A-Z]+)']]);
  assert.equal(request("type first = string['[A-Z]+']\ntype combined = string['${fir|st}']", 'definition').range.start.line, 0);
  const choices = labels("type first = string['[A-Z]+']\ntype plain = string\ntype combined = string['${|}']");
  assert.ok(choices.includes('first'));
  assert.ok(!choices.includes('plain'));
  assert.ok(labels("type first = string['[A-Z]+']\ntype combined = string['${|").includes('first'));
  assert.deepEqual(labels("type first = string['[A-Z]+']\ntype combined = string['\\${|}']"), []);
  assert.deepEqual(labels("type first = string['[A-Z]+']\ntype combined = string['\\\\${|}']"), []);
  assert.ok(labels("type first = string['[A-Z]+']\ntype combined = string['\\\\\\\\${|}']").includes('first'));
  const invalid = parse("type a = string['${missing}']\ntype b = string['${a}']"); validate([invalid]);
  assert.ok(invalid.diagnostics.some(d => d.message.includes('unknown string format type')));
});

test('format reference completion excludes invalid and cyclic candidates', () => {
  const definitions = "type bad = string['${missing}']\ntype cycle = string['${cycle}']\ntype via = string['${use}']\ntype good = string['[A-Z]+']\n";
  assert.deepEqual(labels(definitions + "type use = string['${|}']"), ['good']);
  assert.deepEqual(labels(definitions + "type use = string['${|"), ['good']);
});

test('abstract entities require implementations and promote concrete subtype entries', () => {
  const doc = parse("abstract entity Root { abstract computed attr family: string } abstract entity Group inherits Root {} entity Zeta inherits Group { @override computed attr family: string { return 'Z' } } entity Alpha inherits Group { @override computed attr family: string { return 'A' } } entity Middle inherits Root { @override computed attr family: string { return 'M' } }");
  validate([doc]);
  assert.deepEqual(doc.diagnostics, []);
  assert.deepEqual(doc.declarations[0].subtypes.entries.map(e => [e.code.value, e.order.value]), [['Alpha', '100'], ['Middle', '200'], ['Zeta', '300']]);
  const missing = parse('abstract entity Root { abstract computed attr family: string } entity Child inherits Root {}');
  validate([missing]);
  assert.ok(missing.diagnostics.some(d => d.message.includes('has no implementation')));
  assert.ok(missing.diagnostics.some(d => d.message.includes('lacks implementation')));
});

test('override resolves an abstract subtype dictionary before comparing signatures', () => {
  const doc = parse('abstract entity Root { abstract computed attr family: code<Root::subtypes> } entity Child inherits Root { @override computed attr family: code<Root::subtypes> { return Root::subtypes.Child } }');
  validate([doc]);
  assert.deepEqual(doc.diagnostics, []);
});

test('abstract computation inputs detect conflicting implementations and cycles', () => {
  const conflict = parse("abstract entity Root { abstract computed attr result: integer } entity One inherits Root { snapshot attr n: integer @override computed attr result: integer { return self.n::value(as_of_date=input.day) } } entity Two inherits Root { @override computed attr result: integer { return 1 } }");
  validate([conflict]);
  assert.ok(conflict.diagnostics.some(d => d.message.includes('computed parameter signature mismatch')));
  const cyclic = parse('abstract entity Root { abstract computed attr result: integer } entity One inherits Root { @override computed attr result: integer { return self.result::value() } }');
  validate([cyclic]);
  assert.ok(cyclic.diagnostics.some(d => d.message.includes('computed field dependency cycle')));
  const extras = date => parse(`abstract entity Root { abstract computed attr v: integer } entity A inherits Root { @override @extra_input_param(day: date = '2026-01-01') computed attr v: integer { return 1 } } entity B inherits Root { @override @extra_input_param(day: date = '${date}') computed attr v: integer { return 2 } }`);
  const matching = extras('2026-01-01'); validate([matching]);
  assert.deepEqual(matching.diagnostics, []);
  const mismatching = extras('2026-02-01'); validate([mismatching]);
  assert.equal(mismatching.diagnostics.filter(d => d.message.includes('computed parameter signature mismatch')).length, 1);
});

test('string format references use the declaring scope and detect cycles', () => {
  const first = parse("namespace a type segment = string['[A-Z]+'] type full = string['${segment}']", 'first');
  const second = parse("namespace b from a import full type segment = string['[0-9]+'] type identifier = string['${full}']", 'second');
  validate([first, second]);
  assert.deepEqual(first.diagnostics, []);
  assert.deepEqual(second.diagnostics, []);
  const { Resolver } = require('../language/expressions.cjs');
  const symbols = new Map([...first.scope.values(), ...second.scope.values()].map(d => [d.key, d]));
  assert.deepEqual(new Resolver(second, () => {}, symbols, null).resolve(second.declarations[1].type).params, [['regex', '(?:(?:[A-Z]+))']]);
  const cycle = parse("type first = string['${second}'] type second = string['${first}']");
  validate([cycle]);
  assert.ok(cycle.diagnostics.some(d => d.message.includes('cycle')));
});

test('abstract extend and subtype rank use the promoted parent', () => {
  const base = parse('namespace core abstract entity Root {} abstract entity Group inherits Root {}', 'base');
  const extension = parse("namespace derived from core import Root from core import Group extend Root { abstract computed attr label: string } @decodes_rank(7, 'A') entity Alpha inherits Group { @override computed attr label: string { return 'A' } } @decodes_rank(3, 'Leaf') entity Leaf inherits Alpha {}", 'extension');
  validate([base, extension]);
  assert.deepEqual(base.diagnostics, []);
  assert.deepEqual(extension.diagnostics, []);
  assert.deepEqual(base.declarations[0].subtypes.entries.map(e => [e.code.value, e.order.value]), [['Alpha', '7'], ['Leaf', '10']]);
  const invalid = parse("abstract entity Root {} @decodes_rank(3, 'Group') abstract entity Group inherits Root {}");
  validate([invalid]);
  assert.ok(invalid.diagnostics.some(d => d.message.includes('abstract entity cannot have decodes_rank')));
});

test('escaped string references stay literal after decoding', () => {
  const doc = parse("type id = string['[A-Z]+'] type one = string['\\${missing}'] type two = string['\\\\${missing}'] type four = string['\\\\\\\\${id}']");
  validate([doc]);
  assert.deepEqual(doc.diagnostics, []);
  const { Resolver } = require('../language/expressions.cjs');
  const symbols = new Map([...doc.scope.values()].map(d => [d.key, d]));
  const resolve = name => new Resolver(doc, () => {}, symbols, null).resolve(doc.declarations.find(d => d.name.value === name).type).params[0][1];
  assert.equal(resolve('one'), '\\${missing}');
  assert.equal(resolve('two'), '\\${missing}');
  assert.equal(resolve('four'), '\\\\(?:[A-Z]+)');
});

test('unfinished target definitions do not crash computations in another source file', () => {
  const target = parse('namespace core\nentity Security { attr currency: code<> }', 'file:///target.yambl');
  const extension = parse('namespace core\nextend Security { computed attr price: decimal { return 1.25 } }', 'file:///extension.yambl');
  validate([target, extension]);
  assert.ok(extension.diagnostics.some(diagnostic => diagnostic.message.includes('extend requires a visible user-defined entity')));
});
