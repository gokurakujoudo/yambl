'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { encode, Reader } = require('../protocol.cjs');

test('Content-Length counts UTF-8 bytes and handles partial and coalesced frames', () => {
  const received = []; const reader = new Reader(value => received.push(value));
  const messages = [{ jsonrpc: '2.0', id: 1, result: '人民币 😀' }, { jsonrpc: '2.0', method: 'initialized', params: {} }];
  const bytes = Buffer.concat(messages.map(encode));
  for (const byte of bytes) reader.push(Buffer.from([byte]));
  assert.deepEqual(received, messages);
  reader.push(bytes); assert.deepEqual(received, [...messages, ...messages]);
  assert.throws(() => new Reader(() => {}).push(Buffer.from('Bad: 1\r\n\r\n{}')), /Content-Length/);
});
test('real stdio lifecycle, unsaved changes, stale versions, requests and shutdown', { timeout: 15000 }, async t => {
  const child = spawn(process.execPath, [path.join(__dirname, '../server.cjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill()); let id = 0; const pending = new Map(); const notifications = [];
  child.stdout.on('data', chunk => reader.push(chunk));
  const reader = new Reader(message => {
    if (message.id !== undefined) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else notifications.push(message);
  });
  const request = (method, params = {}) => new Promise(resolve => { const next = ++id; pending.set(next, resolve); child.stdin.write(encode({ jsonrpc: '2.0', id: next, method, params })); });
  const notify = (method, params = {}) => child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  assert.equal((await request('textDocument/hover')).error.code, -32002);
  const init = await request('initialize'); assert.equal(init.result.capabilities.positionEncoding, 'utf-16');
  assert.equal(init.result.capabilities.referencesProvider, true);
  assert.deepEqual(init.result.capabilities.semanticTokensProvider.legend.tokenTypes, ['yamblValueType']);
  notify('initialized');
  const uri = 'untitled:test';
  notify('textDocument/didOpen', { textDocument: { uri, text: "entity A { attr x: code<'Markets'> }", version: 1 } });
  const params = { textDocument: { uri }, position: { line: 0, character: 0 } };
  assert.ok((await request('textDocument/completion', params)).result.items.some(i => i.label === 'inherits'));
  assert.ok(notifications.some(n => Array.isArray(n.params.diagnostics) && n.params.diagnostics.length === 0));
  assert.ok((await request('textDocument/semanticTokens/full', params)).result.data.length > 0);
  assert.deepEqual((await request('textDocument/references', params)).result, []);
  notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'entity A {}' }] });
  notify('textDocument/didChange', { textDocument: { uri, version: 1 }, contentChanges: [{ text: 'invalid' }] });
  const format = await request('textDocument/formatting', params);
  assert.equal(format.result[0].newText, 'entity A {\n}\n');
  assert.equal((await request('unknown')).error.code, -32601);
  assert.equal((await request('shutdown')).result, null);
  assert.equal((await request('textDocument/hover', params)).error.code, -32600);
  const exit = new Promise(resolve => child.on('exit', resolve)); notify('exit'); assert.equal(await exit, 0);
});
