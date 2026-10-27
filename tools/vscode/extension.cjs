'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lspRoot = path.join(__dirname, 'lsp');
const languages = ['yambl', 'yaplan', 'yatran'];
const { encode, Reader } = require(path.join(lspRoot, 'protocol.cjs'));
let client;
const asRange = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);

class Client {
  constructor(context) {
    this.context = context; this.modelBindings = context.workspaceState.get('transactionModelBindings', {}); this.modelWatchers = new Map();
    this.pending = new Map(); this.versions = new Map(); this.sequence = 0; this.stopping = false;
    this.output = vscode.window.createOutputChannel('YAMBL');
    this.diagnostics = vscode.languages.createDiagnosticCollection('yambl');
    this.semanticChanges = new vscode.EventEmitter();
    this.process = spawn(process.execPath, [path.join(lspRoot, 'server.cjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const reader = new Reader(message => this.receive(message));
    this.process.stdout.on('data', chunk => {
      try { reader.push(chunk); } catch (error) { this.fail(error); this.process.kill(); }
    });
    this.process.stderr.on('data', chunk => this.output.append(chunk.toString()));
    this.process.on('error', error => this.fail(error));
    this.process.stdin.on('error', error => this.fail(error));
    this.process.on('exit', code => {
      this.fail(new Error(`YAMBL language server exited (${code}). Reload the window to restart it.`));
    });
    context.subscriptions.push(this.output, this.diagnostics, this.semanticChanges, { dispose: () => this.process.kill() });
  }
  watchModels() {
    const roots = new Set(Object.values(this.modelBindings));
    for (const [root, watcher] of this.modelWatchers) if (!roots.has(root)) { watcher.dispose(); this.modelWatchers.delete(root); }
    for (const root of roots) if (!this.modelWatchers.has(root)) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.{yambl,lclcfg}'));
      const send = uri => this.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri.toString(), type: 2 }] });
      this.context.subscriptions.push(watcher, watcher.onDidCreate(send), watcher.onDidChange(send), watcher.onDidDelete(send));
      this.modelWatchers.set(root, watcher);
    }
  }
  async bindModel(document, root) {
    this.sync(document);
    const uri = document.uri.toString();
    await this.request('yambl/bindModel', { uri, root });
    if (root === null) delete this.modelBindings[uri]; else this.modelBindings[uri] = root;
    await this.context.workspaceState.update('transactionModelBindings', this.modelBindings);
    this.watchModels();
  }
  fail(error) {
    this.dead = true;
    if (!this.stopping) this.output.appendLine(error.message);
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear(); this.diagnostics.clear();
  }
  send(message) { if (!this.dead) this.process.stdin.write(encode({ jsonrpc: '2.0', ...message })); }
  notify(method, params) { this.send({ method, params }); }
  request(method, params, cancellation) {
    if (this.dead) return Promise.reject(new Error('YAMBL server is unavailable. Reload the window to restart it.'));
    if (cancellation?.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let subscription;
      const clean = () => { clearTimeout(timer); subscription?.dispose(); this.pending.delete(id); };
      const timer = setTimeout(() => { clean(); reject(new Error(`YAMBL request timed out: ${method}`)); }, 10000);
      this.pending.set(id, { resolve: value => { clean(); resolve(value); }, reject: error => { clean(); reject(error); } });
      subscription = cancellation?.onCancellationRequested(() => {
        this.notify('$/cancelRequest', { id }); clean(); reject(new vscode.CancellationError());
      });
      this.send({ id, method, params });
    });
  }
  receive(message) {
    if (message.id !== undefined) {
      const item = this.pending.get(message.id);
      if (message.error) item?.reject(new Error(message.error.message)); else item?.resolve(message.result);
    } else if (message.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics, version } = message.params;
      if (version !== undefined && version < (this.versions.get(uri) || 0)) return;
      this.diagnostics.set(vscode.Uri.parse(uri), diagnostics.map(item => {
        const result = new vscode.Diagnostic(asRange(item.range), item.message, (item.severity || 1) - 1);
        result.source = 'yambl'; return result;
      }));
      this.semanticChanges.fire();
    } else if (message.method === 'window/logMessage') this.output.appendLine(message.params.message);
  }
  sync(document) {
    if (!languages.includes(document.languageId) && path.basename(document.fileName || '') !== 'yambl-root.lclcfg') return;
    const uri = document.uri.toString(); const prior = this.versions.get(uri);
    if (prior === undefined) {
      if (this.modelBindings[uri]) this.notify('yambl/bindModel', { uri, root: this.modelBindings[uri] });
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: document.languageId, version: document.version, text: document.getText() } });
    }
    else if (prior !== document.version) this.notify('textDocument/didChange', { textDocument: { uri, version: document.version }, contentChanges: [{ text: document.getText() }] });
    this.versions.set(uri, document.version);
  }
  async feature(method, document, extra, token) {
    this.sync(document);
    return this.request(method, { textDocument: { uri: document.uri.toString() }, ...extra }, token);
  }
  async stop() {
    this.stopping = true;
    try { await this.request('shutdown', {}); this.notify('exit'); }
    catch { this.process.kill(); }
  }
}

async function activate(context) {
  client = new Client(context);
  await client.request('initialize', { processId: process.pid, capabilities: { general: { positionEncodings: ['utf-16'] } },
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map(f => ({ uri: f.uri.toString(), name: f.name })) });
  client.notify('initialized', {});
  client.watchModels();
  const selector = languages.flatMap(language => [{ language, scheme: 'file' }, { language, scheme: 'untitled' }]);
  context.subscriptions.push(
    vscode.commands.registerCommand('yambl.selectTransactionModel', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document || !['yaplan', 'yatran'].includes(document.languageId)) return;
      const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Select model directory' });
      if (!selected?.length) return;
      try { await client.bindModel(document, selected[0].fsPath); }
      catch (error) { await vscode.window.showErrorMessage(error.message); }
    }),
    vscode.commands.registerCommand('yambl.clearTransactionModel', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document && ['yaplan', 'yatran'].includes(document.languageId)) await client.bindModel(document, null);
    }),
    vscode.workspace.onDidOpenTextDocument(doc => client.sync(doc)),
    vscode.workspace.onDidChangeTextDocument(event => client.sync(event.document)),
    vscode.workspace.onDidCloseTextDocument(doc => {
      const uri = doc.uri.toString();
      if (client.versions.delete(uri)) client.notify('textDocument/didClose', { textDocument: { uri } });
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (languages.includes(doc.languageId)) client.notify('textDocument/didSave', { textDocument: { uri: doc.uri.toString() } });
    }),
    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      async provideDocumentFormattingEdits(doc, options, token) {
        const edits = await client.feature('textDocument/formatting', doc, { options }, token);
        const result = (edits || []).map(e => vscode.TextEdit.replace(asRange(e.range), e.newText));
        if (result.length && doc.eol !== vscode.EndOfLine.LF) result.push(vscode.TextEdit.setEndOfLine(vscode.EndOfLine.LF));
        return result;
      },
    }),
    vscode.languages.registerCompletionItemProvider(selector, {
      async provideCompletionItems(doc, position, token) {
        const result = await client.feature('textDocument/completion', doc, { position }, token);
        return (result?.items || []).map(item => {
          const completion = new vscode.CompletionItem(item.label, item.kind - 1);
          completion.detail = item.detail;
          if (item.documentation) completion.documentation = new vscode.MarkdownString().appendText(item.documentation);
          if (item.insertText) completion.insertText = item.insertTextFormat === 2 ? new vscode.SnippetString(item.insertText) : item.insertText;
          return completion;
        });
      },
    }, '.', ':', '(', ','),
    vscode.languages.registerSignatureHelpProvider(selector, {
      async provideSignatureHelp(doc, position, token) {
        const result = await client.feature('textDocument/signatureHelp', doc, { position }, token);
        if (!result) return null;
        const help = new vscode.SignatureHelp();
        help.activeSignature = result.activeSignature; help.activeParameter = result.activeParameter;
        help.signatures = result.signatures.map(item => {
          const signature = new vscode.SignatureInformation(item.label, new vscode.MarkdownString().appendText(item.documentation || ''));
          signature.parameters = item.parameters.map(p => new vscode.ParameterInformation(p.label, p.documentation));
          return signature;
        });
        return help;
      },
    }, '(', ','),
    vscode.languages.registerHoverProvider(selector, {
      async provideHover(doc, position, token) {
        const result = await client.feature('textDocument/hover', doc, { position }, token);
        return result ? new vscode.Hover(new vscode.MarkdownString().appendText(result.contents.value), asRange(result.range)) : null;
      },
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(doc, position, token) {
        const result = await client.feature('textDocument/definition', doc, { position }, token);
        return Array.isArray(result) ? result.map(item => new vscode.Location(vscode.Uri.parse(item.uri), asRange(item.range)))
          : result ? new vscode.Location(vscode.Uri.parse(result.uri), asRange(result.range)) : null;
      },
    }),
    vscode.languages.registerReferenceProvider(selector, {
      async provideReferences(doc, position, referenceContext, token) {
        const result = await client.feature('textDocument/references', doc, { position, context: referenceContext }, token);
        return (result || []).map(item => new vscode.Location(vscode.Uri.parse(item.uri), asRange(item.range)));
      },
    }),
    vscode.languages.registerDocumentSemanticTokensProvider(selector, {
      onDidChangeSemanticTokens: client.semanticChanges.event,
      async provideDocumentSemanticTokens(doc, token) {
        const result = await client.feature('textDocument/semanticTokens/full', doc, {}, token);
        return new vscode.SemanticTokens(Uint32Array.from(result?.data || []));
      },
    }, new vscode.SemanticTokensLegend(['yamblValueType'], [])),
    vscode.languages.registerDocumentSymbolProvider(selector, {
      async provideDocumentSymbols(doc, token) {
        const convert = item => {
          const symbol = new vscode.DocumentSymbol(item.name, '', item.kind - 1, asRange(item.range), asRange(item.selectionRange));
          symbol.children = (item.children || []).map(convert); return symbol;
        };
        return (await client.feature('textDocument/documentSymbol', doc, {}, token) || []).map(convert);
      },
    }),
  );
  for (const pattern of ['**/*.yambl', '**/*.yaplan', '**/*.yatran', '**/yambl-root.lclcfg']) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const send = (uri, type) => client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri.toString(), type }] });
    context.subscriptions.push(watcher, watcher.onDidCreate(uri => send(uri, 1)), watcher.onDidChange(uri => send(uri, 2)), watcher.onDidDelete(uri => send(uri, 3)));
  }
  for (const doc of vscode.workspace.textDocuments) client.sync(doc);
}
async function deactivate() { if (client) await client.stop(); }
module.exports = { activate, deactivate };
