'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { parse, format, range, position, keywords, annotations, values, generics, entities, structures, constants } = require('./language/syntax.cjs');
const { validate, describe } = require('./language/validation.cjs');

const { sources, readPrefix, rootName, configError } = require('./repository.cjs');
const { modelRoot } = require('./language/relationships.cjs');
const { Resolver } = require('./language/expressions.cjs');
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
function inside(root, uri) {
  if (!uri.startsWith('file:')) return false;
  const relative = path.relative(root, fileURLToPath(uri));
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
const help = {
  value: 'Final structured value; fields are static, non-collection values or entity IDs.',
  Hierarchy: 'Prioritized dimension candidates; lower ordering is tried first.',
  final: 'This entity cannot be inherited or extended.',
  static: 'Time-independent attribute available for condition filtering.',
  type: 'Entity type value constrained by Entity or a specific entity and its descendants.',
  Entity: 'Abstract ultimate base of all entities; business trees keep separate field identities.',
  field_mapping: 'Unordered partial mapping from filtered entity fields to their declared value types.',
  self: 'The current entity instance; self.field selects a descriptor; ::type and ::value select its type and instance value.',
  overload: 'Same-signature field shared by independent branches of one inheritance tree.',
  override: 'Same-signature redeclaration of an inherited field; config defaults may differ.',
  ConfigGroup: 'Final built-in conditional configuration model with entity_type, when and then_set.',
  extend: 'Merge attributes into the named entity. Each attribute retains its original definition location.',
  inherits: 'Single inheritance. Duplicate inherited fields and cycles are errors.',
  snapshot: 'Independent temporal attribute snapshot.', scd: 'Slowly changing dimension Type 2 attribute.',
  config: 'Time-independent parameter that configuration can override.',
  code: 'A Decodes code value. Dynamic dictionaries may be provided outside the model.',
  collection: 'Unordered unique entity references.', values: 'Unordered unique values.',
  mapping: 'Unordered unique string-compatible or reference keys and non-collection values.',
  attrs: 'Qualified field identities; excludes IDs and collection attributes.',
  alias: 'Same value as an instance-rooted field expression.',
  exact: 'Singleton constraint permitted on override and overload fields.',
  as: 'Bind a mapping key for its value type expression.',
  NOT_DEFINED: 'The requested subtype attribute does not apply to the instance’s actual type.',
  title: 'Short display title.', description: 'Descriptive metadata.',
  temporal: 'Temporal parameter: as_of_date: date.', dimension: 'Independent data dimension with an optional Hierarchy selector.',
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
      const texts = new Map(); let readError = null, prefix = '';
      const builtin = root && uriKey(pathToFileURL(root).href) === uriKey(pathToFileURL(modelRoot).href);
      try {
        if (root) {
          const config = path.join(root, rootName);
          prefix = readPrefix(config, buffers.get(uriKey(pathToFileURL(config).href))?.text);
          if (builtin && prefix) throw configError(config, 0, 'built-in prefix must be empty');
        }
        if (root) for (const file of sources(root)) {
          const fileUri = pathToFileURL(file).href;
          const buffer = buffers.get(uriKey(fileUri));
          texts.set(uriKey(fileUri), buffer || { uri: fileUri, text: new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)) });
        }
      } catch (error) { readError = error; }
      for (const [openUri, item] of this.open) {
        if (openUri.endsWith('/' + rootName)) continue;
        const openRoot = rootFor(openUri);
        const belongs = root ? openRoot && uriKey(pathToFileURL(openRoot).href) === uriKey(pathToFileURL(root).href) : openUri === uri;
        if (belongs) texts.set(uriKey(openUri), { uri: openUri, text: item.text });
      }
      const docs = [...texts.values()].map(item => Object.assign(parse(item.text, item.uri), { prefix, repository: !builtin && root ? uriKey(pathToFileURL(root).href) : '', builtin }));
      for (const doc of docs) if (builtin && doc.namespace !== 'builtins') doc.errors.push({ range: range(doc.text, 0, 0), severity: 1, message: 'built-in models must declare namespace builtins', source: 'yambl' });
      validate(docs);
      if (readError?.uri) {
        const errorDoc = parse('', readError.uri);
        errorDoc.diagnostics = [{ range: { start: { line: readError.line, character: 0 }, end: { line: readError.line, character: 1 } }, severity: 1, message: readError.message, source: 'yambl' }];
        this.documents.set(errorDoc.uri, errorDoc);
      }
      for (const doc of docs) {
        // The CLI still reports these dependencies; dynamic dictionaries are normal in the editor.
        doc.diagnostics = doc.diagnostics.filter(d => d.code !== 'undefined-decodes');
        if (readError && !readError.uri && this.open.has(doc.uri)) doc.diagnostics.push({ range: range(doc.text, 0, 0), severity: 1, source: 'yambl', message: `Cannot read compilation unit: ${readError.message}` });
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
    if (params.position && doc.blocks.some(b => { const r = range(doc.text, b.start, b.end); return params.position.line >= r.start.line && params.position.line <= r.end.line; })) return null;
    const token = params.position && this.tokenAt(doc, params.position);
    const target = token && doc.bindings.get(token.start);
    if (method === 'textDocument/definition') {
      const targets = token && doc.markerTargets.get(token.start);
      if (targets) return targets.map(field => ({ uri: field.doc.uri, range: field.name.range }));
      return target ? { uri: target.doc.uri, range: target.name.range } : null;
    }
    if (method === 'textDocument/references') return this.references(target, params.context?.includeDeclaration === true);
    if (method === 'textDocument/semanticTokens/full') {
      const classified = new Map(doc.valueTypeTokens);
      for (const token of doc.tokens) if (['decodes', 'value', 'type_alias'].includes(doc.bindings.get(token.start)?.kind)) classified.set(token.start, token);
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
      const offset = doc.text.split('\n').slice(0, params.position.line).reduce((n, line) => n + line.length + 1, 0) + params.position.character;
      if (/::[a-z]*$/.test(doc.text.slice(0, offset))) return { isIncomplete: false, items: ['type', 'value'].map(label => ({ label, kind: 10, detail: help.self })) };
      const selfPath = /\bself(?:\.[a-zA-Z_][a-zA-Z_0-9]*::value)*\.[a-zA-Z_0-9]*$/.exec(doc.text.slice(0, offset));
      if (selfPath) {
        let completionDoc = doc;
        if (doc.errors.length) {
          const prefix = doc.text.slice(0, offset).replace(/[a-zA-Z_0-9]*$/, '__completion');
          const recovered = Object.assign(parse(prefix + doc.text.slice(offset), doc.uri), { prefix: doc.prefix, repository: doc.repository, builtin: doc.builtin });
          if (!recovered.errors.length) {
            const root = rootFor(doc.uri);
            const siblings = [...this.documents.values()].filter(d => d !== doc && root && rootFor(d.uri) === root).map(d => Object.assign(parse(d.text, d.uri), { prefix: d.prefix, repository: d.repository, builtin: d.builtin }));
            validate([...siblings, recovered]); completionDoc = recovered;
          }
        }
        const declaration = completionDoc.declarations.find(d => d.bodyStart <= offset && offset <= d.end);
        let owner = declaration && completionDoc.scope.get(declaration.name.value);
        const symbols = new Map([...this.documents.values(), completionDoc].flatMap(d => [...d.scope.values()].map(decl => [decl.key, decl])));
        for (const segment of selfPath[0].split('.').slice(1, -1)) {
          const field = owner?.effective?.get(segment.replace(/::value$/, ''));
          owner = field ? symbols.get(new Resolver(field.doc, () => {}, symbols, field.owner).resolve(field.type).key) : null;
        }
        return { isIncomplete: false, items: [...(owner?.effective || [])].map(([label, f]) => ({ label, kind: 5, detail: describe(f) })) };
      }
      const items = [...keywords, ...annotations, ...values, ...generics, ...entities, ...structures, 'Entity', ...constants].map(label => ({ label, kind: 14, detail: help[label] || 'YAMBL built-in' }));
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
        children: ['entity', 'value'].includes(decl.kind) ? decl.fields.map(f => fieldSymbol(f)) : decl.entries.map(e => ({ name: e.code.value, kind: 22, range: range(doc.text, e.token.start, e.value.end), selectionRange: e.code.range })),
      }]);
    }
    return null;
  }
}
module.exports = { Service, rootFor, sources, inside, uriKey };
