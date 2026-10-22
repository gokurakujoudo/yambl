'use strict';

const { encode, Reader } = require('./protocol.cjs');
const { Service } = require('./service.cjs');
const send = message => process.stdout.write(encode({ jsonrpc: '2.0', ...message }));
const service = new Service((method, params) => send({ method, params }));
let initialized = false, shutdown = false, timer;
function refresh() { clearTimeout(timer); timer = null; service.refresh(); }
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { refresh(); } catch (error) { send({ method: 'window/logMessage', params: { type: 1, message: error.message } }); }
  }, 120);
}
function receive(message) {
  const { id, method, params = {} } = message;
  const request = id !== undefined;
  try {
    if (method === 'exit') process.exit(shutdown ? 0 : 1);
    if (method === 'initialize') {
      if (initialized) throw Object.assign(new Error('Already initialized'), { code: -32600 });
      initialized = true;
      send({ id, result: { capabilities: { positionEncoding: 'utf-16', textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
        completionProvider: {}, hoverProvider: true, definitionProvider: true, documentSymbolProvider: true, documentFormattingProvider: true },
        serverInfo: { name: 'yambl-lsp', version: '0.1.0' } } });
      return;
    }
    if (!initialized || shutdown) {
      if (request) throw Object.assign(new Error(shutdown ? 'Server has shut down' : 'Server not initialized'), { code: shutdown ? -32600 : -32002 });
      return;
    }
    if (method === 'shutdown') { shutdown = true; clearTimeout(timer); timer = null; send({ id, result: null }); return; }
    if (method === 'textDocument/didOpen') { service.open.set(params.textDocument.uri, params.textDocument); schedule(); return; }
    if (method === 'textDocument/didChange') {
      const prior = service.open.get(params.textDocument.uri);
      if (prior && params.textDocument.version > prior.version) {
        const content = params.contentChanges.at(-1);
        if (content && !content.range) service.open.set(params.textDocument.uri, { ...params.textDocument, text: content.text });
        schedule();
      }
      return;
    }
    if (method === 'textDocument/didClose') { service.open.delete(params.textDocument.uri); schedule(); return; }
    if (['textDocument/didSave', 'workspace/didChangeWatchedFiles'].includes(method)) { schedule(); return; }
    if (!request) return;
    if (!['textDocument/completion', 'textDocument/hover', 'textDocument/definition', 'textDocument/documentSymbol', 'textDocument/formatting'].includes(method)) {
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
    if (timer) refresh();
    send({ id, result: service.feature(method, params) });
  } catch (error) {
    if (request) send({ id, error: { code: error.code || -32603, message: error.message } });
    else send({ method: 'window/logMessage', params: { type: 1, message: error.message } });
  }
}
const reader = new Reader(receive);
process.stdin.on('data', chunk => {
  try { reader.push(chunk); } catch (error) {
    reader.buffer = Buffer.alloc(0); send({ id: null, error: { code: -32700, message: error.message } });
  }
});
process.stdin.on('end', () => process.exit(shutdown ? 0 : 1));
