'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Service, rootFor, sources, inside, uriKey } = require('../service.cjs');

test('TimeZones members complete, hover and navigate from the builtins', () => {
  const service = new Service(() => {}), uri = 'untitled:time-zones';
  const text = 'type selected<a: code<TimeZones>> = string entity Event { attr zone: selected<TimeZones.AsiaShanghai> }';
  service.open.set(uri, { text, version: 1 }); service.refresh();
  assert.deepEqual(service.document(uri).diagnostics, []);
  const request = (method, character) => service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: 0, character } });
  const offset = text.indexOf('AsiaShanghai');
  assert.match(request('hover', offset).contents.value, /Asia\/Shanghai/);
  assert.match(request('definition', offset).uri, /time_zones\.yambl$/);
  const semantic = service.feature('textDocument/semanticTokens/full', { textDocument: { uri } }).data;
  let character = 0; const styled = [];
  for (let i = 0; i < semantic.length; i += 5) { character += semantic[i + 1]; styled.push(text.slice(character, character + semantic[i + 2])); }
  assert.ok(styled.includes('TimeZones'));
  const unfinished = text.replace('AsiaShanghai', '');
  service.open.set(uri, { text: unfinished, version: 2 }); service.refresh();
  const labels = request('completion', unfinished.indexOf('TimeZones.>') + 'TimeZones.'.length).items.map(item => item.label);
  assert.equal(labels.length, 39);
  assert.ok(labels.includes('AsiaShanghai'));
});

test('flags codes complete, hover and navigate through unions and generated None', () => {
  const service = new Service(() => {}), uri = 'untitled:flags';
  const text = "@flags decodes Rights { - 0b01 Read: 'Read' - 2 Write: 'Write' } type chosen<a: code<Rights>> = string entity A { attr x: chosen<Rights.Read + Rights.Write + Rights.None - Rights.All> }";
  service.open.set(uri, { text, version: 1 }); service.refresh();
  assert.deepEqual(service.document(uri).diagnostics, []);
  const request = (method, character) => service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: 0, character } });
  for (const name of ['Read', 'Write', 'None', 'All']) {
    const definition = request('definition', text.lastIndexOf(name));
    assert.equal(definition.uri, uri);
    assert.equal(definition.range.start.character, text.indexOf(['None', 'All'].includes(name) ? 'Rights' : name));
    assert.match(request('hover', text.lastIndexOf(name)).contents.value, name === 'None' ? /0 \(generated\)/ : new RegExp(name));
  }
  assert.match(request('hover', text.indexOf('flags')).contents.value, /single-bit/);
  assert.match(request('hover', text.indexOf('attr x') + 5).contents.value, /Rights.Read \+ Rights.Write \+ Rights.None/);
  const completions = request('completion', 0);
  assert.ok(completions.items.some(i => i.label === 'flags'));
  for (const suffix of ['', 'Wr', 'Write']) {
    const current = text.replace('Rights.Write', 'Rights.' + suffix);
    service.open.set(uri, { text: current, version: 2 }); service.refresh();
    const result = request('completion', current.indexOf(' + Rights.') + 10 + suffix.length);
    assert.deepEqual(result.items.map(i => i.label), ['Read', 'Write', 'None', 'All']);
  }
  for (const source of [
    'entity A { attr x: attrs<AttrCats.All - AttrCats., A> }',
    'entity A { attr x: attrs<AttrCats.Static + AttrCats.No, A> }',
  ]) {
    service.open.set(uri, { text: source, version: 3 }); service.refresh();
    const result = request('completion', source.indexOf(', A>'));
    assert.deepEqual(result.items.map(i => i.label), ['Static', 'Config', 'Snapshot', 'Scd', 'Computed', 'None', 'All']);
  }
  const ordinary = "decodes Codes { - 1 Read: 'Read' } type chosen<a: code<Codes>> = string entity A { attr x: chosen<Codes.> }";
  service.open.set(uri, { text: ordinary, version: 4 }); service.refresh();
  assert.deepEqual(request('completion', ordinary.indexOf('Codes.>') + 6).items.map(i => i.label), ['Read']);
});

test('relationship markers navigate across files and react to unsaved edits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-markers-')); t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  fs.writeFileSync(path.join(root, 'yambl-root.lclcfg'), "prefix: ''");
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
  const text = 'entity Base { config attr arbitrary: type<Entity> attr ignored: string } entity Child inherits Base {} extend Child { attr data: field_mapping<AttrCats.Config, self.arbitrary::value> }';
  service.open.set(uri, { text, version: 1 }); service.refresh();
  const definition = service.feature('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: text.lastIndexOf('arbitrary') } });
  assert.equal(definition.range.start.character, text.indexOf('arbitrary'));
  for (const suffix of ['arbitrary', '', 'arb']) {
    const current = text.replace('self.arbitrary', 'self.' + suffix);
    service.open.set(uri, { text: current, version: 2 }); service.refresh();
    const completions = service.feature('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: current.indexOf('self.') + 5 + suffix.length } });
    assert.deepEqual(completions.items.map(i => i.label), ['arbitrary', 'ignored', 'data', 'entity_type', 'root_entity_type']);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-lsp-')); t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  const write = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return pathToFileURL(file).href; };
  write('yambl-root.lclcfg', 'prefix: "demo"');
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
  assert.deepEqual(service.document(child).diagnostics.map(d => [d.severity, d.message]), [[1, 'undefined Decodes: Kinds']]);
  service.open.delete(dictionary); service.refresh(); assert.equal(service.document(child).diagnostics.length, 0);
  fs.unlinkSync(new URL(dictionary)); service.refresh(); assert.deepEqual(service.document(child).diagnostics.map(d => [d.severity, d.message]), [[1, 'undefined Decodes: Kinds']]);
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

test('missing bare dictionary is an error at its name and reacts to unsaved definitions', () => {
  const uri = 'untitled:fund', service = new Service(() => {});
  const source = '\n'.repeat(10) + 'entity PortfolioGroup {\n    attr portfolio_group_type: code<PortfolioGroupTypes>\n}\n';
  const refresh = text => { service.open.set(uri, { text, version: 1 }); service.refresh(); return service.document(uri); };
  let doc = refresh(source);
  assert.deepEqual(doc.diagnostics.map(d => [d.severity, d.message, d.range.start.line, d.range.start.character]), [[1, 'undefined Decodes: PortfolioGroupTypes', 11, 36]]);
  assert.equal(service.feature('textDocument/definition', { textDocument: { uri }, position: doc.diagnostics[0].range.start }), null);
  assert.deepEqual(refresh(source.replace('code<PortfolioGroupTypes>', "code<'PortfolioGroupTypes'>")).diagnostics, []);
  doc = refresh(source + 'decodes PortfolioGroupTypes {}\n');
  assert.deepEqual(doc.diagnostics, []);
  const definition = service.feature('textDocument/definition', { textDocument: { uri }, position: { line: 11, character: 36 } });
  assert.equal(definition.range.start.line, 13);
  assert.deepEqual(refresh(source).diagnostics.map(d => d.severity), [1]);
});

test('attribute hover includes metadata, modifiers and complete generic/parameter types', () => {
  const service = new Service(() => {}), uri = 'untitled:hover';
  service.open.set(uri, { version: 1, text: `entity A {
    @description('Security\\'s value')
    @title('Weights')
    snapshot attr weights: mapping<string[regex: '[A-Z]+'], decimal[precision: 18, scale: 4]>
    attr codes: values<code<'Currencies'>>
    attr plain: decimal[18, 4]
}` }); service.refresh();
  const doc = service.document(uri);
  const hover = field => service.feature('textDocument/hover', { textDocument: { uri }, position: field.name.range.start }).contents.value;
  assert.equal(hover(doc.declarations[0].fields[0]), "snapshot attr weights: mapping<string[regex: '[A-Z]+'], decimal[precision: 18, scale: 4]>\n\ntitle: Weights\n\ndescription: Security's value");
  assert.equal(hover(doc.declarations[0].fields[1]), "static attr codes: values<code<'Currencies'>>");
  assert.equal(hover(doc.declarations[0].fields[2]), 'static attr plain: decimal[18, 4]');
});

test('Decodes references follow symbol identity and quoted names retain string styling', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-references-')); t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  const write = (name, text) => { const file = path.join(root, name); fs.writeFileSync(file, text); return pathToFileURL(file).href; };
  write('yambl-root.lclcfg', "prefix: ''");
  const dictionary = write('decodes.yambl', 'namespace dict decodes Currencies {}');
  const source = `namespace core from dict import Currencies entity A {
    attr code: code<Currencies>
    dimension sources { value source: code<'Currencies'> } @dimension(sources)
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-roots-')); t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  const service = new Service(() => {});
  for (const folder of ['one', 'two']) {
    const dir = path.join(root, folder); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'yambl-root.lclcfg'), "prefix: ''");
    const uri = pathToFileURL(path.join(dir, 'a.yambl')).href;
    service.open.set(uri, { text: 'entity A {}', version: 1 });
  }
  service.refresh(); assert.equal(service.documents.size, 2);
  assert.ok([...service.documents.values()].every(d => !d.diagnostics.length));
});


test('prefixes, unsaved root configuration and nested repository errors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-prefix-')); t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  const write = (name, text) => { const filename = path.join(root, name); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, text); return pathToFileURL(filename).href; };
  const config = write('yambl-root.lclcfg', "prefix: 'demo'");
  const value = write('values/a.yambl', 'namespace types value item_record { attr x: string }');
  const text = 'namespace core from types import item_record entity A { attr x: item_record attr h: Hierarchy }';
  const uri = write('core/a.yambl', text);
  const published = [], service = new Service((method, params) => published.push(params));
  service.open.set(uri, { version: 1, text }); service.refresh();
  assert.equal(service.document(uri).prefix, 'demo');
  assert.deepEqual(service.document(uri).diagnostics, []);
  const params = { textDocument: { uri }, position: { line: 0, character: text.lastIndexOf('item_record') } };
  assert.equal(service.feature('textDocument/definition', params).uri, value);
  assert.ok(service.feature('textDocument/hover', params).contents.value.includes('value item_record'));
  const semantic = service.feature('textDocument/semanticTokens/full', params).data;
  assert.ok(semantic.length > 0);
  service.open.set(config, { version: 2, text: "prefix: 'changed'" }); service.refresh();
  assert.equal(service.document(uri).prefix, 'changed');
  assert.deepEqual(service.document(uri).diagnostics, []);
  service.open.set(config, { version: 3, text: "prefix: 'demo'\nprefix: 'other'" }); service.refresh();
  assert.equal(service.document(config).diagnostics[0].range.start.line, 1);
  assert.match(service.document(config).diagnostics[0].message, /one literal prefix/);
  service.open.delete(config); service.refresh();
  assert.ok(published.some(p => p.uri === config && p.diagnostics.length === 0));
  const nested = write('child/yambl-root.lclcfg', "prefix: ''"); service.refresh();
  assert.match(service.document(nested).diagnostics[0].message, /nested or multiple/);
  assert.throws(() => sources(root), /nested or multiple/);
});

test('Markdown blocks suppress language features and values navigate by identity', () => {
  const uri = 'untitled:value', service = new Service(() => {});
  const text = '---\nvalue fake {}\n---\nvalue amount { attr x: decimal }\nentity A { attr a: amount }';
  service.open.set(uri, { version: 1, text }); service.refresh();
  for (const method of ['hover', 'definition', 'completion']) {
    assert.equal(service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: 1, character: 1 } }), null);
  }
  const params = { textDocument: { uri }, position: { line: 4, character: 20 } };
  assert.equal(service.feature('textDocument/definition', params).range.start.line, 3);
  assert.equal(service.feature('textDocument/documentSymbol', params)[0].children[0].name, 'x');
  assert.ok(service.feature('textDocument/completion', params).items.some(i => i.label === 'hierarchy_entry'));
});

test('built-in model repository checks its own declarations exactly once', () => {
  const { modelRoot } = require('../language/relationships.cjs');
  const uri = pathToFileURL(path.join(modelRoot, 'models/hierarchy.yambl')).href;
  const service = new Service(() => {});
  service.open.set(uri, { version: 1, text: fs.readFileSync(new URL(uri), 'utf8') }); service.refresh();
  assert.equal(service.documents.size, 8);
  assert.ok([...service.documents.values()].every(doc => doc.diagnostics.length === 0));
});

test('literal configuration grammar rejects expressions and missing prefixes', () => {
  const { readPrefix } = require('../repository.cjs');
  assert.throws(() => readPrefix(path.join(os.tmpdir(), 'absent-yambl-config-' + process.pid)), /Cannot read root configuration/);
  assert.equal(readPrefix('root.lclcfg', '# Comment\n\nprefix: "demo.data" # inline'), 'demo.data');
  for (const text of ['', '# Comment', 'other: ""', 'prefix: 1', "prefix: 'x' + 'y'", "prefix: 'bad..name'", "prefix: ''\nprefix: ''"]) {
    assert.throws(() => readPrefix('root.lclcfg', text), /prefix/);
  }
});

test('type aliases, bound field descriptions and nested paths navigate and complete', () => {
  const uri = 'untitled:expressions', service = new Service(() => {});
  const text = `type money = decimal
entity Security { attr amount: money }
entity Selection {
    attr security: Security
    attr amount: self.security::value.amount::type
    attr selected: mapping<attrs<AttrCats.Static, Security> as Attr, Attr::type>
}`;
  service.open.set(uri, { text, version: 1 }); service.refresh();
  assert.deepEqual(service.document(uri).diagnostics, []);
  const feature = (name, line, character) => service.feature('textDocument/' + name, { textDocument: { uri }, position: { line, character } });
  assert.equal(feature('definition', 1, text.split('\n')[1].indexOf('money')).range.start.line, 0);
  assert.match(feature('hover', 1, text.split('\n')[1].indexOf('money')).contents.value, /type money = decimal/);
  assert.equal(feature('definition', 4, text.split('\n')[4].lastIndexOf('amount')).range.start.line, 1);
  const line = text.split('\n')[5];
  assert.equal(feature('definition', 5, line.lastIndexOf('Attr')).range.start.character, line.indexOf('as Attr') + 3);
  assert.ok(feature('semanticTokens/full').data.length > 0);
  for (const suffix of ['', 'amo', 'amount']) {
    const current = text.replace('self.security::value.amount::type', 'self.security::value.' + suffix + '::type');
    service.open.set(uri, { text: current, version: 2 }); service.refresh();
    const col = current.split('\n')[4].indexOf('self.security::value.') + 'self.security::value.'.length + suffix.length;
    assert.deepEqual(feature('completion', 4, col).items.map(i => i.label), ['amount', 'entity_type', 'root_entity_type']);
  }
  const col = text.split('\n')[4].indexOf('::type') + 2;
  assert.deepEqual(feature('completion', 4, col).items.map(i => i.label), ['type', 'value', 'entity']);
});

test('builtins authoring works outside the extension resource directory', t => {
  const { modelRoot } = require('../language/relationships.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-builtins-checkout-'));
  t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  fs.cpSync(modelRoot, root, { recursive: true });
  const uri = pathToFileURL(path.join(root, 'models/hierarchy.yambl')).href;
  const service = new Service(() => {});
  const text = fs.readFileSync(new URL(uri), 'utf8');
  service.open.set(uri, { version: 1, text }); service.refresh();
  assert.equal(service.documents.size, 8);
  assert.ok([...service.documents.values()].every(d => !d.diagnostics.length));
  const doc = service.document(uri), field = doc.declarations[0].fields[1];
  const params = { textDocument: { uri }, position: field.type.args[0].token.range.start };
  assert.equal(service.feature('textDocument/definition', params).uri, uri);
  assert.ok(service.feature('textDocument/hover', params).contents.value.includes('value hierarchy_entry'));
  assert.equal(service.references(doc.declarations[1], false).length, 1);
  const duplicate = path.join(root, 'duplicate.yambl');
  fs.writeFileSync(duplicate, 'namespace builtins final entity Hierarchy {}'); service.refresh();
  assert.ok([...service.documents.values()].some(d => d.diagnostics.some(x => /duplicate or reserved declaration: Hierarchy/.test(x.message))));
  fs.unlinkSync(duplicate);
  service.open.set(uri, { version: 2, text: text.replace('namespace builtins', 'namespace business') }); service.refresh();
  assert.ok(service.document(uri).diagnostics.some(d => /duplicate or reserved declaration: Hierarchy/.test(d.message)));
  service.open.set(uri, { version: 3, text });
  fs.writeFileSync(path.join(root, 'yambl-root.lclcfg'), "prefix: 'demo'"); service.refresh();
  assert.ok(service.document(uri).diagnostics.some(d => /duplicate or reserved declaration: Hierarchy/.test(d.message)));
});


test('subtype dictionaries provide completion, hover and declaration navigation', () => {
  const service = new Service(() => {}), uri = 'untitled:subtypes';
  const text = 'entity Root {} entity Child inherits Root {} entity Use { attr choice: code<Root::subtypes> computed attr result: code<Root::subtypes> { return Root::subtypes.Child } }';
  service.open.set(uri, { text, version: 1 }); service.refresh();
  assert.deepEqual(service.document(uri).diagnostics, []);
  const feature = (method, offset) => service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: 0, character: offset } });
  const descriptor = text.indexOf('Root::subtypes') + 'Root::'.length;
  assert.deepEqual(feature('completion', descriptor).items.map(i => i.label), ['subtypes']);
  const member = text.lastIndexOf('.Child') + 1;
  assert.deepEqual(feature('completion', member).items.map(i => i.label), ['Child']);
  assert.equal(feature('definition', member).range.start.character, text.indexOf('Child'));
  assert.match(feature('hover', member).contents.value, /Child/);
  assert.match(feature('hover', descriptor).contents.value, /strict descendant/);
  const incomplete = 'entity Root {} entity Child inherits Root {} entity Use { attr x: code<Root::';
  service.open.set(uri, { text: incomplete, version: 2 }); service.refresh();
  assert.deepEqual(feature('completion', incomplete.length).items.map(i => i.label), ['subtypes']);
});
