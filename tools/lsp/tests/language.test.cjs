'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, format, range } = require('../language/syntax.cjs');
const { validate } = require('../language/validation.cjs');
const cases = require('./cases.json');

test('core validation retains the two CLI Decodes warnings before editor filtering', () => {
  const docs = cases[0].map((text, i) => parse(text, `${i}.yambl`)); validate(docs);
  assert.deepEqual(docs.flatMap(d => d.diagnostics.map(x => [x.severity, x.message])), [
    [2, 'undefined Decodes: TradingMarkets'], [2, 'undefined Decodes: PriceSources'],
  ]);
  const security = docs[0].scope.get('Security');
  assert.deepEqual([...security.ownFields.keys()], ['security_id', 'currency', 'market', 'price', 'days']);
  assert.equal(docs[0].scope.size, 3); // Security, Bond, and imported Currencies; no extension symbol.
  assert.equal(security.ownFields.get('price').doc, docs[0]);
});
test('all accepted corpus files format idempotently and end with exactly one LF', () => {
  for (const group of cases) for (const source of group) {
    const doc = parse(source);
    if (doc.errors.length) { assert.equal(format(doc), null); continue; }
    const formatted = format(doc);
    assert.ok(formatted.endsWith('\n') && !formatted.endsWith('\n\n'));
    assert.equal(format(parse(formatted)), formatted);
  }
});
test('source positions use UTF-16, strings preserve escaped quotes and comments', () => {
  const text = "entity A { @description('😀\\' #') attr x: code<'Missing'> }";
  const doc = parse(text); validate([doc]);
  assert.equal(doc.errors.length, 0);
  assert.equal(doc.diagnostics[0].range.start.character, text.indexOf('code<'));
  assert.ok(format(doc).includes("@description('😀\\' #')"));
  assert.deepEqual(range('😀\nx', 3, 4), { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } });
});
test('extensions resolve in their original file and conflicting inherited fields are errors', () => {
  const docs = cases[1].map(text => parse(text)); validate(docs);
  assert.equal(docs[2].diagnostics[0].message, 'duplicate inherited field: price');
  const field = docs[0].scope.get('Security').ownFields.get('price');
  assert.equal(field.doc, docs[1]);
  assert.equal(docs[1].bindings.get(docs[1].declarations[0].name.start), docs[0].declarations[0]);
});
