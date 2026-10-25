'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  } finally {
    await module.exports.deactivate();
    subscriptions.forEach(s => s.dispose?.());
  }
});
