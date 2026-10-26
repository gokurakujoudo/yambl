'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
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

test('explicit model bindings navigate inherited and extended fields and track unsaved edits', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-transaction-model-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const roots = ['first', 'second'].map(name => {
    const root = path.join(directory, name); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'yambl-root.lclcfg'), "prefix: 'fmc'\n");
    fs.writeFileSync(path.join(root, 'base.yambl'), 'namespace core entity Base { id id: string static attr amount: decimal } entity Child inherits Base {}');
    fs.writeFileSync(path.join(root, 'extra.yambl'), 'namespace core extend Child { static attr label: string }');
    return root;
  });
  const service = new Service(() => {}), uri = 'untitled:bound-plan';
  const text = cases[0].text.replace('group first {', "group first {\nupdate fmc.core.Child (id, amount, label) {\n'x', 2.5, 'label'\n}\ndelete fmc.core.Child.label scope (id='x')");
  service.open.set(uri, { text, languageId: 'yaplan', version: 1 });
  const at = (needle, skip = 0) => {
    const offset = text.indexOf(needle) + skip, lines = text.slice(0, offset).split('\n');
    return { line: lines.length - 1, character: lines.at(-1).length };
  };
  const definition = (needle, skip = 0) => service.feature('textDocument/definition', { textDocument: { uri }, position: at(needle, skip) });
  service.bindModel(uri, roots[0]);
  assert.deepEqual(service.document(uri).diagnostics, []);
  assert.ok(definition('fmc.core.Child').uri.endsWith('/first/base.yambl'));
  assert.ok(definition('amount').uri.endsWith('/first/base.yambl'));
  assert.ok(definition('label').uri.endsWith('/first/extra.yambl'));
  assert.ok(definition('Child.label', 6).uri.endsWith('/first/extra.yambl'));
  assert.ok(definition("id='x'").uri.endsWith('/first/base.yambl'));
  const extraUri = pathToFileURL(path.join(roots[0], 'extra.yambl')).href;
  service.open.set(extraUri, { text: 'namespace core extend Child { static attr renamed: string }', version: 2 }); service.refresh();
  assert.equal(definition('label'), null);
  service.bindModel(uri, roots[1]);
  assert.ok(definition('label').uri.endsWith('/second/extra.yambl'));
  assert.throws(() => service.bindModel(uri, directory));
  assert.ok(definition('label').uri.endsWith('/second/extra.yambl'));
  const configUri = pathToFileURL(path.join(roots[1], 'yambl-root.lclcfg')).href;
  service.open.set(configUri, { text: "prefix: 'other'", version: 1 }); service.refresh();
  assert.equal(definition('fmc.core.Child'), null);
  service.open.delete(configUri); service.refresh();
  assert.ok(definition('fmc.core.Child'));
  service.bindModel(uri, null);
  assert.equal(definition('fmc.core.Child'), null);
  assert.equal(service.document(extraUri).diagnostics.length, 0);
});

test('bound completion filters operation columns and offers dimension and temporal coordinates', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-transaction-completion-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.writeFileSync(path.join(root, 'yambl-root.lclcfg'), "prefix: ''\n");
  fs.writeFileSync(path.join(root, 'model.yambl'), `namespace core
type amount = decimal
entity A {
    id id: integer
    static attr name: string
    config attr limit: amount
    static attr members: collection<A>
    dimension prices { value source: string }
    @dimension(prices)
    @temporal(day: date)
    snapshot attr price: amount
    @temporal(day: date)
    scd attr rate: amount
    computed attr doubled: amount { return self.limit::value * 2 }
}`);
  const service = new Service(() => {}), uri = 'untitled:completion-plan';
  service.bindModel(uri, root);
  function complete(header) {
    const text = cases[0].text.replace('group first {', 'group first {\n' + header);
    const offset = text.indexOf(header) + header.length, lines = text.slice(0, offset).split('\n');
    service.open.set(uri, { text, languageId: 'yaplan', version: 1 }); service.refresh();
    return service.feature('textDocument/completion', { textDocument: { uri }, position: { line: lines.length - 1, character: lines.at(-1).length } }).items.map(i => i.label);
  }
  assert.deepEqual(complete('update core.A ('), ['id', 'name', 'limit']);
  assert.deepEqual(complete('insert core.A (id, '), ['name', 'limit']);
  assert.deepEqual(complete('delete core.A ('), ['id']);
  assert.deepEqual(complete('replace core.A.price scope ('), ['id', 'source', 'day']);
  assert.deepEqual(complete('replace core.A.price scope (id=1, '), ['source', 'day']);
  assert.deepEqual(complete('replace core.A.price scope (id=1) columns ('), ['source', 'day', 'value']);
  assert.deepEqual(complete('replace core.A.rate scope (id=1) columns ('), ['valid_from', 'valid_to', 'value']);
  assert.ok(complete('replace core.A.').includes('core.A.price'));
  assert.ok(!complete('replace core.A.').includes('core.A.doubled'));
  assert.deepEqual(complete("replace core.A.price scope (source='unfinished"), []);
  assert.deepEqual(complete('# update core.A ('), []);
});
