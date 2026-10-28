'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { parse, format, range, position, keywords, annotations, values, generics, entities, structures, constants, resultConstants } = require('./language/syntax.cjs');
const { validate, describe } = require('./language/validation.cjs');
const { typeLabel, methodNames, methodHelp, nodes, defaultLabel, inputTypeHelp } = require('./language/calculation-tools.cjs');
const typeTools = require('./language/type-tools.cjs');

const { sources, readPrefix, rootName, configError } = require('./repository.cjs');
const { modelRoot } = require('./language/relationships.cjs');
const { Resolver } = require('./language/expressions.cjs');
const { codeEntries } = require('./language/decodes.cjs');
const transactions = require('./transactions/syntax.cjs');
const transactionModels = require('./transactions/model.cjs');
const transactionValidation = require('./transactions/validation.cjs');
const isTransaction = (uri, item) => /\.(yaplan|yatran)$/i.test(uri) || ['yaplan', 'yatran'].includes(item?.languageId);
const { targetContract, allowsTarget, allowsMultiple } = require('./language/decorators.cjs');

// Use lexer tokens so comments, strings and Markdown cannot invent a surrounding declaration.
function decoratorSites(doc, start, used) {
  const tokens = doc.tokens, marker = tokens.findIndex(t => t.start === start && t.value === '@');
  if (marker < 0 || tokens[marker - 1]?.value === 'decorator') return [];
  const stack = [];
  for (let i = 0; i < marker; i++) {
    const value = tokens[i].value;
    if (['(', '[', '<', '{'].includes(value)) {
      const kind = value === '{' ? tokens.slice(0, i).findLast(t => ['entity', 'extend', 'value', 'decodes'].includes(t.value))?.value : null;
      stack.push({ value, kind });
    } else if ([')', ']', '>', '}'].includes(value)) stack.pop();
  }
  if (stack.some(frame => frame.value !== '{') || stack.length > 1) return [];
  const owner = stack[0]?.kind;
  if (owner === 'decodes') return [];
  // Walk only the adjacent annotation group; declarations and fields are boundaries.
  let previous = marker - 1;
  while (previous >= 0) {
    if (tokens[previous].value === ')') {
      let depth = 1;
      while (--previous >= 0 && depth) {
        if (tokens[previous].value === ')') depth++;
        if (tokens[previous].value === '(') depth--;
      }
    }
    if (tokens[previous - 1]?.value !== '@' || tokens[previous - 2]?.value === 'decorator') break;
    used.add(tokens[previous].value);
    previous -= 2;
  }
  let index = marker;
  do {
    const at = tokens[index++];
    // The current name may be empty or only partly typed; later annotations have full names.
    if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(tokens[index]?.value || '') && (tokens[index].start === at.end || index - 1 !== marker)) {
      if (at.start !== start) used.add(tokens[index].value);
      index++;
    }
    if (tokens[index]?.value === '(') {
      let depth = 0;
      do {
        const value = tokens[index++].value;
        if (value === '(') depth++;
        if (value === ')') depth--;
      } while (depth && index < tokens.length);
      if (depth) return [];
    }
  } while (tokens[index]?.value === '@');
  const next = tokens[index]?.value;
  if (owner) {
    if (next === 'id') return owner === 'entity' ? [['Id']] : [];
    if (next && next !== '}' && !['attr', 'static', 'config', 'snapshot', 'scd', 'computed'].includes(next)) return [];
    if (owner === 'value') return !next || ['}', 'attr', 'static'].includes(next) ? [['ValueAttr', 'static']] : [];
    if (next && next !== '}') return [['EntityAttr', next === 'attr' ? 'static' : next]];
    return owner === 'entity' ? [['Id'], ['EntityAttr']] : [['EntityAttr']];
  }
  const kind = { entity: 'Entity', value: 'Value', decodes: 'Decodes', type: 'Type', decorator: 'Decorator', final: 'Entity' }[next];
  return kind ? [[kind]] : next ? [] : ['Entity', 'Value', 'Decodes', 'Type', 'Decorator'].map(kind => [kind]);
}

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
  sparse: 'Store a non-collection, dimensionless static field in a typed long table grouped by inheritance root and cat. cat must be nonempty snake_case. Mutually exclusive with dense and dimension; reading semantics are unchanged.',
  dense: 'Store a non-collection, dimensionless static field in a wide table grouped by inheritance root and cat. cat must be nonempty snake_case. Mutually exclusive with sparse and dimension; reading semantics are unchanged.',
  decodes_rank: 'Override a descendant code ordering relative to its parent and supply its decode.',
  subtypes: 'Derived Decodes containing strict descendant entities.',
  flags: 'Independent positive single-bit codes; None is zero and All selects every declared flag. Use + to add and - to remove flags, left to right; repeated additions or removals have no further effect.',
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
  ConfigGroup: 'Final built-in conditional configuration model with target_entity_type, when and then_set.',
  extend: 'Merge attributes into the named entity. Each attribute retains its original definition location.',
  inherits: 'Single inheritance. Duplicate inherited fields and cycles are errors.',
  snapshot: 'Independent temporal attribute snapshot.', scd: 'Slowly changing dimension Type 2 attribute.',
  config: 'Time-independent parameter that configuration can override.',
  computed: 'Read-only derived field with immutable let bindings and a final return. Parameters are inferred from dependencies.',
  best_available: 'Select date before source priority within the effective per-instance fallback window.',
  recover: 'Replace explicitly matched non-normal results; unmatched states remain unchanged. Branches are lazy.',
  code: 'A Decodes code value. Dynamic dictionaries may be provided outside the model.',
  collection: 'Unordered unique entity references.', values: 'Unordered unique values.',
  mapping: 'Unordered unique string-compatible or reference keys and non-collection values.',
  attrs: 'Qualified field identities; excludes IDs and collection attributes.',
  alias: 'Same value as an instance-rooted field expression.',
  exact: 'Singleton constraint permitted on override and overload fields.',
  as: 'Bind a mapping key for its value type expression.',
  ...Object.fromEntries(Object.entries(resultConstants).map(([name, meaning]) => [name, `${meaning}\n\nCalculation results support explicit recover; PARTIAL requires a payload and issue details.`])),
  title: 'Short display title.', description: 'Descriptive metadata.',
  temporal: 'One caller-named date parameter on snapshot or scd attr.', dimension: 'Independent data dimension with an optional Hierarchy selector.',
  decorator: 'Declare typed metadata with value parameters and caller-defined key/type pairs.',
  targets: 'Declare the allowed definition kinds and optional attribute categories for a decorator.',
  allow_multiple: 'Allow repeated uses of the decorated decorator on one definition.',
  input: 'External computation input: input.name. Rename or bind with name=input.name; input.name ?? expression supplies a value only when omitted.',
  '??': 'Omitted-input fallback. The left operand is input.name; the right operand is lazy. Caller values and declaration defaults take precedence. Native non-normal results require recover.',
  input_type: 'Decorator pair constraint accepting non-collection value types or entity references. Not a runtime field type.',
  extra_input_params: 'Declare one optional computed-field input, with an optional default and trailing description. Repeat for different names. Types merge with inferred dependencies; declaration defaults take precedence over ??.',
  ...typeTools.types,
};

class Service {
  constructor(notify) { this.notify = notify; this.open = new Map(); this.documents = new Map(); this.published = new Set(); this.modelRoots = new Map(); }
  bindModel(uri, root) {
    if (root !== null) {
      if (typeof root !== 'string' || !path.isAbsolute(root) || !fs.statSync(path.join(root, rootName)).isFile()) throw new Error('Select a model directory containing yambl-root.lclcfg');
      this.modelRoots.set(uriKey(uri), path.resolve(root));
    } else this.modelRoots.delete(uriKey(uri));
    this.refresh();
  }
  refresh() {
    const buffers = new Map([...this.open].map(([uri, item]) => [uriKey(uri), { uri, text: item.text }]));
    const groups = new Map(), catalogs = new Map();
    for (const uri of this.open.keys()) {
      if (isTransaction(uri, this.open.get(uri))) {
        const root = this.modelRoots.get(uriKey(uri));
        if (root) groups.set(uriKey(pathToFileURL(root).href), { root, uri: pathToFileURL(path.join(root, rootName)).href });
        continue;
      }
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
        if (isTransaction(openUri, item)) continue;
        if (openUri.endsWith('/' + rootName)) continue;
        const openRoot = rootFor(openUri);
        const belongs = root ? openRoot && uriKey(pathToFileURL(openRoot).href) === uriKey(pathToFileURL(root).href) : openUri === uri;
        if (belongs) texts.set(uriKey(openUri), { uri: openUri, text: item.text });
      }
      const docs = [...texts.values()].map(item => Object.assign(parse(item.text, item.uri), { prefix, repository: !builtin && root ? uriKey(pathToFileURL(root).href) : '', builtin }));
      for (const doc of docs) if (builtin && doc.namespace !== 'builtins') doc.errors.push({ range: range(doc.text, 0, 0), severity: 1, message: 'built-in models must declare namespace builtins', source: 'yambl' });
      const symbols = validate(docs);
      if (root) catalogs.set(uriKey(pathToFileURL(root).href), { symbols, readError });
      if (readError?.uri) {
        const errorDoc = parse('', readError.uri);
        errorDoc.diagnostics = [{ range: { start: { line: readError.line, character: 0 }, end: { line: readError.line, character: 1 } }, severity: 1, message: readError.message, source: 'yambl' }];
        this.documents.set(errorDoc.uri, errorDoc);
      }
      for (const doc of docs) {
        // Only quoted external dictionaries are silent in the editor; bare names must resolve.
        doc.diagnostics = doc.diagnostics.filter(d => d.code !== 'undefined-decodes');
        if (readError && !readError.uri && this.open.has(doc.uri)) doc.diagnostics.push({ range: range(doc.text, 0, 0), severity: 1, source: 'yambl', message: `Cannot read compilation unit: ${readError.message}` });
        this.documents.set(doc.uri, doc);
      }
    }
    for (const [uri, item] of this.open) if (isTransaction(uri, item)) {
      const doc = transactions.parse(item.text, uri), root = this.modelRoots.get(uriKey(uri));
      const catalog = root && catalogs.get(uriKey(pathToFileURL(root).href));
      if (catalog && !catalog.readError) { transactionModels.bind(doc, catalog.symbols); transactionValidation.validate(doc); }
      if (catalog?.readError) doc.diagnostics.push({ range: range(doc.text, 0, 0), severity: 1, source: 'yambl', message: `Cannot read bound model: ${catalog.readError.message}` });
      this.documents.set(uri, doc);
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
  completionScope(doc, start, end, decoratorName = false, onRecovered = null) {
    const replacement = decoratorName ? '@completion' : doc.text.slice(start, end).replace(/[^\r\n]/g, ' ');
    const text = doc.text.slice(0, start) + replacement + doc.text.slice(end);
    let recovered = parse(text, doc.uri);
    if (recovered.errors.length) {
      const last = doc.declarations.at(-1);
      const preamble = doc.pieces.filter(p => ['namespace', 'from'].includes(p.tokens[0].value)).at(-1);
      recovered = parse(doc.text.slice(0, last?.end || preamble?.tokens.at(-1).end || 0), doc.uri);
    }
    Object.assign(recovered, { prefix: doc.prefix, repository: doc.repository, builtin: doc.builtin });
    const root = rootFor(doc.uri);
    const siblings = [...this.documents.values()].filter(d => !d.transactionLanguage && d !== doc && root && rootFor(d.uri) === root).map(d => Object.assign(parse(d.text, d.uri), { prefix: d.prefix, repository: d.repository, builtin: d.builtin }));
    validate([...siblings, recovered]);
    onRecovered?.(recovered);
    return recovered.scope;
  }
  typeScope(doc, context, offset) {
    if (!doc.errors.length) return doc.scope;
    const root = context.root, close = root.open === '<' ? '>' : ']';
    let depth = 0, end = -1;
    for (const token of doc.tokens) {
      if (token.start < root.token.start) continue;
      if (token.value === root.open) depth++;
      if (token.value === close && --depth === 0) { end = token.end; break; }
    }
    if (end < offset) {
      const nextLine = doc.text.indexOf('\n', offset), nextBrace = doc.text.indexOf('}', offset);
      end = Math.min(...[nextLine, nextBrace, doc.text.length].filter(n => n >= offset));
    }
    let text = doc.text.slice(0, root.name.start) + 'string' + doc.text.slice(end);
    let recovered = parse(text, doc.uri);
    if (recovered.errors.length && end === doc.text.length) {
      const stack = [];
      for (const token of recovered.tokens) {
        if (['{', '('].includes(token.value)) stack.push(token.value);
        if ((token.value === '}' && stack.at(-1) === '{') || (token.value === ')' && stack.at(-1) === '(')) stack.pop();
      }
      text += stack.reverse().map(open => open === '{' ? '}' : ')').join('');
      recovered = parse(text, doc.uri);
    }
    Object.assign(recovered, { prefix: doc.prefix, repository: doc.repository, builtin: doc.builtin });
    if (recovered.errors.length) return doc.scope;
    const rootDir = rootFor(doc.uri);
    const siblings = [...this.documents.values()].filter(d => !d.transactionLanguage && d !== doc && rootDir && rootFor(d.uri) === rootDir).map(d => Object.assign(parse(d.text, d.uri), { prefix: d.prefix, repository: d.repository, builtin: d.builtin }));
    validate([...siblings, recovered]);
    return recovered.scope;
  }
  calculationDocument(doc, offset) {
    const before = doc.text.slice(0, offset);
    const descriptor = /::[a-z_0-9]*$/.test(before);
    if ((!doc.errors.length && !descriptor) || !(/(?:\.|::)[a-z_0-9]*$/.test(before) || /\b[a-z][a-z_0-9]*\([^()]*$/.test(before))) return doc;
    let prefix = /(?:\.|::)[a-z_0-9]*$/.test(before) ? before.replace(/[a-z_0-9]*$/, '__completion') : before;
    if (/[=,]\s*$/.test(prefix)) prefix += '__completion';
    const balance = doc.tokens.reduce((n, t) => n + Number(t.value === '(') - Number(t.value === ')'), 0);
    const suffix = ')'.repeat(Math.max(0, balance)) + doc.text.slice(offset);
    let recovered = parse(prefix + suffix, doc.uri);
    if (descriptor && !/^[a-z_0-9]*\s*\(/.test(doc.text.slice(offset)) && recovered.declarations.flatMap(d => d.fields).some(f => f.calculation && f.token.start <= offset && offset <= f.end)) recovered = parse(prefix + '()' + suffix, doc.uri);
    Object.assign(recovered, { prefix: doc.prefix, repository: doc.repository, builtin: doc.builtin });
    if (recovered.errors.length) return doc;
    const root = rootFor(doc.uri);
    const siblings = [...this.documents.values()].filter(d => !d.transactionLanguage && d !== doc && root && rootFor(d.uri) === root).map(d => Object.assign(parse(d.text, d.uri), { prefix: d.prefix, repository: d.repository, builtin: d.builtin }));
    validate([...siblings, recovered]);
    return recovered;
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
    if (doc.transactionLanguage) {
      if (method === 'textDocument/definition') return transactionModels.definition(doc, params.position);
      if (method === 'textDocument/formatting') {
        const newText = transactions.format(doc);
        return newText === null || newText === doc.text ? [] : [{ range: range(doc.text, 0, doc.text.length), newText }];
      }
      if (method === 'textDocument/completion') return { isIncomplete: false, items: transactionModels.completion(doc, params.position) ?? transactions.keywords.map(label => ({ label, kind: 14 })) };
      if (method === 'textDocument/semanticTokens/full') return { data: [] };
      if (method === 'textDocument/documentSymbol') return (doc.ast?.groups || []).map(g => ({ name: g.name.text, kind: 3, range: g.name.range, selectionRange: g.name.range, children: [] }));
      return null;
    }
    if (params.position && doc.blocks.some(b => { const r = range(doc.text, b.start, b.end); return params.position.line >= r.start.line && params.position.line <= r.end.line; })) return null;
    const token = params.position && this.tokenAt(doc, params.position);
    const target = token && doc.bindings.get(token.start);
    const expressionNodes = doc.declarations.flatMap(d => [...nodes(d), ...d.fields.flatMap(nodes)]);
    if (method === 'textDocument/definition') {
      const targets = token && doc.markerTargets.get(token.start);
      if (targets) return targets.map(field => ({ uri: field.doc.uri, range: field.name.range }));
      if (target?.kind === 'decorator' && ['override', 'overload'].includes(token.value)) return null;
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
      const computation = token && doc.declarations.flatMap(d => d.fields).find(f => f.calculation && f.token.start <= token.start && token.end <= f.end);
      if (token?.value === 'input' && computation) return { contents: { kind: 'plaintext', value: inputTypeHelp(computation) }, range: token.range };
      const invoked = token && expressionNodes.find(n => ['call', 'recover'].includes(n.kind) && (n.operands[0].memberToken || (n.operands[0].kind === 'name' ? n.operands[0].token : null))?.start === token.start);
      if (invoked) return { contents: { kind: 'plaintext', value: methodHelp(token.value, invoked) || 'Unknown calculation method' }, range: token.range };
      if (token && /\binput\.$/.test(doc.text.slice(0, token.start))) {
        const parameter = computation?.inferredInputs?.find(p => p.name === token.value);
        if (parameter) return { contents: { kind: 'plaintext', value: `input.${parameter.name}: ${typeLabel(parameter.type)}${parameter.default ? ' = ' + defaultLabel(parameter.default) : parameter.required ? ' (required)' : ' (optional)'}${parameter.description ? '\n\n' + parameter.description : ''}\n\nExternal computation input. Bind with name=input.name; defaults apply only when omitted.` }, range: token.range };
      }
      if (token?.value === 'subtypes' && target?.kind === 'entity') return { contents: { kind: 'plaintext', value: target.name.value + '::subtypes: ' + help.subtypes }, range: token.range };
      const value = target ? describe(target) + (target.kind === 'decorator' && help[token.value] ? '\n\n' + help[token.value] : '') : token && (help[token.value] || (values.includes(token.value) ? `Built-in value type: ${token.value}` : null));
      return value ? { contents: { kind: 'plaintext', value }, range: token.range } : null;
    }
    if (method === 'textDocument/signatureHelp') {
      const offset = doc.text.split('\n').slice(0, params.position.line).reduce((n, line) => n + line.length + 1, 0) + params.position.character;
      const previous = doc.tokens.findLast(t => t.end <= offset);
      if (doc.comments.some(c => c.start <= offset && offset <= c.end) || doc.tokens.some(t => t.value.startsWith("'") && t.start < offset && offset < t.end) || doc.text.slice(previous?.end ?? 0, offset).includes("'")) return null;
      const typeContext = typeTools.context(doc, offset);
      if (typeContext) return typeTools.signatureHelp(typeContext);
      const calculationDoc = this.calculationDocument(doc, offset);
      const call = calculationDoc.declarations.flatMap(d => [...nodes(d), ...d.fields.flatMap(nodes)]).filter(n => ['call', 'recover'].includes(n.kind) && n.operands[0].end < offset && offset < n.end).sort((a, b) => b.operands[0].end - a.operands[0].end)[0];
      if (!call) return null;
      const name = call.operands[0].value;
      const parameters = (call.parameters || []).map(p => ({ label: `${p.name}: ${typeLabel(p.type)}`, documentation: p.default ? 'Default: ' + defaultLabel(p.default) : p.required ? 'Unbound inputs are inferred into the caller.' : 'Optional selection parameter.' }));
      const argument = call.arguments.find(a => a.token.start <= offset && offset <= a.expression.end);
      const supplied = new Set(call.arguments.filter(a => a.expression.end < offset).map(a => a.name));
      const active = Math.max(0, call.parameters?.findIndex(p => argument?.name ? p.name === argument.name : !supplied.has(p.name)) ?? 0);
      return { signatures: [{ label: call.parameters ? `${name}(${parameters.map(p => p.label).join(', ')}) -> ReadResult<${typeLabel(call.inferred?.type)}>` : methodHelp(name, call)?.split('\n')[0] || name, documentation: methodHelp(name, call), parameters }], activeSignature: 0, activeParameter: active };
    }
    if (method === 'textDocument/completion') {
      const offset = doc.text.split('\n').slice(0, params.position.line).reduce((n, line) => n + line.length + 1, 0) + params.position.character;
      const before = doc.text.slice(0, offset);
      if (doc.comments.some(c => c.start <= offset && offset <= c.end) || doc.tokens.some(t => t.value.startsWith("'") && t.start < offset && offset < t.end)) return { isIncomplete: false, items: [] };
      const subtypeMember = /\b([A-Z][A-Za-z_0-9]*)::subtypes\.([A-Za-z_0-9]*)$/.exec(before);
      const subtypeDescriptor = /\b([A-Z][A-Za-z_0-9]*)::([a-z_0-9]*)$/.exec(before);
      if (subtypeMember || subtypeDescriptor) {
        const match = subtypeMember || subtypeDescriptor;
        const scope = doc.errors.length ? this.completionScope(doc, match.index, offset) : doc.scope;
        const owner = scope.get(match[1]);
        if (owner?.kind === 'entity') return { isIncomplete: false, items: subtypeMember ? codeEntries(owner.subtypes).map(e => ({ label: e.name.value, kind: 20, detail: describe(e) })) : [{ label: 'subtypes', kind: 10, detail: 'Derived Decodes of strict descendant entities' }] };
      }
      const typeContext = typeTools.context(doc, offset);
      if (typeContext && !/::[a-z_]*$/.test(before) && !/\bself(?:\.[A-Za-z_][A-Za-z_0-9]*(?:::value)?)*\.[A-Za-z_0-9]*$/.test(before) && !/\b[A-Z][A-Za-z_0-9]*\.[A-Za-z_0-9]*$/.test(before)) {
        const scope = this.typeScope(doc, typeContext, offset);
        const symbols = new Map([...this.documents.values()].flatMap(d => [...(d.scope || new Map()).values()].map(decl => [decl.key, decl])));
        for (const declaration of scope.values()) symbols.set(declaration.key, declaration);
        return { isIncomplete: false, items: typeTools.completions(typeContext, scope, symbols, describe, Resolver) };
      }
      const calculationDoc = this.calculationDocument(doc, offset);
      const computation = calculationDoc.declarations.flatMap(d => d.fields).find(f => f.calculation && f.token.start <= offset && offset <= f.end);
      const constantContext = calculationDoc.declarations.find(d => d.kind === 'constant' && d.token.start <= offset && offset <= d.end);
      const builtinCall = /\b([a-z][a-z_0-9]*)\(([^()]*)$/.exec(before);
      const builtinSignature = builtinCall && require('./language/conversions.cjs').signatures[builtinCall[1]];
      if (builtinSignature && /(?:^|,)\s*[a-z_0-9]*$/.test(builtinCall[2])) {
        const used = new Set([...builtinCall[2].matchAll(/\b([a-z][a-z_0-9]*)\s*=/g)].map(m => m[1]));
        return { isIncomplete: false, items: builtinSignature.filter(([name]) => !used.has(name)).map(([label, type]) => ({ label, kind: 5, insertText: label + '=', detail: type })) };
      }
      if (/::[a-z_]*$/.test(before)) {
        const fieldName = /\.([a-z][a-z0-9_]*)::[a-z_]*$/.exec(before);
        const memberStart = fieldName ? before.length - fieldName[0].length + 1 : -1;
        const selected = calculationDoc.bindings.get(memberStart);
        const operator = /::[a-z_]*$/.exec(before);
        const receiver = calculationDoc.accessTerms?.get(operator.index);
        const labels = computation ? selected ? selected.mode === 'computed' ? ['value'] : ['value', 'best_available'] : [] : receiver?.sort === 'field' ? ['type', ...(receiver.instance ? ['value'] : []), ...(receiver.source?.owner?.kind === 'entity' ? ['entity'] : [])] : [];
        return { isIncomplete: false, items: labels.map(label => computation ? { label, kind: 2, detail: methodHelp(label), insertText: label + '($0)', insertTextFormat: 2 } : { label, kind: 10, detail: help[label] || help.self }) };
      }
      if (/\binput\.[a-z_0-9]*$/.test(before) && computation) return { isIncomplete: false, items: (computation.inferredInputs || []).filter(p => p.name !== '__completion').map(p => ({ label: p.name, kind: 5, detail: typeLabel(p.type) + (p.default ? ' = ' + defaultLabel(p.default) : p.required ? ' (required)' : ' (optional)'), documentation: p.description })) };
      const member = /\.([a-z_0-9]*)$/.exec(before);
      if (member && (computation || constantContext)) {
        const expression = nodes(computation || constantContext).find(n => n.kind === 'member' && n.memberToken?.start === member.index + 1);
        const receiver = expression?.operands[0]?.inferred?.type;
        if (receiver && receiver.kind !== 'unknown') {
          const symbols = new Map([...this.documents.values(), calculationDoc].flatMap(d => [...d.scope.values()].map(s => [s.key, s])));
          const owner = symbols.get(receiver.key);
          const fields = new Map(owner?.kind === 'value' ? owner.fields.map(f => [f.name.value, f]) : owner?.effective || []);
          // Descendant-only fields are legal reads and may yield NOT_DEFINED.
          if (receiver.kind === 'reference' && owner) {
            let root = owner; while (root.base) root = root.base;
            for (const candidate of symbols.values()) if (candidate.kind === 'entity') {
              let ancestor = candidate; while (ancestor.base) ancestor = ancestor.base;
              if (ancestor === root) for (const [name, field] of candidate.effective || []) if (!fields.has(name)) fields.set(name, field);
            }
          }
          const items = [...fields].map(([label, field]) => ({ label, kind: 5, detail: describe(field) }));
          if (receiver.name === 'partial') items.push(...['value', 'issues'].map(label => ({ label, kind: 5, detail: label === 'value' ? typeLabel(receiver.args[0]) : 'Immutable issue details' })));
          if (computation) items.push(...methodNames(receiver).map(label => ({ label, kind: 2, detail: methodHelp(label), insertText: label + '($0)', insertTextFormat: 2 })));
          return { isIncomplete: false, items };
        }
      }
      if (member && !computation) {
        const receiver = calculationDoc.accessTerms?.get(member.index);
        if (receiver) {
          const symbols = new Map([...calculationDoc.scope.values()].map(d => [d.key, d]));
          if (receiver.dictionary) return { isIncomplete: false, items: codeEntries(receiver.dictionary).map(e => ({ label: e.name.value, kind: 20, detail: describe(e) })) };
          const enclosing = calculationDoc.declarations.find(d => d.bodyStart <= offset && offset <= d.end);
          const owner = receiver.path === 'self' ? calculationDoc.scope.get(enclosing?.name.value) : symbols.get(receiver.type.key);
          return { isIncomplete: false, items: [...(owner?.effective || [])].map(([label, field]) => ({ label, kind: 5, detail: describe(field) })) };
        }
      }
      const fieldCall = /\.([a-z][a-z0-9_]*)::(best_available|value)\(([^()]*)$/.exec(before);
      if (fieldCall && /(?:^|,)\s*[a-z_0-9]*$/.test(fieldCall[3])) {
        const field = calculationDoc.bindings.get(fieldCall.index + 1);
        const inputs = [];
        const analyzed = computation && nodes(computation).find(n => n.kind === 'call' && n.operands[0].operands[0]?.memberToken?.start === fieldCall.index + 1);
        if (analyzed?.parameters) inputs.push(...analyzed.parameters.map(p => ({ name: p.name, detail: typeLabel(p.type) + (p.default ? ' = ' + defaultLabel(p.default) : ''), documentation: p.description })));
        else if (field?.mode === 'computed') inputs.push(...(field.inferredInputs || []).map(p => ({ name: p.name, detail: typeLabel(p.type), documentation: p.description })));
        else if (field) {
          if (['snapshot', 'scd'].includes(field.mode)) inputs.push({ name: field.metadata.find(c => c.name === 'temporal')?.dimensions[0]?.token.value || 'as_of_date', detail: 'date' });
          for (const call of field.metadata.filter(c => c.name === 'dimension')) {
            const d = call.dimension;
            if (!d) continue;
            inputs.push({ name: d.value.value, detail: 'Explicit dimension value' });
            if (fieldCall[2] === 'best_available' && d.hierarchy) inputs.push({ name: d.hierarchy.value, detail: 'Hierarchy selector' });
          }
        }
        const used = new Set([...fieldCall[3].matchAll(/\b([a-z][a-z0-9_]*)\s*=/g)].map(m => m[1]));
        return { isIncomplete: false, items: inputs.filter(p => !used.has(p.name)).map(p => ({ label: p.name, kind: 5, insertText: p.name + '=', detail: p.detail, documentation: p.documentation })) };
      }
      const call = /@([a-z][a-z0-9_]*)\(([^@{}()]*)$/.exec(before);
      if (call && !/\bdecorator\s*$/.test(before.slice(0, call.index)) && /(?:^|,)\s*[a-z_0-9]*$/.test(call[2])) {
        const close = doc.text.indexOf(')', offset);
        const scope = doc.errors.length ? this.completionScope(doc, call.index, close < 0 ? offset : close + 1) : doc.scope;
        const declaration = scope.get(call[1]);
        if (call[1] === 'dimension') {
          const surrounding = doc.declarations.find(d => d.bodyStart <= offset && offset <= d.end);
          let owner = surrounding && scope.get(surrounding.name.value);
          const dimensions = new Map(), seen = new Set();
          while (owner && !seen.has(owner)) { seen.add(owner); for (const [name, dimension] of owner.ownDimensions || []) if (!dimensions.has(name)) dimensions.set(name, dimension); owner = owner.base; }
          return { isIncomplete: false, items: [...dimensions].map(([label, d]) => ({ label, kind: 5, detail: describe(d) })) };
        }
        const used = new Set([...call[2].matchAll(/\b([a-z][a-z0-9_]*)\s*=/g)].map(m => m[1]));
        const items = declaration?.kind === 'decorator' ? declaration.parameters.filter(p => !p.pair && !used.has(p.name.value)).map(p => ({ label: p.name.value, kind: 5, insertText: p.name.value + '=', detail: describe(p) })) : [];
        if (declaration?.kind === 'decorator' && !used.has('description')) items.push({ label: 'description', kind: 5, insertText: 'description=', detail: 'Optional trailing string metadata.' });
        return { isIncomplete: false, items };
      }
      const decorator = /@[a-z_0-9]*$/.exec(before);
      if (decorator) {
        const used = new Set();
        const sites = decoratorSites(doc, decorator.index, used);
        if (!sites.length) return { isIncomplete: false, items: [] };
        let completionDoc = doc;
        const scope = doc.errors.length ? this.completionScope(doc, decorator.index, offset, true, recovered => { completionDoc = recovered; }) : doc.scope;
        const symbols = new Map([...scope.values()].map(d => [d.key, d]));
        const targetDeclaration = completionDoc.declarations.find(d => d.metadata?.some(a => a.token.start === decorator.index));
        const field = completionDoc.declarations.flatMap(d => d.fields).find(f => f.metadata.some(a => a.token.start === decorator.index));
        const collection = field && new Resolver(completionDoc, () => {}, symbols, field.owner).resolve(field.type).kind === 'collection';
        const usedKeys = new Set([...used].map(name => scope.get(name)?.key));
        const applicable = [...scope.values()].filter(d => {
          if (d.kind !== 'decorator') return false;
          if (d.name.value === 'decodes_rank' && targetDeclaration?.kind === 'entity' && !targetDeclaration.parent) return false;
          if (collection && ['sparse', 'dense'].includes(d.name.value)) return false;
          if (usedKeys.has(d.key) && !allowsMultiple(d)) return false;
          if (['sparse', 'dense'].includes(d.name.value) && ['sparse', 'dense', 'dimension'].some(name => used.has(name))) return false;
          if (d.name.value === 'dimension' && ['sparse', 'dense'].some(name => used.has(name))) return false;
          const contract = targetContract(d, symbols);
          return sites.some(([kind, mode]) => allowsTarget(contract, kind, mode));
        });
        return { isIncomplete: false, items: applicable.map(d => ({ label: d.name.value, kind: 3, detail: describe(d) })) };
      }
      const selfPath = /\bself(?:\.[a-zA-Z_][a-zA-Z_0-9]*(?:::value)?)*\.[a-zA-Z_0-9]*$/.exec(doc.text.slice(0, offset));
      const codePath = /\b([A-Z][a-zA-Z_0-9]*)\.[a-zA-Z_0-9]*$/.exec(doc.text.slice(0, offset));
      if (selfPath || codePath) {
        let completionDoc = doc;
        if (doc.errors.length) {
          const prefix = doc.text.slice(0, offset).replace(/[a-zA-Z_0-9]*$/, '__completion');
          const recovered = Object.assign(parse(prefix + doc.text.slice(offset), doc.uri), { prefix: doc.prefix, repository: doc.repository, builtin: doc.builtin });
          if (!recovered.errors.length) {
            const root = rootFor(doc.uri);
            const siblings = [...this.documents.values()].filter(d => !d.transactionLanguage && d !== doc && root && rootFor(d.uri) === root).map(d => Object.assign(parse(d.text, d.uri), { prefix: d.prefix, repository: d.repository, builtin: d.builtin }));
            validate([...siblings, recovered]); completionDoc = recovered;
          }
        }
        if (codePath) {
          const scope = completionDoc.errors.length ? this.completionScope(doc, codePath.index, offset) : completionDoc.scope;
          const dictionary = scope.get(codePath[1]);
          return { isIncomplete: false, items: dictionary?.kind === 'decodes' ? codeEntries(dictionary).map(e => ({ label: e.name.value, kind: 20, detail: describe(e) })) : [] };
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
      if (member) return { isIncomplete: false, items: [] };
      const items = [...keywords, ...annotations, ...values, ...generics, ...entities, ...structures, 'Entity', ...constants].map(label => ({ label, kind: constants.includes(label) ? 21 : 14, detail: help[label] || 'YAMBL built-in' }));
      if (computation || constantContext) {
        for (const [label, parameters] of Object.entries(require('./language/conversions.cjs').signatures)) items.push({ label, kind: 3, detail: `${label}(${parameters.map(p => p.join(': ')).join(', ')})`, insertText: label + '($0)', insertTextFormat: 2 });
        if (computation) items.push({ label: 'input', kind: 6, detail: 'External input: input.name; omitted input fallback: input.name ?? expression', insertText: 'input.${1:name}', insertTextFormat: 2 });
        const context = (computation ? nodes(computation) : []).filter(n => n.environment && n.token.start <= offset && offset <= n.end).sort((a, b) => (a.end - a.token.start) - (b.end - b.token.start))[0];
        for (const [label, value] of context?.environment || []) items.push({ label, kind: 6, detail: typeLabel(value.type) });
      }
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
