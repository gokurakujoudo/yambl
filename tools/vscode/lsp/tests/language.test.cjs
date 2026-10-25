'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, format, range } = require('../language/syntax.cjs');
const { validate } = require('../language/validation.cjs');
const cases = [...require('./cases.json'), ...require('./expression-cases.json'), ...require('./flags-cases.json'), ...require('./decorator-cases.json')];

test('ordinary attrs share static identity, targets and filtering', () => {
  const doc = parse('entity A { dimension sources { value source: string } @dimension(sources) attr label: string } entity B inherits A { @override @dimension(sources) static attr label: string }');
  validate([doc]); assert.deepEqual(doc.diagnostics, []);
  assert.equal(doc.scope.get('A').effective.get('label').mode, 'static');
  assert.equal(format(doc).includes('@dimension(sources)\n    attr label: string'), true);
  const invalid = parse('entity A { attr keys: attrs<AttrCats.Attr, A> }');
  validate([invalid]); assert.ok(invalid.diagnostics.some(d => d.message.includes('Attr')));
});

test('flags union selects categories, normalizes exact values and rejects invalid masks', () => {
  const { Resolver, equal } = require('../language/expressions.cjs');
  const doc = parse(require('./flags-cases.json')[0][0]);
  const symbols = validate([doc]); assert.deepEqual(doc.diagnostics, []);
  const selection = doc.scope.get('Selection'), resolver = new Resolver(doc, () => {}, symbols, selection);
  const resolved = name => resolver.resolve(selection.effective.get(name).type);
  assert.deepEqual(resolved('keys').members.map(t => t.name), ['string', 'integer', 'bool', 'code', 'decimal', 'date']);
  assert.deepEqual(resolved('empty').members, []);
  assert.deepEqual(resolved('identity').members.map(t => t.name), ['bool', 'decimal']);
  assert.deepEqual(resolved('union').args[0].members.map(t => t.name), ['string', 'integer', 'bool', 'code', 'decimal']);
  assert.equal(resolved('symbolic').args[0].exact, null);
  assert.equal(resolved('symbolic_difference').args[0].exact, null);
  assert.deepEqual(resolved('cleared').members, []);
  assert.deepEqual(resolved('absent').members, []);
  assert.ok(equal(resolved('all'), resolved('restored')));
  assert.deepEqual(resolved('removed').members.map(t => t.name), ['bool', 'decimal']);
  const permission = owner => new Resolver(doc, () => {}, symbols, owner, true).resolve(owner.effective.get('permissions').type);
  assert.ok(equal(permission(doc.scope.get('Child')), permission(doc.scope.get('Grandchild'))));
  for (const [source] of require('./flags-cases.json').slice(1)) {
    const invalid = parse(source); validate([invalid]); assert.ok(invalid.diagnostics.length, source);
  }
  for (const source of [
    "@flags decodes Codes { - 0b1" + '0'.repeat(512) + " High: 'High' }",
    `@flags decodes Codes { - ${1n << 512n} High: 'High' }`,
    "decodes Codes { - 0 None: 'None' - 0b10 USD: 'USD' - -3 SomeValue: 'Some value' }",
    "@flags decodes Codes {} type chosen<a: code<Codes>> = string entity A { attr x: chosen<Codes.None + Codes.None> }",
    "@flags decodes Codes {} entity A { attr x: code<Codes> } entity B inherits A { @override attr x: exact<Codes.All> } entity C inherits B { @override attr x: exact<Codes.None> }",
  ]) {
    const valid = parse(source); validate([valid]); assert.deepEqual(valid.diagnostics, []);
  }
});

test('transparent mappings retain exact branch contracts and business field identities', () => {
  const { Resolver, equal } = require('../language/expressions.cjs');
  const doc = parse(require('./expression-cases.json')[0][0]);
  const symbols = validate([doc]); assert.deepEqual(doc.diagnostics, []);
  const selection = doc.scope.get('Selection');
  const resolver = new Resolver(doc, () => {}, symbols, selection);
  const resolved = name => resolver.resolve(selection.effective.get(name).type);
  assert.ok(equal(resolved('mapping'), resolved('shortcut')));
  assert.equal(resolved('bond_fields').members[0].exact, 'USD');
  assert.equal(resolved('fields').members[0].exact, null);
  assert.equal(doc.scope.get('Bond').effective.get('currency').qualifiedName, 'core.Security.currency');
});

test('built-in ConfigGroup schema matches the published model', () => {
  const fs = require('node:fs'), path = require('node:path');
  const { builtinEntities } = require('../language/relationships.cjs');
  const { formatType } = require('../language/validation.cjs');
  const doc = parse(fs.readFileSync(path.join(__dirname, '../../../../lang/models/config_group.yambl'), 'utf8'));
  assert.deepEqual(doc.errors, []);
  const canonical = doc.declarations[0], builtin = builtinEntities.get('ConfigGroup');
  const fields = decl => decl.fields.map(f => [f.mode, f.name.value, formatType(f.type)]);
  assert.equal(canonical.final, true); assert.equal(builtin.final, true);
  assert.deepEqual(fields(builtin), fields(canonical));
});

test('core validation retains the two CLI Decodes warnings before editor filtering', () => {
  const docs = cases[0].map((text, i) => parse(text, `${i}.yambl`)); validate(docs);
  assert.deepEqual(docs.flatMap(d => d.diagnostics.map(x => [x.severity, x.message])), [
    [2, 'undefined Decodes: TradingMarkets'], [2, 'undefined Decodes: PriceSources'],
  ]);
  const security = docs[0].scope.get('Security');
  assert.deepEqual([...security.ownFields.keys()], ['security_id', 'currency', 'market', 'price', 'days']);
  assert.equal(docs[0].scope.has('extend'), false); // Security, Bond, and imported Currencies; no extension symbol.
  assert.equal(security.ownFields.get('price').doc, docs[0]);
});
test('all accepted corpus files format idempotently and end with exactly one LF', () => {
  for (const group of cases) for (const source of group) {
    const doc = parse(source);
    if (doc.errors.length) { assert.equal(format(doc), null); continue; }
    const formatted = format(doc);
    assert.ok(formatted.endsWith('\n') && !formatted.endsWith('\n\n'));
    assert.equal(format(parse(formatted)), formatted);
  }
});
test('source positions use UTF-16, strings preserve escaped quotes and comments', () => {
  const text = "entity A { @description('馃榾\\' #') attr x: code<'Missing'> }";
  const doc = parse(text); validate([doc]);
  assert.equal(doc.errors.length, 0);
  assert.equal(doc.diagnostics[0].range.start.character, text.indexOf('code<'));
  assert.ok(format(doc).includes("@description('馃榾\\' #')"));
  assert.deepEqual(range('馃榾\nx', 3, 4), { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } });
});
test('extensions resolve in their original file and conflicting inherited fields are errors', () => {
  const docs = cases[1].map(text => parse(text)); validate(docs);
  assert.equal(docs[2].diagnostics[0].message, 'duplicate inherited field: price; use @override');
  const field = docs[0].scope.get('Security').ownFields.get('price');
  assert.equal(field.doc, docs[1]);
  assert.equal(docs[1].bindings.get(docs[1].declarations[0].name.start), docs[0].declarations[0]);
});

test('overload identities, branch defaults and effective mapping candidates', () => {
  const { mappingCandidates, builtinEntities } = require('../language/relationships.cjs');
  const docs = [parse(`entity Base { static attr currency: string }
    entity Bond inherits Base { @overload config attr category: integer = 1 }
    entity Stock inherits Base { @overload config attr category: integer = 2 }
    entity Deep inherits Bond { @override config attr category: integer = 3 }
    entity Other { config attr category: string }`)];
  const symbols = validate(docs); assert.deepEqual(docs[0].diagnostics, []);
  const scope = docs[0].scope;
  const bond = scope.get('Bond').ownFields.get('category');
  const stock = scope.get('Stock').ownFields.get('category');
  const deep = scope.get('Deep').ownFields.get('category');
  assert.equal(bond.identity, stock.identity); assert.equal(deep.identity, bond.identity);
  assert.deepEqual(mappingCandidates(scope.get('Base'), 'config', symbols).get('category').map(f => f.default.value), ['1', '2', '3']);
  assert.equal(mappingCandidates(scope.get('Base'), 'static', symbols).get('currency').length, 1);
  assert.deepEqual([...mappingCandidates(builtinEntities.get('ConfigGroup'), 'static', symbols).keys()], ['priority', 'entity_type']);
});

test('signature equivalence resolves imports, dimensions and quoted dictionaries', () => {
  const docs = [parse('namespace base entity Base {} decodes Codes {}'),
    parse("namespace left from base import Base from base import Codes entity Left inherits Base { dimension da { value a: string } dimension db { value b: string } @overload @title('T') @dimension(db) @dimension(da) attr x: code<Codes> }"),
    parse("namespace right from base import Base from base import Codes entity Right inherits Base { dimension da { value a: string } dimension db { value b: string } @dimension(da) @title('T') @dimension(db) @overload attr x: code<'Codes'> }")];
  validate(docs); assert.deepEqual(docs.flatMap(d => d.diagnostics), []);
});
