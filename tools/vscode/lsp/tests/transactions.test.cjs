'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, format } = require('../transactions/syntax.cjs');
const { number } = require('../transactions/writing.cjs');
const { Service } = require('../service.cjs');
const cases = require('./transaction-cases.json');

for (const item of cases) test('shared transaction syntax: ' + item.name, () => {
  const doc = parse(item.text);
  if (item.invalid) {
    assert.ok(doc.diagnostics.length);
    assert.equal(format(doc), null);
  } else {
    assert.deepEqual(doc.diagnostics, []);
    assert.equal(format(doc), item.formatted);
    assert.equal(format(parse(item.formatted)), item.formatted);
  }
});

test('exact numeric canonicalization never passes payloads through Number', () => {
  for (const [input, expected] of [
    ['123456789012345678901234567890', '123456789012345678901234567890'],
    ['-12345678901234567890.1200', '-12345678901234567890.12'],
    ['00001.250e-2', '0.0125'], ['1e3', '1000.0'], ['-0.000', '0.0'],
  ]) assert.equal(number(input), expected);
});

test('FMC static plan parses and retains its canonical layout', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../../../../../fmc-data-model/examples/demo.yaplan'), 'utf8');
  const doc = parse(text);
  assert.deepEqual(doc.diagnostics, []);
  assert.equal(format(doc), text);
});

test('transaction documents coexist with models and synchronize untitled language IDs', () => {
  const service = new Service(() => {});
  const uri = 'untitled:plan';
  service.open.set('untitled:model', { text: 'entity A { id id: string }', version: 1 });
  service.open.set(uri, { text: cases[0].text, languageId: 'yaplan', version: 1 });
  service.refresh();
  assert.deepEqual(service.document(uri).diagnostics, []);
  const feature = name => service.feature('textDocument/' + name, { textDocument: { uri }, position: { line: 0, character: 0 } });
  assert.ok(feature('completion').items.some(item => item.label === 'owned_data'));
  assert.equal(feature('formatting')[0].newText, cases[0].formatted);
  assert.equal(feature('definition'), null);
  assert.equal(feature('documentSymbol')[0].name, 'first');
  service.open.set(uri, { text: cases[0].text.replace('version 1', 'version 2'), languageId: 'yaplan', version: 2 });
  service.refresh();
  assert.match(service.document(uri).diagnostics[0].message, /version/);
  assert.deepEqual(feature('formatting'), []);
});
