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
  assert.deepEqual(resolved('keys').members.map(t => t.name), ['string', 'integer', 'bool', 'code', 'decimal', 'type', 'type', 'date']);
  assert.deepEqual(resolved('empty').members, []);
  assert.deepEqual(resolved('identity').members.map(t => t.name), ['bool', 'decimal']);
  assert.deepEqual(resolved('union').args[0].members.map(t => t.name), ['string', 'integer', 'bool', 'code', 'decimal', 'type', 'type']);
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
  assert.deepEqual([...mappingCandidates(builtinEntities.get('ConfigGroup'), 'static', symbols).keys()], ['priority', 'target_entity_type', 'entity_type', 'root_entity_type']);
});

test('signature equivalence resolves imports, dimensions and quoted dictionaries', () => {
  const docs = [parse('namespace base entity Base {} decodes Codes {}'),
    parse("namespace left from base import Base from base import Codes entity Left inherits Base { dimension da { value a: string } dimension db { value b: string } @overload @title('T') @dimension(db) @dimension(da) attr x: code<Codes> }"),
    parse("namespace right from base import Base from base import Codes entity Right inherits Base { dimension da { value a: string } dimension db { value b: string } @dimension(da) @title('T') @dimension(db) @overload attr x: code<'Codes'> }")];
  validate(docs); assert.deepEqual(docs.flatMap(d => d.diagnostics), []);
});


test('hidden type fields have per-entity constraints and reject declarations', () => {
  const { Resolver } = require('../language/expressions.cjs');
  const { mappingCandidates } = require('../language/relationships.cjs');
  const { describe } = require('../language/validation.cjs');
  const doc = parse(`namespace core
    entity Root { id id: string computed attr kind: type<Root> { return self.entity_type::value() } }
    entity Child inherits Root {} entity Leaf inherits Child {}`);
  const symbols = validate([doc]); assert.deepEqual(doc.diagnostics, []);
  const root = doc.scope.get('Root'), leaf = doc.scope.get('Leaf');
  for (const name of ['entity_type', 'root_entity_type']) {
    assert.equal(leaf.effective.get(name).identity, root.effective.get(name));
    assert.equal(leaf.effective.get(name).qualifiedName, 'core.Root.' + name);
    assert.ok(mappingCandidates(root, 'static', symbols).has(name));
  }
  const resolver = new Resolver(doc, () => {}, symbols, leaf);
  assert.equal(resolver.resolve(leaf.effective.get('entity_type').type).args[0].key, leaf.key);
  assert.equal(resolver.resolve(leaf.effective.get('root_entity_type').type).args[0].name, 'Entity');
  assert.equal(describe(leaf.effective.get('entity_type')), 'static attr entity_type: type<self>');
  assert.equal(describe(leaf.effective.get('root_entity_type')), 'static attr root_entity_type: type<Entity>');
  assert.ok(symbols.get('\0builtins\0ConfigGroup').effective.get('entity_type').builtin);
  for (const source of [
    'entity A { attr entity_type: string }',
    'entity A {} extend A { attr root_entity_type: string }',
    'entity A {} entity B inherits A { @override attr entity_type: string }',
  ]) {
    const invalid = parse(source); validate([invalid]);
    assert.ok(invalid.diagnostics.some(d => d.message.includes('reserved built-in field')), source);
  }
});


test('derived subtype dictionaries are local to each entity and use depth-first numbering', () => {
  const source = `entity Root {} entity Z inherits Root {} entity A inherits Root {}
    entity C inherits A {} entity B inherits A {}
    entity Use { attr kind: code<Root::subtypes> computed attr selected: code<Root::subtypes> { return Root::subtypes.B } }
    const FIRST: code<Root::subtypes> = Root::subtypes.A`;
  const doc = parse(source); validate([doc]); assert.deepEqual(doc.diagnostics, []);
  const entries = name => doc.scope.get(name).subtypes.entries.map(e => [e.code.value, e.order.value]);
  assert.deepEqual(entries('Root'), [['A', '100'], ['B', '200'], ['C', '300'], ['Z', '400']]);
  assert.deepEqual(entries('A'), [['B', '100'], ['C', '200']]);
  assert.deepEqual(entries('B'), []);
  assert.equal(format(parse(format(doc))), format(doc));
  const bad = parse('entity A {} entity B inherits A {} entity X { attr x: code<A::subtypes> } const BAD: code<A::subtypes> = A::subtypes.Unknown');
  validate([bad]); assert.ok(bad.diagnostics.some(d => d.message.includes('unknown Decodes code')));
});

test('subtype ranking uses the parent ordering and preserves default positions', () => {
  const doc = parse("entity Root {} @decodes_rank(-5, 'Alpha') entity A inherits Root {} @decodes_rank(5, 'Beta') entity B inherits A {} entity C inherits Root {}");
  validate([doc]);
  assert.deepEqual(doc.diagnostics, []);
  assert.deepEqual(doc.scope.get('Root').subtypes.entries.map(e => [e.code.value, e.order.value, e.value.value]), [['A', '-5', "'Alpha'"], ['B', '0', "'Beta'"], ['C', '300', "'C'"]]);
  assert.deepEqual(doc.scope.get('A').subtypes.entries.map(e => [e.code.value, e.order.value]), [['B', '5']]);
  const cycle = parse('entity A inherits B {} entity B inherits A {}'); validate([cycle]);
  assert.ok(cycle.diagnostics.some(d => d.message === 'inheritance cycle'));
  const invalid = parse("@decodes_rank(1, 'Root') entity Root {}"); validate([invalid]);
  assert.ok(invalid.diagnostics.some(d => d.message === 'decodes_rank requires an explicit parent'));
});

test('duplicate subtype short names from different namespaces are diagnosed', () => {
  const docs = [parse('namespace core entity Root {}'), parse('namespace left from core import Root entity Child inherits Root {}'), parse('namespace right from core import Root entity Child inherits Root {}')];
  validate(docs);
  assert.ok(docs.flatMap(d => d.diagnostics).some(d => d.message === 'duplicate subtype code: Child'));
});
