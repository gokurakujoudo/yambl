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
    Diagnostic: class {}, SemanticTokensLegend: class {},
    EventEmitter: class { fire() {} dispose() {} },
    Uri: { parse: value => value },
    window: { createOutputChannel: () => ({ ...disposable(), append() {}, appendLine() {} }) },
    languages: new Proxy({ createDiagnosticCollection: () => ({ ...disposable(), clear() {}, set() {} }) }, {
      get(target, name) {
        return target[name] || ((selector, provider, ...triggers) => {
          providers.set(name, { provider, triggers }); return disposable();
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
    const text = 'entity E { snapshot attr n: integer computed attr x: integer { return self.n::at() } }';
    const doc = { languageId: 'yambl', uri: { toString: () => 'untitled:client-test' }, version: 1, getText: () => text };
    const position = { line: 0, character: text.indexOf('at(') + 3 };
    const completion = providers.get('registerCompletionItemProvider');
    assert.ok(completion.triggers.includes(':'));
    const items = await completion.provider.provideCompletionItems(doc, position);
    assert.equal(items.find(i => i.label === 'as_of_date').insertText, 'as_of_date=');
    const signature = await providers.get('registerSignatureHelpProvider').provider.provideSignatureHelp(doc, position);
    assert.match(signature.signatures[0].label, /as_of_date: date/);
    const localItems = await completion.provider.provideCompletionItems(doc, { line: 0, character: text.indexOf('return') + 7 });
    assert.equal(localItems.find(i => i.label === 'input').insertText.value, 'input.${1:name}');

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
    for (const needle of ['holdings::at(', 'market_value::value(']) {
      const offset = original.indexOf(needle) + needle.length;
      current = original.slice(0, offset) + original.slice(original.indexOf(')', offset) + 1); fmc.version++;
      const help = await providers.get('registerSignatureHelpProvider').provider.provideSignatureHelp(fmc, at(offset));
      assert.match(help.signatures[0].label, /as_of_date: date/);
      if (needle.includes('market_value')) assert.match(help.signatures[0].label, /price_hierarchy: Hierarchy/);
    }
    current = original; fmc.version++;
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
