'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { parse, format, range, position, stringValue, keywords, annotations, values, generics, entities, structures, constants, resultConstants } = require('./language/syntax.cjs');
const { validate, describe, formatType } = require('./language/validation.cjs');
const { typeLabel, methodNames, methodHelp, nodes, defaultLabel, inputTypeHelp } = require('./language/calculation-tools.cjs');
const typeTools = require('./language/type-tools.cjs');

const { sources, readPrefix, rootName, configError } = require('./repository.cjs');
const { modelRoot } = require('./language/relationships.cjs');
const { Resolver, accepts } = require('./language/expressions.cjs');
const { lookupSupported } = require('./language/computation.cjs');
const { codeEntries } = require('./language/decodes.cjs');
const transactions = require('./transactions/syntax.cjs');
const transactionModels = require('./transactions/model.cjs');
const transactionValidation = require('./transactions/validation.cjs');
const isTransaction = (uri, item) => /\.(yaplan|yatran)$/i.test(uri) || ['yaplan', 'yatran'].includes(item?.languageId);
const { targetContract, allowsTarget, allowsMultiple } = require('./language/decorators.cjs');

function bodyContext(doc, offset) {
  const stack = []; let segment = [];
  for (const token of doc.tokens) {
    if (token.start >= offset) break;
    if (token.value === '{') {
      stack.push(segment.findLast(t => ['entity', 'extend', 'value', 'decodes', 'lookup', 'constraint', 'dimension', 'hierarchy', 'computed'].includes(t.value))?.value || 'block');
      segment = [];
    } else if (token.value === '}') { stack.pop(); segment = []; }
    else segment.push(token);
  }
  return stack.at(-1);
}

function recoverMalformedLookup(doc) {
  const error = doc.errors[0]?.range.start;
  if (!error) return null;
  const offset = doc.text.split('\n').slice(0, error.line).reduce((n, line) => n + line.length + 1, 0) + error.character;
  for (let i = 0; i < doc.tokens.length; i++) {
    const token = doc.tokens[i];
    if (token.value !== 'lookup') continue;
    const open = doc.tokens[i + 1]?.value === '{' ? i + 1 : doc.tokens[i + 2]?.value === '{' ? i + 2 : -1;
    let depth = 0, end = null;
    if (open < 0 && doc.tokens[i + 2]?.value === '}') end = doc.tokens[i + 1].end;
    if (open >= 0) for (let j = open; j < doc.tokens.length; j++) {
      if (doc.tokens[j].value === '{') depth++;
      if (doc.tokens[j].value === '}' && --depth === 0) { end = doc.tokens[j].end; break; }
    }
    const atEof = end === null && offset === doc.text.length;
    if (atEof) end = doc.text.length;
    if (end === null || offset < token.start || offset > (open < 0 && !atEof ? doc.tokens[i + 2].start : end)) continue;
    const masked = doc.text.slice(0, token.start) + doc.text.slice(token.start, end).replace(/[^\r\n]/g, ' ') + doc.text.slice(end);
    const outerDepth = atEof ? doc.tokens.slice(0, i).reduce((n, t) => n + Number(t.value === '{') - Number(t.value === '}'), 0) : 0;
    const recovered = parse(masked + '}'.repeat(Math.max(0, outerDepth)), doc.uri);
    if (!recovered.errors.length) return { start: token.start, end, doc: recovered };
  }
  return null;
}

function validationCopy(doc) {
  const parsed = parse(doc.text, doc.uri);
  const copy = recoverMalformedLookup(parsed)?.doc || parsed;
  return Object.assign(copy, { text: doc.text, prefix: doc.prefix, repository: doc.repository, builtin: doc.builtin });
}

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
    if (next === 'lookup') return owner === 'value' ? [] : [['Lookup']];
    if (next && next !== '}' && !['attr', 'static', 'config', 'snapshot', 'scd', 'computed'].includes(next)) return [];
    if (owner === 'value') return !next || ['}', 'attr', 'static'].includes(next) ? [['ValueAttr', 'static']] : [];
    if (next && next !== '}') return [['EntityAttr', next === 'attr' ? 'static' : next]];
    return owner === 'entity' ? [['Id'], ['EntityAttr'], ['Lookup']] : [['EntityAttr'], ['Lookup']];
  }
  const kind = { entity: 'Entity', value: 'Value', decodes: 'Decodes', type: 'Type', decorator: 'Decorator', final: 'Entity', abstract: 'Entity' }[next];
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
  abstract: 'An abstract entity cannot be instantiated. An abstract computed field declares a contract implemented by concrete descendants.',
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
  exact: 'Singleton constraint defined by a compile-time value.',
  as: 'Bind a mapping key for its value type expression.',
  ...Object.fromEntries(Object.entries(resultConstants).map(([name, meaning]) => [name, `${meaning}\n\nCalculation results support explicit recover; PARTIAL requires a payload and issue details.`])),
  title: 'Short display title.', description: 'Descriptive metadata.',
  temporal: 'One caller-named date parameter on snapshot or scd attr.', dimension: 'Independent data dimension with an optional Hierarchy selector.',
  relationship: 'Declare source and target cardinality for a stored entity reference.', reverse_relationship: 'Read source entities through a declared forward relationship.',
  decorator: 'Declare typed metadata with value parameters and caller-defined key/type pairs.',
  targets: 'Declare the allowed definition kinds and optional attribute categories for a decorator.',
  allow_multiple: 'Allow repeated uses of the decorated decorator on one definition.',
  input: 'External computation input: input.name. Rename or bind with name=input.name; input.name ?? expression supplies a value only when omitted.',
  '??': 'Omitted-input fallback. The left operand is input.name; the right operand is lazy. Caller values and declaration defaults take precedence. Native non-normal results require recover.',
  input_type: 'Decorator pair constraint accepting non-collection value types or entity references. Not a runtime field type.',
  extra_input_param: 'Declare one optional computed-field or lookup input, with an optional default and trailing description. Repeat for different names. Types merge with inferred dependencies; declaration defaults take precedence over ??.',
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
      const docs = [...texts.values()].map(item => {
        const original = parse(item.text, item.uri), recovery = recoverMalformedLookup(original);
        const doc = recovery?.doc || original;
        if (recovery) { doc.text = item.text; doc.lookupOriginal = original; }
        return Object.assign(doc, { prefix, repository: !builtin && root ? uriKey(pathToFileURL(root).href) : '', builtin });
      });
      for (const doc of docs) if (builtin && doc.namespace !== 'builtins') doc.errors.push({ range: range(doc.text, 0, 0), severity: 1, message: 'built-in models must declare namespace builtins', source: 'yambl' });
      const symbols = validate(docs);
      for (const doc of docs) if (doc.lookupOriginal) {
        doc.errors = doc.lookupOriginal.errors;
        doc.tokens = doc.lookupOriginal.tokens;
        doc.blocks = doc.lookupOriginal.blocks;
        doc.diagnostics.push(...doc.errors);
        doc.diagnostics.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character || a.message.localeCompare(b.message));
      }
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
    return [...(doc.patternTokens?.values() || []), ...doc.tokens].find(t => t.range.start.line === pos.line && t.range.start.character <= pos.character && pos.character < t.range.end.character);
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
    const siblings = [...this.documents.values()].filter(d => !d.transactionLanguage && d !== doc && root && rootFor(d.uri) === root).map(validationCopy);
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
    const siblings = [...this.documents.values()].filter(d => !d.transactionLanguage && d !== doc && rootDir && rootFor(d.uri) === rootDir).map(validationCopy);
    validate([...siblings, recovered]);
    return recovered.scope;
  }
  calculationDocument(doc, offset) {
    const before = doc.text.slice(0, offset);
    const descriptor = /::[a-z_0-9]*$/.test(before);
    const lookupContext = bodyContext(doc, offset) === 'lookup';
    const incompleteLookupArgument = lookupContext && /::value\([^()]*,\s*[a-z_0-9]+$/.test(before) && !/^[a-z_0-9]*\s*=/.test(doc.text.slice(offset));
    if ((!doc.errors.length && !descriptor && !incompleteLookupArgument) || !(/(?:\.|::)[a-z_0-9]*$/.test(before) || /\b[a-z][a-z_0-9]*\([^()]*$/.test(before))) return doc;
    const lookupDescriptor = descriptor && lookupContext;
    const lookupMember = lookupContext && !descriptor && /\.[a-z_0-9]*$/.test(before) && !/\binput\.[a-z_0-9]*$/.test(before);
    let prefix = /(?:\.|::)[a-z_0-9]*$/.test(before) ? before.replace(/[a-z_0-9]*$/, lookupDescriptor ? 'value' : '__completion') : before;
    if (lookupContext && /::value\([^()]*,\s*[a-z_0-9]*$/.test(prefix)) prefix = prefix.replace(/[a-z_0-9]*$/, 'completion=input.completion');
    else if (/[=,]\s*$/.test(prefix)) prefix += '__completion';
    const balance = doc.tokens.reduce((n, t) => n + Number(t.value === '(') - Number(t.value === ')'), 0);
    const remainder = lookupDescriptor || lookupMember ? doc.text.slice(offset).replace(/^[a-z_0-9]*/, '') : doc.text.slice(offset);
    if (lookupDescriptor && !/^\s*\(/.test(remainder)) prefix += '()';
    if (lookupMember && !/^\s*(?:[.:]|\()/.test(remainder)) prefix += '::value()';
    const suffix = ')'.repeat(Math.max(0, balance)) + remainder;
    let recovered = parse(prefix + suffix, doc.uri);
    if (descriptor && !lookupDescriptor && !/^[a-z_0-9]*\s*\(/.test(doc.text.slice(offset)) && recovered.declarations.some(d => [...d.fields.filter(f => f.calculation), ...(d.lookups || []), ...(d.constraints || [])].some(f => f.token.start <= offset && offset <= f.end))) recovered = parse(prefix + '()' + suffix, doc.uri);
    Object.assign(recovered, { prefix: doc.prefix, repository: doc.repository, builtin: doc.builtin });
    if (recovered.errors.length) return doc;
    const root = rootFor(doc.uri);
    const siblings = [...this.documents.values()].filter(d => !d.transactionLanguage && d !== doc && root && rootFor(d.uri) === root).map(validationCopy);
    validate([...siblings, recovered]);
    return recovered;
  }
  references(target, includeDeclaration) {
    const locations = [];
    if (!target) return locations;
    for (const doc of this.documents.values()) for (const token of [...doc.tokens, ...(doc.patternTokens?.values() || [])]) {
      if (doc.bindings.get(token.start) !== target) continue;
      if (!includeDeclaration && target.kind !== 'lookup_input' && uriKey(doc.uri) === uriKey(target.doc.uri) && token.start === target.name.start) continue;
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
    const expressionNodes = doc.declarations.flatMap(d => [...nodes(d), ...d.fields.flatMap(nodes), ...(d.lookups || []).flatMap(nodes), ...(d.constraints || []).flatMap(nodes)]);
    if (method === 'textDocument/definition') {
      const targets = token && doc.markerTargets.get(token.start);
      if (targets) return targets.map(field => ({ uri: field.doc.uri, range: field.name.range }));
      if (target?.kind === 'decorator' && ['override', 'overload'].includes(token.value)) return null;
      return target ? { uri: target.doc.uri, range: target.name.range } : null;
    }
    if (method === 'textDocument/references') return this.references(target, params.context?.includeDeclaration === true);
    if (method === 'textDocument/semanticTokens/full') {
      const classified = new Map(doc.valueTypeTokens);
      for (const token of doc.tokens) if (['decodes', 'hierarchy', 'value', 'type_alias'].includes(doc.bindings.get(token.start)?.kind)) classified.set(token.start, token);
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
      if (target?.kind === 'lookup') {
        const owner = target.entity?.name.value || target.owner.name.value;
        const snake = name => name.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase();
        const inputs = (target.inferredInputs || []).map(p => `${p.name}: ${typeLabel(p.type)}${p.default ? ' = ' + defaultLabel(p.default) : p.required ? '' : ' = ...'}`);
        const keys = target.keys.map(k => `${k.name.value}: ${typeLabel(k.resolvedType)}`);
        const matcher = owner + target.name.value.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('') + 'Matcher';
        const signature = name => `prepare_${snake(name)}_${target.name.value}(${inputs.length ? '*, ' : ''}${inputs.join(', ')}) -> Success<${matcher}> | NonNormalResult`;
        const descendants = new Map([...this.documents.values()].flatMap(d => [...(d.scope || new Map()).values()]).filter(d => d.kind === 'entity' && d.ancestors?.includes(target.entity)).map(d => [d.key, d.name.value]));
        const inherited = [...descendants.values()].sort().map(name => `\nInherited Python: ${signature(name)}`).join('');
        return { contents: { kind: 'plaintext', value: `lookup ${target.name.value}\nKeys: ${keys.join(', ') || '(none)'}\nPreparation parameters: ${inputs.join(', ') || '(none)'}\nCandidates: ${owner} and descendants\nPython: ${signature(owner)}${inherited}` }, range: token.range };
      }
      if (target?.kind === 'lookup_key') return { contents: { kind: 'plaintext', value: `${target.name.value}: ${typeLabel(target.resolvedType)}\nSource: ${doc.text.slice(target.expression.token.start, target.expression.end)}` }, range: token.range };
      if (target?.kind === 'lookup_input') return { contents: { kind: 'plaintext', value: `input.${target.name.value}: ${typeLabel(target.resolvedType)}${target.default ? ' = ' + defaultLabel(target.default) : target.required ? ' (required)' : ' (optional)'}` }, range: token.range };
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
      const decoratorCall = /@([a-z][a-z0-9_]*)\(([^@{}()]*)$/.exec(doc.text.slice(0, offset));
      if (decoratorCall && !/\bdecorator\s*$/.test(doc.text.slice(0, decoratorCall.index))) {
        const close = doc.text.indexOf(')', offset);
        const scope = doc.errors.length ? this.completionScope(doc, decoratorCall.index, close < 0 ? offset : close + 1) : doc.scope;
        const declaration = scope.get(decoratorCall[1]);
        if (declaration?.kind === 'decorator') {
          const parameters = declaration.parameters.map(p => ({ label: `${p.pair ? '*' : p.variadic ? '...' : ''}${p.name.value}${p.optional ? '?' : ''}: ${formatType(p.type)}` }));
          const active = Math.min(decoratorCall[2].split(',').length - 1, Math.max(0, parameters.length - 1));
          return { signatures: [{ label: `@${decoratorCall[1]}(${parameters.map(p => p.label).join(', ')})`, parameters }], activeSignature: 0, activeParameter: active };
        }
      }
      const calculationDoc = this.calculationDocument(doc, offset);
      const call = calculationDoc.declarations.flatMap(d => [...nodes(d), ...d.fields.flatMap(nodes), ...(d.lookups || []).flatMap(nodes), ...(d.constraints || []).flatMap(nodes)]).filter(n => ['call', 'recover'].includes(n.kind) && n.operands[0].end < offset && offset < n.end).sort((a, b) => b.operands[0].end - a.operands[0].end)[0];
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
      const literal = /\bstring\s*\[\s*(?:regex\s*:\s*)?('(?:\\.|[^'\\])*)$/.exec(before);
      const reference = literal && /(\\*)\$\{[a-z0-9_]*$/.exec(stringValue(literal[1] + "'"));
      if (reference && reference[1].length % 2 === 0 && !doc.comments.some(c => c.start <= offset && offset <= c.end)) {
        const context = typeTools.context(doc, offset);
        const scope = doc.errors.length && context ? this.typeScope(doc, context, offset) : doc.scope;
        const anchor = context?.root.name.start ?? literal.index;
        const current = [...scope.values()].find(declaration => declaration.kind === 'type_alias' && declaration.doc.uri === doc.uri && declaration.token.start <= anchor && anchor < declaration.end);
        const symbols = new Map([...this.documents.values()].flatMap(d => [...(d.scope || new Map()).values()].map(declaration => [declaration.key, declaration])));
        for (const declaration of scope.values()) symbols.set(declaration.key, declaration);
        const items = [...scope].filter(([, declaration]) => declaration.kind === 'type_alias' && !declaration.parameters.length && declaration.key !== current?.key).filter(([, declaration]) => {
          let invalid = false;
          const resolved = new Resolver(declaration.doc, (_doc, _token, _message, severity = 1) => { if (severity === 1) invalid = true; }, symbols, null, false, new Map(), current ? [current.key] : []).resolve(declaration.type);
          return !invalid && resolved.name === 'string' && resolved.params.some(([name]) => name === 'regex');
        }).map(([label, declaration]) => ({ label, kind: 7, detail: describe(declaration) }));
        return { isIncomplete: false, items };
      }
      if (doc.comments.some(c => c.start <= offset && offset <= c.end) || doc.tokens.some(t => t.value.startsWith("'") && t.start < offset && offset < t.end)) return { isIncomplete: false, items: [] };
      const hierarchyDefault = /\bhierarchy\s+[a-z][a-z0-9_]*\s*:\s*Hierarchy\s*=\s*([A-Za-z0-9_]*)$/.exec(before);
      if (hierarchyDefault) {
        const start = offset - hierarchyDefault[1].length;
        const scope = doc.errors.length ? this.completionScope(doc, start, offset) : doc.scope;
        return { isIncomplete: false, items: [...scope.values()].filter(d => d.kind === 'hierarchy' || (d.kind === 'decodes' && !require('./language/decodes.cjs').isFlags(d))).map(d => ({ label: d.name.value, kind: 6, detail: describe(d), ...(d.kind === 'decodes' ? { insertText: d.name.value + '::hierarchy()' } : {}) })) };
      }
      const subtypeMember = /\b([A-Z][A-Za-z_0-9]*)::subtypes\.([A-Za-z_0-9]*)$/.exec(before);
      const subtypeDescriptor = /\b([A-Z][A-Za-z_0-9]*)::([a-z_0-9]*)$/.exec(before);
      if (subtypeMember || subtypeDescriptor) {
        const match = subtypeMember || subtypeDescriptor;
        const scope = doc.errors.length ? this.completionScope(doc, match.index, offset) : doc.scope;
        const owner = scope.get(match[1]);
        if (owner?.kind === 'entity') return { isIncomplete: false, items: subtypeMember ? codeEntries(owner.subtypes).map(e => ({ label: e.name.value, kind: 20, detail: describe(e) })) : [{ label: 'subtypes', kind: 10, detail: 'Derived Decodes of strict descendant entities' }] };
        if (subtypeDescriptor && owner?.kind === 'decodes' && !require('./language/decodes.cjs').isFlags(owner)) return { isIncomplete: false, items: [{ label: 'hierarchy', kind: 2, detail: 'Read-only hierarchy view of this dictionary', insertText: 'hierarchy()', insertTextFormat: 2 }] };
      }
      const typeContext = typeTools.context(doc, offset);
      if (typeContext && !/::[a-z_]*$/.test(before) && !/\bself(?:\.[A-Za-z_][A-Za-z_0-9]*(?:::value)?)*\.[A-Za-z_0-9]*$/.test(before) && !/\b[A-Z][A-Za-z_0-9]*\.[A-Za-z_0-9]*$/.test(before)) {
        const scope = this.typeScope(doc, typeContext, offset);
        const symbols = new Map([...this.documents.values()].flatMap(d => [...(d.scope || new Map()).values()].map(decl => [decl.key, decl])));
        for (const declaration of scope.values()) symbols.set(declaration.key, declaration);
        return { isIncomplete: false, items: typeTools.completions(typeContext, scope, symbols, describe, Resolver) };
      }
      const calculationDoc = this.calculationDocument(doc, offset);
      const computation = calculationDoc.declarations.flatMap(d => [...d.fields.filter(f => f.calculation), ...(d.constraints || [])]).find(f => f.token.start <= offset && offset <= f.end);
      const lookup = calculationDoc.declarations.flatMap(d => d.lookups || []).find(l => l.token.start <= offset && offset <= l.end);
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
        const labels = lookup ? selected && ['id', 'static', 'scd'].includes(selected.mode) ? ['value'] : [] : computation ? selected ? selected.mode === 'computed' ? ['value'] : ['value', 'best_available', ...(selected.mode !== 'id' && !selected.metadata.some(call => call.name === 'reverse_relationship') ? ['records'] : [])] : [] : receiver?.sort === 'field' ? ['type', ...(receiver.instance ? ['value'] : []), ...(receiver.source?.owner?.kind === 'entity' ? ['entity'] : [])] : [];
        return { isIncomplete: false, items: labels.map(label => computation || lookup ? { label, kind: 2, detail: methodHelp(label), insertText: label + '($0)', insertTextFormat: 2 } : { label, kind: 10, detail: help[label] || help.self }) };
      }
      if (/\binput\.[a-z_0-9]*$/.test(before) && (computation || lookup)) return { isIncomplete: false, items: ((computation || lookup).inferredInputs || []).filter(p => p.name !== '__completion').map(p => ({ label: p.name, kind: 5, detail: typeLabel(p.type) + (p.default ? ' = ' + defaultLabel(p.default) : p.required ? ' (required)' : ' (optional)'), documentation: p.description })) };
      const relationshipCall = /@relationship\(([^()]*)$/.exec(before);
      if (relationshipCall) {
        const part = relationshipCall[1].split(',').at(-1).trim();
        const named = /^(x|y)\s*=\s*[a-z_0-9]*$/.exec(part);
        const key = named?.[1] || (relationshipCall[1].includes(',') ? 'y' : 'x');
        const field = doc.declarations.flatMap(d => d.fields).find(f => f.metadata.some(call => call.token.start === relationshipCall.index));
        const symbols = new Map([...doc.scope.values()].map(declaration => [declaration.key, declaration]));
        const fieldType = field && new Resolver(doc, () => {}, symbols, field.owner, true).resolve(field.type);
        const values = key === 'x' ? ['one', 'many'] : fieldType?.name === 'collection' ? ['maybe', 'many'] : fieldType?.kind === 'reference' ? ['maybe', 'one'] : ['maybe', 'one', 'many'];
        return { isIncomplete: false, items: values.map(label => ({ label, kind: 21, detail: 'Relationship cardinality' })) };
      }
      const reverseCall = /@reverse_relationship\(\s*(?:target\s*=\s*)?([A-Z][A-Za-z0-9]*)((?:\.[a-z][a-z0-9_]*)*\.[a-z_0-9]*)$/.exec(before);
      if (reverseCall) {
        const close = doc.text.indexOf(')', offset);
        const scope = doc.errors.length ? this.completionScope(doc, reverseCall.index, close < 0 ? offset : close + 1) : doc.scope;
        const symbols = new Map([...this.documents.values(), calculationDoc].flatMap(item => [...(item.scope || new Map()).values()].map(symbol => [symbol.key, symbol])));
        for (const symbol of scope.values()) symbols.set(symbol.key, symbol);
        let owner = scope.get(reverseCall[1]);
        const segments = reverseCall[2].split('.').slice(1, -1);
        for (const name of segments) {
          const field = owner?.effective?.get(name);
          if (!field) { owner = null; break; }
          const resolved = new Resolver(field.doc, () => {}, symbols, field.owner, true).resolve(field.type);
          owner = resolved.kind === 'reference' ? symbols.get(resolved.key) : null;
        }
        return { isIncomplete: false, items: [...(owner?.effective?.values() || [])].filter(field => {
          const relation = field.metadata.find(call => call.name === 'relationship');
          if (!relation || field.metadata.some(call => call.name === 'reverse_relationship')) return false;
          if (!segments.length) return true;
          const type = new Resolver(field.doc, () => {}, symbols, field.owner, true).resolve(field.type);
          return type.kind === 'reference' && relation.relationship?.[0] === 'one' && ['one', 'maybe'].includes(relation.relationship?.[1]);
        }).map(field => ({ label: field.name.value, kind: 5, detail: describe(field) })) };
      }
      const reverseOwner = /@reverse_relationship\(\s*(?:target\s*=\s*)?([A-Z][A-Za-z0-9]*)?$/.exec(before);
      if (reverseOwner) {
        const scope = doc.errors.length ? this.completionScope(doc, reverseOwner.index, offset) : doc.scope;
        return { isIncomplete: false, items: [...scope.values()].filter(owner => owner.kind === 'entity' && [...(owner.effective?.values() || [])].some(field => field.metadata.some(call => call.name === 'relationship'))).map(owner => ({ label: owner.name.value, kind: 7, insertText: owner.name.value + '.', detail: 'Entity with a forward relationship' })) };
      }
      const uniqueField = /@unique_by\([^@{}()]*\bself\.([a-z_0-9]*)$/.exec(before);
      if (uniqueField) {
        const close = doc.text.indexOf(')', offset); let recovered = doc;
        const scope = doc.errors.length ? this.completionScope(doc, uniqueField.index, close < 0 ? offset : close + 1, false, value => { recovered = value; }) : doc.scope;
        const owner = recovered.declarations.find(d => d.kind === 'entity' && d.token.start >= uniqueField.index);
        const symbols = new Map([...scope.values()].map(item => [item.key, item]));
        const items = [...(owner?.effective || [])].filter(([, field]) => field.mode === 'static' && !field.metadata.some(item => item.name === 'dimension') && new Resolver(field.doc, () => {}, symbols, field.owner, true).resolve(field.type).kind !== 'collection').map(([label, field]) => ({ label, kind: 5, detail: describe(field) }));
        return { isIncomplete: false, items };
      }
      const member = /\.([a-z_0-9]*)$/.exec(before);
      if (member && (computation || constantContext || lookup)) {
        const expression = nodes(computation || constantContext || lookup).find(n => n.kind === 'member' && n.memberToken?.start === member.index + 1);
        const receiver = expression?.operands[0]?.inferred?.type;
        if (receiver && receiver.kind !== 'unknown') {
          if (['record', 'selection', 'dimensions'].includes(receiver.name)) return { isIncomplete: false, items: receiver.params.map(([label], index) => ({ label, kind: 5, detail: typeLabel(receiver.args[index]) })) };
          const symbols = new Map([...this.documents.values(), calculationDoc].flatMap(d => [...d.scope.values()].map(s => [s.key, s])));
          const owner = symbols.get(receiver.key);
          const fields = new Map(owner?.kind === 'value' ? owner.fields.map(f => [f.name.value, f]) : owner?.effective || []);
          // Descendant-only fields are legal reads and may yield NOT_DEFINED.
          if (receiver.kind === 'reference' && owner) {
            let root = owner; while (root.base) root = root.base;
            for (const candidate of symbols.values()) if (candidate.kind === 'entity') {
              if (lookup && candidate !== owner && !candidate.ancestors?.includes(owner)) continue;
              let ancestor = candidate; while (ancestor.base) ancestor = ancestor.base;
              if (ancestor === root) for (const [name, field] of candidate.effective || []) if (!fields.has(name)) fields.set(name, field);
            }
          }
          const items = [...fields].flatMap(([label, field]) => {
            if (!lookup) return [{ label, kind: 5, detail: describe(field) }];
            if (!['id', 'static', 'scd'].includes(field.mode)) return [];
            const resolved = new Resolver(field.doc, () => {}, symbols, field.owner, true).resolve(field.type);
            if (!lookupSupported(resolved, symbols)) return [];
            return [{ label, kind: 5, detail: `${resolved.kind === 'reference' ? 'Entity reference; path can continue' : 'Value'} · ${describe(field)}` }];
          });
          if (receiver.name === 'partial') items.push(...['value', 'issues'].map(label => ({ label, kind: 5, detail: label === 'value' ? typeLabel(receiver.args[0]) : 'Immutable issue details' })));
          if (computation) items.push(...methodNames(receiver).map(label => ({ label, kind: 2, detail: methodHelp(label), insertText: label + '($0)', insertTextFormat: 2 })));
          return { isIncomplete: false, items };
        }
      }
      if (member && !computation && !lookup) {
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
      const boundArgument = lookup && fieldCall && /\b([a-z][a-z0-9_]*)\s*=\s*[a-zA-Z_0-9]*$/.exec(fieldCall[3]);
      if (boundArgument) {
        const analyzed = nodes(lookup).find(n => n.kind === 'call' && n.operands[0].operands[0]?.memberToken?.start === fieldCall.index + 1);
        const parameter = analyzed?.parameters?.find(p => p.name === boundArgument[1]);
        if (parameter) {
          const symbols = new Map([...calculationDoc.scope.values()].map(d => [d.key, d]));
          const dictionary = parameter.type.name === 'code' && symbols.get(parameter.type.args[0]?.key);
          const items = dictionary?.kind === 'decodes' ? codeEntries(dictionary).map(e => ({ label: `${dictionary.name.value}.${e.name.value}`, kind: 20, detail: describe(e) })) : [];
          for (const [label, declaration] of calculationDoc.scope) if (declaration.kind === 'constant') {
            const type = new Resolver(declaration.doc, () => {}, symbols, declaration, true).resolve(declaration.type);
            if (accepts(parameter.type, type, symbols)) items.push({ label, kind: 21, detail: describe(declaration) });
          }
          items.push({ label: 'input', kind: 6, insertText: 'input.${1:name}', insertTextFormat: 2, detail: `Rename ${parameter.name}: ${typeLabel(parameter.type)}` });
          return { isIncomplete: false, items };
        }
      }
      if (fieldCall && /(?:^|,)\s*[a-z_0-9]*$/.test(fieldCall[3])) {
        const field = calculationDoc.bindings.get(fieldCall.index + 1);
        const inputs = [];
        const analyzed = (computation || lookup) && nodes(computation || lookup).find(n => n.kind === 'call' && n.operands[0].operands[0]?.memberToken?.start === fieldCall.index + 1);
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
          for (const [name, dimension] of scope) if (dimension.kind === 'dimension' && !dimensions.has(name)) dimensions.set(name, dimension);
          return { isIncomplete: false, items: [...dimensions].map(([label, d]) => ({ label, kind: 5, detail: describe(d) })) };
        }
        const used = new Set([...call[2].matchAll(/\b([a-z][a-z0-9_]*)\s*=/g)].map(m => m[1]));
        const items = declaration?.kind === 'decorator' ? declaration.parameters.filter(p => !p.pair && !p.variadic && !used.has(p.name.value)).map(p => ({ label: p.name.value, kind: 5, insertText: p.name.value + '=', detail: describe(p) })) : [];
        if (call[1] === 'unique_by') items.push({ label: 'self', kind: 6, insertText: 'self.', detail: 'Field of the decorated entity.' });
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
        const fieldType = field && new Resolver(completionDoc, () => {}, symbols, field.owner).resolve(field.type);
        const collection = fieldType?.kind === 'collection';
        const usedKeys = new Set([...used].map(name => scope.get(name)?.key));
        const applicable = [...scope.values()].filter(d => {
          if (d.kind !== 'decorator') return false;
          if (d.name.value === 'decodes_rank' && targetDeclaration?.kind === 'entity' && !targetDeclaration.parent) return false;
          if (collection && ['sparse', 'dense'].includes(d.name.value)) return false;
          if (fieldType && fieldType.kind !== 'unknown' && ['relationship', 'reverse_relationship'].includes(d.name.value) && !(fieldType.kind === 'reference' || (fieldType.name === 'collection' && fieldType.args[0]?.kind === 'reference'))) return false;
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
            const siblings = [...this.documents.values()].filter(d => !d.transactionLanguage && d !== doc && root && rootFor(d.uri) === root).map(validationCopy);
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
      const items = [...keywords.filter(word => !['lookup', 'constraint', 'assert'].includes(word)), ...annotations, ...values, ...generics, ...entities, ...structures, 'Entity', ...constants].map(label => ({ label, kind: constants.includes(label) ? 21 : 14, detail: help[label] || 'YAMBL built-in' }));
      if (['entity', 'extend'].includes(bodyContext(doc, offset))) items.push({ label: 'lookup', kind: 15, detail: 'Named entity lookup rule', insertText: 'lookup ${1:name} {\n    ${2:key} = self.${3:field}::value()\n}', insertTextFormat: 2 });
      if (['entity', 'extend'].includes(bodyContext(doc, offset))) items.push({ label: 'constraint', kind: 15, detail: 'Entity constraint', insertText: 'constraint ${1:name} {\n    assert ${2:true}\n}', insertTextFormat: 2 });
      if (bodyContext(doc, offset) === 'constraint') items.push({ label: 'assert', kind: 14, detail: 'Check a boolean constraint expression' });
      if (computation || constantContext) {
        for (const [label, parameters] of Object.entries(require('./language/conversions.cjs').signatures)) items.push({ label, kind: 3, detail: `${label}(${parameters.map(p => p.join(': ')).join(', ')})`, insertText: label + '($0)', insertTextFormat: 2 });
        if (computation && computation.kind !== 'constraint') items.push({ label: 'input', kind: 6, detail: 'External input: input.name; omitted input fallback: input.name ?? expression', insertText: 'input.${1:name}', insertTextFormat: 2 });
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
      const lookupSymbol = (lookup, prefix = '') => ({ name: prefix + lookup.name.value, kind: 6,
        range: range(doc.text, lookup.token.start, lookup.end), selectionRange: lookup.name.range,
        children: lookup.keys.map(key => ({ name: key.name.value, kind: 8, range: range(doc.text, key.token.start, key.end), selectionRange: key.name.range })) });
      const members = (decl, prefix = '') => [...decl.fields.map(f => ({ start: f.token.start, symbol: fieldSymbol(f, prefix) })), ...(decl.lookups || []).map(l => ({ start: l.token.start, symbol: lookupSymbol(l, prefix) })), ...(decl.constraints || []).map(c => ({ start: c.token.start, symbol: { name: prefix + c.name.value, kind: 6, range: range(doc.text, c.token.start, c.end), selectionRange: c.name.range } }))].sort((a, b) => a.start - b.start).map(item => item.symbol);
      return doc.declarations.flatMap(decl => decl.kind === 'extend' ? members(decl, decl.name.value + '.') : [{
        name: decl.name.value, kind: decl.kind === 'entity' ? 5 : 10,
        range: range(doc.text, decl.metadata[0]?.token.start ?? decl.token.start, decl.end), selectionRange: decl.name.range,
        children: ['entity', 'value'].includes(decl.kind) ? members(decl) : decl.entries.map(e => ({ name: e.code.value, kind: 22, range: range(doc.text, e.token.start, e.value.end), selectionRange: e.code.range })),
      }]);
    }
    return null;
  }
}
module.exports = { Service, rootFor, sources, inside, uriKey };
