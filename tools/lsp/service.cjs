'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { parse, format, range, position, keywords, annotations, values, generics, entities, constants } = require('./language/syntax.cjs');
const { validate, describe } = require('./language/validation.cjs');

const excluded = new Set(['venv', '.venv', 'env', 'build', 'dist', '__pycache__', 'node_modules']);
function uriKey(uri) {
  if (!uri.startsWith('file:')) return uri;
  const file = path.resolve(fileURLToPath(uri));
  return process.platform === 'win32' ? file.toLowerCase() : file;
}
function rootFor(uri) {
  if (!uri.startsWith('file:')) return null;
  let directory = path.dirname(fileURLToPath(uri));
  while (true) {
    if (fs.existsSync(path.join(directory, 'yambl-root.lclcfg'))) return directory;
    const parent = path.dirname(directory); if (parent === directory) return null; directory = parent;
  }
}
function sources(root) {
  const result = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.isSymbolicLink() || item.name.startsWith('.') || excluded.has(item.name)) continue;
    const full = path.join(root, item.name);
    if (item.isDirectory()) result.push(...sources(full));
    else if (item.isFile() && item.name.endsWith('.yambl')) result.push(full);
  }
  return result.sort();
}
function inside(root, uri) {
  if (!uri.startsWith('file:')) return false;
  const relative = path.relative(root, fileURLToPath(uri));
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
const help = {
  extend: 'Merge attributes into the named entity. Each attribute retains its original definition location.',
  inherits: 'Single inheritance. Duplicate inherited fields and cycles are errors.',
  snapshot: 'Independent temporal attribute snapshot.', scd: 'Slowly changing dimension Type 2 attribute.',
  config: 'Time-independent parameter that configuration can override.',
  code: 'A Decodes code value. Dynamic dictionaries may be provided outside the model.',
  collection: 'Unordered unique entity references.', values: 'Unordered unique values.',
  map: 'Keys: string or entity reference. Values: non-collection values or references.',
  NOT_DEFINED: 'The requested subtype attribute does not apply to the instance’s actual type.',
  title: 'Short display title.', description: 'Descriptive metadata.',
  temporal: 'Temporal parameter: as_of_date: date.', dimensions: 'Additional named attribute dimensions.',
};

class Service {
  constructor(notify) { this.notify = notify; this.open = new Map(); this.documents = new Map(); this.published = new Set(); }
  refresh() {
    const buffers = new Map([...this.open].map(([uri, item]) => [uriKey(uri), { uri, text: item.text }]));
    const groups = new Map();
    for (const uri of this.open.keys()) {
      const root = rootFor(uri); const identity = root ? uriKey(pathToFileURL(root).href) : uriKey(uri);
      if (!groups.has(identity)) groups.set(identity, { root, uri });
    }
    this.documents.clear();
    for (const { root, uri } of groups.values()) {
      const texts = new Map(); let readError = null;
      try {
        if (root) for (const file of sources(root)) {
          const fileUri = pathToFileURL(file).href;
          const buffer = buffers.get(uriKey(fileUri));
          texts.set(uriKey(fileUri), buffer || { uri: fileUri, text: new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)) });
        }
      } catch (error) { readError = error.message; }
      for (const [openUri, item] of this.open) if (root ? inside(root, openUri) : openUri === uri) texts.set(uriKey(openUri), { uri: openUri, text: item.text });
      const docs = [...texts.values()].map(item => parse(item.text, item.uri));
      validate(docs);
      for (const doc of docs) {
        // The CLI still reports these dependencies; dynamic dictionaries are normal in the editor.
        doc.diagnostics = doc.diagnostics.filter(d => d.code !== 'undefined-decodes');
        if (readError && this.open.has(doc.uri)) doc.diagnostics.push({ range: range(doc.text, 0, 0), severity: 1, source: 'yambl', message: `Cannot read compilation unit: ${readError}` });
        this.documents.set(doc.uri, doc);
      }
    }
    const current = new Set(this.documents.keys());
    for (const uri of new Set([...this.published, ...current])) {
      this.notify('textDocument/publishDiagnostics', {
        uri, version: this.open.get(uri)?.version, diagnostics: this.documents.get(uri)?.diagnostics || [],
      });
    }
    this.published = current;
  }
  document(uri) { return this.documents.get(uri) || [...this.documents.values()].find(doc => uriKey(doc.uri) === uriKey(uri)); }
  tokenAt(doc, pos) {
    return doc.tokens.find(t => t.range.start.line === pos.line && t.range.start.character <= pos.character && pos.character < t.range.end.character);
  }
  references(target, includeDeclaration) {
    const locations = [];
    if (!target) return locations;
    for (const doc of this.documents.values()) for (const token of doc.tokens) {
      if (doc.bindings.get(token.start) !== target) continue;
      if (!includeDeclaration && uriKey(doc.uri) === uriKey(target.doc.uri) && token.start === target.name.start) continue;
      locations.push({ uri: doc.uri, range: token.range });
    }
    return locations;
  }
  feature(method, params) {
    const doc = this.document(params.textDocument.uri); if (!doc) return null;
    const token = params.position && this.tokenAt(doc, params.position);
    const target = token && doc.bindings.get(token.start);
    if (method === 'textDocument/definition') return target ? { uri: target.doc.uri, range: target.name.range } : null;
    if (method === 'textDocument/references') return this.references(target, params.context?.includeDeclaration === true);
    if (method === 'textDocument/semanticTokens/full') {
      const classified = new Map(doc.valueTypeTokens);
      for (const token of doc.tokens) if (doc.bindings.get(token.start)?.kind === 'decodes') classified.set(token.start, token);
      const data = []; let lastLine = 0, lastCharacter = 0;
      for (const token of [...classified.values()].sort((a, b) => a.start - b.start)) {
        if (token.value.startsWith("'")) continue;
        const line = token.range.start.line, character = token.range.start.character;
        const length = token.value.length;
        data.push(line - lastLine, line === lastLine ? character - lastCharacter : character, length, 0, 0);
        lastLine = line; lastCharacter = character;
      }
      return { data };
    }
    if (method === 'textDocument/hover') {
      const value = target ? describe(target) : token && (help[token.value] || (values.includes(token.value) ? `Built-in value type: ${token.value}` : null));
      return value ? { contents: { kind: 'plaintext', value }, range: token.range } : null;
    }
    if (method === 'textDocument/completion') {
      const items = [...keywords, ...annotations, ...values, ...generics, ...entities, ...constants].map(label => ({ label, kind: 14, detail: help[label] || 'YAMBL built-in' }));
      for (const [label, decl] of doc.scope) items.push({ label, kind: decl.kind === 'entity' ? 7 : 20, detail: describe(decl) });
      return { isIncomplete: false, items };
    }
    if (method === 'textDocument/formatting') {
      const newText = format(doc);
      return newText === null || newText === doc.text ? [] : [{ range: { start: { line: 0, character: 0 }, end: position(doc.text, doc.text.length) }, newText }];
    }
    if (method === 'textDocument/documentSymbol') {
      const fieldSymbol = (field, prefix = '') => ({ name: prefix + field.name.value, kind: 8,
        range: range(doc.text, field.metadata[0]?.token.start ?? field.token.start, field.name.end), selectionRange: field.name.range });
      return doc.declarations.flatMap(decl => decl.kind === 'extend' ? decl.fields.map(f => fieldSymbol(f, decl.name.value + '.')) : [{
        name: decl.name.value, kind: decl.kind === 'entity' ? 5 : 10,
        range: range(doc.text, decl.metadata[0]?.token.start ?? decl.token.start, decl.end), selectionRange: decl.name.range,
        children: decl.kind === 'entity' ? decl.fields.map(f => fieldSymbol(f)) : decl.entries.map(e => ({ name: e.code.value, kind: 22, range: range(doc.text, e.token.start, e.value.end), selectionRange: e.code.range })),
      }]);
    }
    return null;
  }
}
module.exports = { Service, rootFor, sources, inside, uriKey };
