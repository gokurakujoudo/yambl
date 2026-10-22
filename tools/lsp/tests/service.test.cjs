'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Service, rootFor, sources, inside, uriKey } = require('../service.cjs');

test('relationship markers navigate across files and react to unsaved edits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-markers-')); t.after(() => fs.rmSync(root, { recursive: true }));
  fs.writeFileSync(path.join(root, 'yambl-root.lclcfg'), '');
  const sources = {
    'base.yambl': 'namespace core entity Base { config attr days: integer = 20 }',
    'left.yambl': 'namespace core entity Left inherits Base { @overload config attr category: integer = 1 @override config attr days: integer = 10 }',
    'right.yambl': 'namespace core entity Right inherits Base { @overload config attr category: integer = 2 }',
    'deep.yambl': 'namespace core entity Deep inherits Left { @override config attr days: integer = 5 }',
  };
  const service = new Service(() => {});
  const uris = Object.fromEntries(Object.keys(sources).map(name => [name, pathToFileURL(path.join(root, name)).href]));
  for (const [name, text] of Object.entries(sources)) fs.writeFileSync(new URL(uris[name]), text);
  service.open.set(uris['left.yambl'], { text: sources['left.yambl'], version: 1 }); service.refresh();
  const definition = (file, marker) => {
    const doc = service.document(uris[file]);
    return service.feature('textDocument/definition', { textDocument: { uri: doc.uri }, position: { line: 0, character: doc.text.indexOf('@' + marker) + 1 } });
  };
  assert.equal(definition('left.yambl', 'overload')[0].uri, uris['right.yambl']);
  assert.equal(definition('left.yambl', 'override')[0].uri, uris['base.yambl']);
  assert.equal(definition('deep.yambl', 'override')[0].uri, uris['left.yambl']);
  service.open.set(uris['right.yambl'], { text: sources['right.yambl'].replace('integer', 'string').replace('= 2', "= 'x'"), version: 2 }); service.refresh();
  assert.equal(definition('left.yambl', 'overload'), null);
  assert.ok(service.document(uris['left.yambl']).diagnostics.some(d => d.message.includes('identical signatures')));
  service.open.set(uris['right.yambl'], { text: sources['right.yambl'], version: 3 }); service.refresh();
  assert.equal(definition('left.yambl', 'overload')[0].uri, uris['right.yambl']);
});

test('self navigation and completion accept arbitrary type fields and incomplete references', () => {
  const service = new Service(() => {}), uri = 'untitled:selection';
  const text = 'entity Base { config attr arbitrary: type<Entity> attr ignored: string } entity Child inherits Base {} extend Child { attr data: field_mapping<config, self.arbitrary> }';
  service.open.set(uri, { text, version: 1 }); service.refresh();
  const definition = service.feature('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: text.lastIndexOf('arbitrary') } });
  assert.equal(definition.range.start.character, text.indexOf('arbitrary'));
  for (const suffix of ['arbitrary', '', 'arb']) {
    const current = text.replace('self.arbitrary', 'self.' + suffix);
    service.open.set(uri, { text: current, version: 2 }); service.refresh();
    const completions = service.feature('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: current.indexOf('self.') + 5 + suffix.length } });
    assert.deepEqual(completions.items.map(i => i.label), ['arbitrary']);
  }
  const completions = service.feature('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 0 } });
  for (const label of ['final', 'static', 'self', 'type', 'field_mapping', 'Entity', 'ConfigGroup', 'overload', 'override']) assert.ok(completions.items.some(i => i.label === label), label);
});

test('invalid field declarations do not offer marker navigation', () => {
  const service = new Service(() => {}), uri = 'untitled:invalid';
  for (const field of ['@overload @overload attr x: string', "@overload @title('a') @title('a') attr x: string", '@overload attr x: Missing']) {
    const text = `entity Base {} entity A inherits Base { ${field} } entity B inherits Base { @overload attr x: string }`;
    service.open.set(uri, { text, version: 1 }); service.refresh();
    const result = service.feature('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: text.lastIndexOf('@overload') + 1 } });
    assert.equal(result, null);
  }
});

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
  assert.deepEqual(service.document(child).diagnostics, []);
  service.open.delete(dictionary); service.refresh(); assert.equal(service.document(child).diagnostics.length, 0);
  fs.unlinkSync(new URL(dictionary)); service.refresh(); assert.deepEqual(service.document(child).diagnostics, []);
  service.open.clear(); service.refresh();
  assert.equal(published.at(-1).diagnostics.length, 0); assert.equal(service.documents.size, 0);
});

test('dynamic Decodes are silent, while unresolved types and explicit imports still fail', () => {
  const published = []; const service = new Service((_, params) => published.push(params));
  const uri = 'untitled:dynamic';
  service.open.set(uri, { version: 1, text: "from absent import Currencies entity A { attr x: code<'Currencies'> attr y: Missing }" });
  service.refresh();
  assert.deepEqual(service.document(uri).diagnostics.map(d => d.message), ['unknown import: absent.Currencies', 'unknown type: Missing']);
  assert.ok(published.at(-1).diagnostics.every(d => d.severity === 1));
});

test('attribute hover includes metadata, modifiers and complete generic/parameter types', () => {
  const service = new Service(() => {}), uri = 'untitled:hover';
  service.open.set(uri, { version: 1, text: `entity A {
    @description('Security\\'s value')
    @title('Weights')
    snapshot attr weights: map<string[regex: '[A-Z]+'], decimal[precision: 18, scale: 4]>
    attr codes: values<code<'Currencies'>>
    attr plain: decimal[18, 4]
}` }); service.refresh();
  const doc = service.document(uri);
  const hover = field => service.feature('textDocument/hover', { textDocument: { uri }, position: field.name.range.start }).contents.value;
  assert.equal(hover(doc.declarations[0].fields[0]), "snapshot attr weights: map<string[regex: '[A-Z]+'], decimal[precision: 18, scale: 4]>\n\ntitle: Weights\n\ndescription: Security's value");
  assert.equal(hover(doc.declarations[0].fields[1]), "attr codes: values<code<'Currencies'>>");
  assert.equal(hover(doc.declarations[0].fields[2]), 'attr plain: decimal[18, 4]');
});

test('Decodes references follow symbol identity and quoted names retain string styling', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-references-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const write = (name, text) => { const file = path.join(root, name); fs.writeFileSync(file, text); return pathToFileURL(file).href; };
  write('yambl-root.lclcfg', '');
  const dictionary = write('decodes.yambl', 'namespace dict decodes Currencies {}');
  const source = `namespace core from dict import Currencies entity A {
    attr code: code<Currencies>
    @dimensions(source: code<'Currencies'>)
    snapshot attr value: decimal[18, 4]
    attr many: values<code<'Currencies'>>
    attr dynamic: code<'Outside'>
    attr dynamic_name: code<Outside>
}`;
  const model = write('model.yambl', source);
  write('other.yambl', 'namespace other decodes Currencies {} entity Other { attr x: code<Currencies> }');
  write('unimported.yambl', 'namespace core entity Unimported { attr x: code<Currencies> }');
  const service = new Service(() => {}); service.open.set(model, { version: 1, text: source }); service.refresh();
  const declaration = service.document(dictionary).declarations[0];
  const params = { textDocument: { uri: dictionary }, position: declaration.name.range.start, context: { includeDeclaration: false } };
  const refs = service.feature('textDocument/references', params);
  assert.equal(refs.length, 4); assert.ok(refs.every(r => uriKey(r.uri) === uriKey(model)));
  assert.equal(service.feature('textDocument/references', { ...params, context: { includeDeclaration: true } }).length, 5);
  assert.equal(uriKey(service.feature('textDocument/definition', params).uri), uriKey(dictionary));
  const tokens = service.feature('textDocument/semanticTokens/full', { textDocument: { uri: model } }).data;
  const lines = source.split('\n'); const styled = []; let line = 0, character = 0;
  for (let i = 0; i < tokens.length; i += 5) {
    character = tokens[i] === 0 ? character + tokens[i + 1] : tokens[i + 1]; line += tokens[i];
    styled.push(lines[line].slice(character, character + tokens[i + 2])); assert.equal(tokens[i + 3], 0);
  }
  assert.equal(styled.filter(x => x === 'Currencies').length, 2);
  assert.ok(styled.includes('decimal'));
  assert.equal(styled.filter(x => x === 'Outside').length, 1);
  assert.equal(service.feature('textDocument/semanticTokens/full', params).data[2], 'Currencies'.length);
  service.open.set(model, { version: 2, text: 'namespace core entity A {}' }); service.refresh();
  assert.deepEqual(service.feature('textDocument/references', params), []);
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
