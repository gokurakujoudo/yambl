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
const typeCases = require('./transaction-type-cases.json');

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

test('shared runtime/editor type cases use aliases, exact constraints and reference IDs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-transaction-types-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.writeFileSync(path.join(root, 'yambl-root.lclcfg'), "prefix: ''\n");
  fs.writeFileSync(path.join(root, 'model.yambl'), typeCases.model);
  const service = new Service(() => {}), uri = 'untitled:type-plan';
  service.bindModel(uri, root);
  for (const item of typeCases.cases) {
    const text = cases[0].text.replace('group first {', `group first {\nupdate ${item.entity} (id, ${item.field}) {\n1, ${item.literal}\n}`);
    service.open.set(uri, { text, languageId: 'yaplan', version: 1 }); service.refresh();
    const doc = service.document(uri);
    assert.equal(doc.diagnostics.length === 0, item.valid, JSON.stringify(item) + ': ' + JSON.stringify(doc.diagnostics));
    assert.ok(format(doc), 'type errors must not block formatting');
  }
});

test('FMC static plan passes model-bound type checks', () => {
  const root = path.resolve(__dirname, '../../../../../fmc-data-model'), uri = 'untitled:typed-fmc';
  const service = new Service(() => {});
  service.open.set(uri, { text: fs.readFileSync(path.join(root, 'examples/demo.yaplan'), 'utf8'), languageId: 'yaplan', version: 1 });
  service.bindModel(uri, root);
  assert.deepEqual(service.document(uri).diagnostics, []);
});

test('operation and scope diagnostics validate final syntax without looking up instances', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-transaction-scopes-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.writeFileSync(path.join(root, 'yambl-root.lclcfg'), "prefix: ''\n");
  fs.writeFileSync(path.join(root, 'model.yambl'), typeCases.model + `
extend Item {
    dimension sources { value source: string }
    @dimension(sources)
    @temporal(day: date)
    snapshot attr price: money
    @temporal(day: date)
    scd attr rating: string
    static attr members: collection<Item>
    computed attr doubled: money { return self.amount::value * 2 }
}`);
  const service = new Service(() => {}), uri = 'untitled:scope-plan';
  service.bindModel(uri, root);
  const diagnose = operation => {
    const text = cases[0].text.replace('group first {', 'group first {\n' + operation);
    service.open.set(uri, { text, languageId: 'yaplan', version: 1 }); service.refresh();
    return service.document(uri).diagnostics;
  };
  for (const operation of [
    "update core.Item (id, amount) {\n99999999, NO_ENTRY\n}",
    "replace core.Item.price scope (id=1, source='manual', day in ['2026-01-01', '2026-02-01')) columns (day, value) {\n'2026-01-05', 1.50\n}",
    "replace core.Item.rating scope (id=1) columns (valid_from, valid_to, value) {\n'2026-01-01', '2026-02-01', 'A'\n}",
    'replace core.Item.members scope (id=1) columns (value) {\n[2, 3]\n}',
    'delete core.Item.price scope (id=1)',
  ]) assert.deepEqual(diagnose(operation), [], operation);
  for (const [operation, message] of [
    ['insert missing.Item (id) {\n1\n}', /unknown entity/],
    ['update core.Item (missing) {\n1\n}', /unknown field/],
    ['update core.Item (amount) {\n1\n}', /ID column/],
    ['delete core.Item (id, amount) {\n1, 2\n}', /not writable/],
    ['update core.Item (id, doubled) {\n1, 2\n}', /not writable/],
    ['update core.Item (id, members) {\n1, [2]\n}', /scope/],
    ['update core.Item.amount (id, value) {\n1, 2\n}', /field operations/],
    ['delete core.Item.id scope (id=1)', /not writable/],
    ['delete core.Item scope (id=1)', /field target/],
    ['delete core.Item.price scope (source=1)', /owner ID/],
    ["delete core.Item.price scope (id=1, day='2026-01-01')", /half-open/],
    ["delete core.Item.price scope (id=1, day in ['2026-02-01', '2026-01-01'))", /half-open/],
    ['delete core.Item.price scope (id=1, source=2)', /string literal/],
    ['delete core.Item.price scope (id=1, unknown=2)', /scope coordinate/],
    ['replace core.Item.price scope (id=1) columns (value) {\n2\n}', /missing replacement column/],
    ['replace core.Item.amount scope (id=1) columns (value, extra) {\n2, 3\n}', /unknown replacement column/],
    ["replace core.Item.members scope (id=1) columns (value) {\n['2']\n}", /integer literal/],
  ]) assert.ok(diagnose(operation).some(d => message.test(d.message)), operation + ': ' + JSON.stringify(diagnose(operation)));
});

test('ConfigGroup maps check field categories, payload types and known target trees', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-transaction-config-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.writeFileSync(path.join(root, 'yambl-root.lclcfg'), "prefix: ''\n");
  fs.writeFileSync(path.join(root, 'model.yambl'), typeCases.model + 'extend Item { config attr limit: integer } entity Other { id id: string config attr limit: integer }');
  const service = new Service(() => {}), uri = 'untitled:config-plan';
  service.bindModel(uri, root);
  const diagnose = (field, value) => {
    const body = `insert builtins.ConfigGroup (config_group_id, priority, entity_type) {\n'g', 1, core.Item\n}\nreplace builtins.ConfigGroup.${field} scope (config_group_id='g') columns (value) {\n${value}\n}`;
    service.open.set(uri, { text: cases[0].text.replace('group first {', 'group first {\n' + body), languageId: 'yaplan', version: 1 }); service.refresh();
    return service.document(uri).diagnostics;
  };
  for (const [field, value] of [['when', '{core.Item.count: 2}'], ['then_set', "{'core.Item.limit': 3}"], ['when', '{}']]) assert.deepEqual(diagnose(field, value), []);
  for (const [field, value, error] of [
    ['when', '{core.Item.limit: 2}', /static fields/],
    ['then_set', '{core.Item.count: 2}', /config fields/],
    ['then_set', "{core.Item.limit: '2'}", /integer literal/],
    ['then_set', '{core.Other.limit: 2}', /inheritance tree/],
    ['when', '{core.Item.count: 2, core.Item.count: 3}', /unique field names/],
    ['when', '[]', /mapping object/],
  ]) assert.ok(diagnose(field, value).some(d => error.test(d.message)), JSON.stringify([field, value, diagnose(field, value)]));
});

test('sealed transaction images validate their types and navigate field coordinates', t => {
  const fixture = require('./transaction-image-cases.json');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-transaction-images-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.writeFileSync(path.join(root, 'yambl-root.lclcfg'), "prefix: ''\n");
  fs.writeFileSync(path.join(root, 'model.yambl'), fixture.model);
  const service = new Service(() => {}), uri = 'untitled:images';
  service.bindModel(uri, root);
  for (const item of fixture.cases) {
    service.open.set(uri, { text: item.text, languageId: 'yatran', version: 1 }); service.refresh();
    const doc = service.document(uri);
    assert.equal(doc.syntaxErrors, 0, item.name);
    if (item.error) assert.ok(doc.diagnostics.some(d => d.message.includes(item.error)), JSON.stringify(doc.diagnostics));
    else {
      assert.deepEqual(doc.diagnostics, []);
      for (const [needle, skip, definition] of [['day in', 0, 'day: date'], ['before core.Item.price', 17, 'price: money'], ['(id, day, value)', 5, 'day: date'], ['(id, day, value)', 10, 'price: money']]) {
        const lines = item.text.slice(0, item.text.indexOf(needle) + skip).split('\n');
        const location = service.feature('textDocument/definition', { textDocument: { uri }, position: { line: lines.length - 1, character: lines.at(-1).length } });
        assert.ok(location, needle);
        const source = fixture.model.split('\n')[location.range.start.line].slice(location.range.start.character);
        assert.ok(source.startsWith(definition), source);
      }
    }
    const formatted = format(doc);
    assert.equal(parse(formatted).ast.digest, doc.ast.digest);
  }
});
