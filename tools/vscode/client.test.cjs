'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL, fileURLToPath } = require('node:url');

test('VS Code adapters retain snippets, named insertions and live signature help', async () => {
  const providers = new Map(), disposable = () => ({ dispose() {} });
  class MarkdownString { appendText(value) { this.value = value; return this; } }
  class CompletionItem { constructor(label, kind) { Object.assign(this, { label, kind }); } }
  class SnippetString { constructor(value) { this.value = value; } }
  class Information { constructor(label, documentation) { Object.assign(this, { label, documentation }); } }
  const vscode = {
    MarkdownString, CompletionItem, SnippetString,
    SignatureHelp: class {}, SignatureInformation: Information, ParameterInformation: Information,
    Range: class { constructor(...coordinates) { this.coordinates = coordinates; } },
    Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
    Hover: class { constructor(contents, range) { Object.assign(this, { contents, range }); } },
    Diagnostic: class {}, SemanticTokensLegend: class {},
    EventEmitter: class { fire() {} dispose() {} },
    Uri: { parse: value => value },
    window: { createOutputChannel: () => ({ ...disposable(), append() {}, appendLine() {} }) },
    languages: new Proxy({ createDiagnosticCollection: () => ({ ...disposable(), clear() {}, set() {} }) }, {
      get(target, name) {
        return target[name] || ((selector, provider, ...triggers) => {
          providers.set(name, { provider, triggers, selector }); return disposable();
        });
      },
    }),
    workspace: {
      textDocuments: [], onDidOpenTextDocument: disposable, onDidChangeTextDocument: disposable,
      onDidCloseTextDocument: disposable, onDidSaveTextDocument: disposable,
      createFileSystemWatcher: () => ({ ...disposable(), onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable }),
    },
  };
  const module = { exports: {} }, subscriptions = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'extension.cjs'), 'utf8'), {
    require: name => name === 'vscode' ? vscode : require(name),
    module, __dirname, process, console, setTimeout, clearTimeout, Buffer,
  });
  try {
    await module.exports.activate({ subscriptions });
    const text = 'entity E { snapshot attr n: integer computed attr x: integer { return self.n::value() } }';
    const doc = { languageId: 'yambl', uri: { toString: () => 'untitled:client-test' }, version: 1, getText: () => text };
    const position = { line: 0, character: text.indexOf('::value(') + 8 };
    const completion = providers.get('registerCompletionItemProvider');
    assert.deepEqual(Array.from(completion.selector, s => s.language), ['yambl', 'yambl', 'yaplan', 'yaplan', 'yatran', 'yatran']);
    assert.ok(completion.triggers.includes(':'));
    const items = await completion.provider.provideCompletionItems(doc, position);
    assert.equal(items.find(i => i.label === 'as_of_date').insertText, 'as_of_date=');
    const signature = await providers.get('registerSignatureHelpProvider').provider.provideSignatureHelp(doc, position);
    assert.match(signature.signatures[0].label, /as_of_date: date/);
    const localItems = await completion.provider.provideCompletionItems(doc, { line: 0, character: text.indexOf('return') + 7 });
    assert.equal(localItems.find(i => i.label === 'input').insertText.value, 'input.${1:name}');
    for (const languageId of ['yaplan', 'yatran']) {
      const entry = require('./lsp/tests/transaction-cases.json').find(c => c.name === (languageId === 'yaplan' ? 'empty plan' : 'sealed transaction'));
      const document = { languageId, uri: { toString: () => 'untitled:client-' + languageId }, version: 1, getText: () => entry.text };
      const items = await completion.provider.provideCompletionItems(document, { line: 0, character: 0 });
      assert.ok(items.some(item => item.label === 'scope'));
    }

    // Drive the shipped client against the real FMC repository and LSP process.
    const filename = path.resolve(__dirname, '../../../fmc-data-model/core/computations.yambl');
    const original = fs.readFileSync(filename, 'utf8');
    let current = original;
    const fmc = { languageId: 'yambl', uri: { toString: () => pathToFileURL(filename).href }, version: 1, getText: () => current };
    const at = offset => { const lines = current.slice(0, offset).split('\n'); return { line: lines.length - 1, character: lines.at(-1).length }; };
    for (const [prefix, name, candidate] of [
      ['input.', 'industry_date', 'price_date'],
      ['holdings.', 'group_by', 'group_by'],
      ['h.security.', 'wind_level1_industry', 'wind_level1_industry'],
    ]) {
      const offset = original.indexOf(prefix + name) + prefix.length;
      current = original.slice(0, offset) + original.slice(offset + name.length); fmc.version++;
      const offered = await completion.provider.provideCompletionItems(fmc, at(offset));
      assert.ok(offered.some(i => i.label === candidate));
      assert.ok(!offered.some(i => i.label === '__completion'));
    }
    current = original; fmc.version++;
    const descriptorOffset = original.indexOf('self.holdings::') + 'self.holdings::'.length;
    const descriptorItems = await completion.provider.provideCompletionItems(fmc, at(descriptorOffset));
    assert.deepEqual(descriptorItems.map(i => i.label), ['value', 'best_available']);
    assert.equal(descriptorItems[0].insertText.value, 'value($0)');
    for (const needle of ['holdings::value(', 'market_value::value(']) {
      const offset = original.indexOf(needle) + needle.length;
      current = original.slice(0, offset) + original.slice(original.indexOf(')', offset) + 1); fmc.version++;
      const help = await providers.get('registerSignatureHelpProvider').provider.provideSignatureHelp(fmc, at(offset));
      assert.match(help.signatures[0].label, /as_of_date: date/);
      if (needle.includes('market_value')) assert.match(help.signatures[0].label, /price_hierarchy: Hierarchy/);
    }
    current = original; fmc.version++;
    const inputHover = await providers.get('registerHoverProvider').provider.provideHover(fmc, at(original.indexOf('input.industry_date')));
    assert.match(inputHover.contents.value, /input: \{\n/);
    assert.match(inputHover.contents.value, /price_source: code<PriceSources> \(optional\)/);
    assert.match(inputHover.contents.value, /industry_date: date = input.as_of_date/);
    const use = at(original.indexOf('security.wind_level1_industry'));
    const target = await providers.get('registerDefinitionProvider').provider.provideDefinition(fmc, use);
    assert.ok(target.uri.endsWith('/holdings_entry.yambl'));
    const owner = { languageId: 'yambl', uri: { toString: () => target.uri }, version: 1, getText: () => fs.readFileSync(fileURLToPath(target.uri), 'utf8') };
    const [line, character] = target.range.coordinates;
    const references = await providers.get('registerReferenceProvider').provider.provideReferences(owner, { line, character }, { includeDeclaration: false });
    assert.ok(references.some(r => r.uri === fmc.uri.toString() && r.range.coordinates[0] === use.line && r.range.coordinates[1] === use.character));
  } finally {
    await module.exports.deactivate();
    subscriptions.forEach(s => s.dispose?.());
  }
});
