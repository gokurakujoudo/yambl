'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Service, rootFor, sources, inside, uriKey } = require('../service.cjs');

test('repository discovery, unsaved dependencies, definitions, hover, symbols and close', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-lsp-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const write = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return pathToFileURL(file).href; };
  write('yambl-root.lclcfg', 'prefix: "do not execute"');
  const base = write('core/base.yambl', "namespace core @title('Base title') entity Base { id item_id: string }");
  const child = write('core/child.yambl', 'namespace core entity Child inherits Base { attr kind: code<Kinds> }');
  const dictionary = write('odd/kinds.yambl', 'namespace core decodes Kinds {}');
  const editorUri = process.platform === 'win32' ? child.replace(/file:\/\/\/([A-Z]):/, (_, drive) => `file:///${drive.toLowerCase()}%3A`) : child;
  assert.equal(uriKey(editorUri), uriKey(child));
  write('venv/ignored.yambl', '?'); write('.hidden/ignored.yambl', '?'); write('node_modules/ignored.yambl', '?');
  assert.equal(sources(root).length, 3); assert.equal(rootFor(child), root);
  assert.equal(inside(root, child), true); assert.equal(inside(root, 'untitled:one'), false);
  const published = []; const service = new Service((method, params) => published.push({ method, ...params }));
  service.open.set(editorUri, { text: fs.readFileSync(new URL(child), 'utf8'), version: 1 }); service.refresh();
  assert.equal(service.documents.size, 3);
  assert.ok([...service.documents.values()].every(d => !d.diagnostics.length));
  const doc = service.document(child); const parent = doc.declarations[0].parent;
  const params = { textDocument: { uri: child }, position: parent.range.start };
  assert.equal(uriKey(service.feature('textDocument/definition', params).uri), uriKey(base));
  assert.ok(service.feature('textDocument/hover', params).contents.value.includes('Base title'));
  assert.ok(service.feature('textDocument/completion', params).items.some(i => i.label === 'Kinds'));
  assert.equal(service.feature('textDocument/documentSymbol', params)[0].children[0].name, 'kind');
  const edits = service.feature('textDocument/formatting', params); assert.equal(edits.length, 1);
  assert.ok(edits[0].newText.endsWith('\n'));
  service.open.set(dictionary, { text: 'namespace core decodes OtherKinds {}', version: 2 }); service.refresh();
  assert.equal(service.document(child).diagnostics[0].message, 'undefined Decodes: Kinds');
  service.open.delete(dictionary); service.refresh(); assert.equal(service.document(child).diagnostics.length, 0);
  fs.unlinkSync(new URL(dictionary)); service.refresh(); assert.equal(service.document(child).diagnostics[0].severity, 2);
  service.open.clear(); service.refresh();
  assert.equal(published.at(-1).diagnostics.length, 0); assert.equal(service.documents.size, 0);
});
test('untitled buffers and syntax failures do not produce unsafe formatting edits', () => {
  const service = new Service(() => {}); const uri = 'untitled:Untitled-1';
  service.open.set(uri, { text: 'entity A { attr x:', version: 1 }); service.refresh();
  assert.equal(rootFor(uri), null);
  assert.equal(service.document(uri).diagnostics[0].severity, 1);
  assert.deepEqual(service.feature('textDocument/formatting', { textDocument: { uri } }), []);
  assert.equal(service.feature('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: 0 } }), null);
  assert.equal(service.feature('textDocument/hover', { textDocument: { uri: 'missing' }, position: { line: 0, character: 0 } }), null);
});
test('separate repository roots do not merge equally named entities', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-roots-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const service = new Service(() => {});
  for (const folder of ['one', 'two']) {
    const dir = path.join(root, folder); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'yambl-root.lclcfg'), '');
    const uri = pathToFileURL(path.join(dir, 'a.yambl')).href;
    service.open.set(uri, { text: 'entity A {}', version: 1 });
  }
  service.refresh(); assert.equal(service.documents.size, 2);
  assert.ok([...service.documents.values()].every(d => !d.diagnostics.length));
});
