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

test('unfinished target definitions do not crash computations in another source file', () => {
  const target = parse('namespace core\nentity Security { attr currency: code<> }', 'file:///target.yambl');
  const extension = parse('namespace core\nextend Security { computed attr price: decimal { return 1.25 } }', 'file:///extension.yambl');
  validate([target, extension]);
  assert.ok(extension.diagnostics.some(diagnostic => diagnostic.message.includes('extend requires a visible user-defined entity')));
});
