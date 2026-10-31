'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Service } = require('../service.cjs');
const { parse } = require('../language/syntax.cjs');
const { validate } = require('../language/validation.cjs');

test('unique_by reports unsupported targets', () => {
  for (const source of ['entity A { @unique_by(self.x) attr x: string }', '@unique_by(self.x) value point { attr x: string }']) {
    const doc = parse(source, 'invalid-target.yambl');
    validate([doc]);
    assert.ok(doc.diagnostics.some(d => d.message.includes('decorator unique_by does not allow this target')));
  }
});

test('relationship annotations check cardinality, coordinates and target fields', () => {
  const valid = parse(`dimension source { value source: string }
entity Issuer {
  id id: string
  @dimension(source) @temporal(day: date) @reverse_relationship(Security.issuer)
  scd attr securities: collection<Security>
}
entity Security {
  id id: string
  @dimension(source) @temporal(day: date) @relationship(many, one)
  scd attr issuer: Issuer
}`, 'relationships.yambl');
  validate([valid]); assert.deepEqual(valid.diagnostics, []);
  const reverse = valid.declarations[1].fields[1].metadata.find(call => call.name === 'reverse_relationship');
  assert.equal(reverse.targetField, valid.declarations[2].fields[1]);
  assert.equal(valid.bindings.get(reverse.arguments[0].type.accesses[0].token.start), reverse.targetField);
  for (const [source, message] of [
    ['entity A { @relationship(one, many) attr b:B } entity B {}', 'relationship cardinality does not match field type'],
    ['entity A { @relationship(maybe, one) attr b:B } entity B {}', 'invalid relationship cardinality'],
    ['entity A { @relationship(many, one) attr b:string }', 'relationship requires an entity reference'],
    ['entity A { attr b:B } entity B { @reverse_relationship(A.b) attr a:collection<A> }', 'target must be a forward relationship field'],
    ['entity A { @relationship(one, one) attr b:B } entity B { @reverse_relationship(A.b) attr a:collection<A> }', 'type does not match source cardinality'],
    ['entity A { @relationship(many, one) @temporal(date:date) scd attr b:B } entity B { @reverse_relationship(A.b) @temporal(day:date) scd attr a:collection<A> }', 'categories and temporal parameters must match'],
    ["dimension d { value source:string hierarchy h:Hierarchy = 'H' } entity A { @dimension(d) @relationship(many, one) attr b:B } entity B {}", 'dimensions cannot have hierarchy or fallback'],
  ]) {
    const doc = parse(source, 'invalid.yambl'); validate([doc]);
    assert.ok(doc.diagnostics.some(d => d.message.includes(message)), JSON.stringify(doc.diagnostics));
  }
});

test('relationship argument completion and reverse target navigation', () => {
  const source = 'entity Security { @relationship(many, one) attr issuer:Issuer } entity Issuer { @reverse_relationship(Security.issuer) attr securities:collection<Security> }';
  const service = new Service(() => {}), uri = 'untitled:relationships';
  service.open.set(uri, { text: source, version: 1 }); service.refresh();
  const request = (method, character) => service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: 0, character } });
  const target = source.lastIndexOf('issuer');
  assert.equal(request('definition', target + 2).range.start.character, source.indexOf('issuer'));
  assert.deepEqual(request('completion', source.indexOf('many') + 2).items.map(item => item.label), ['one', 'many']);
  assert.deepEqual(request('completion', source.indexOf('one)') + 2).items.map(item => item.label), ['maybe', 'one']);
  assert.ok(request('completion', source.lastIndexOf('Security.issuer') + 'Security'.length).items.some(item => item.label === 'Security'));
  assert.ok(request('completion', target + 2).items.some(item => item.label === 'issuer'));
});

test('multi-hop reverse paths navigate each step and complete the next relationship', () => {
  const source = 'entity A { id id:string @relationship(one, maybe) attr b:B } entity B { id id:string @relationship(one, maybe) attr c:C } entity C { id id:string @reverse_relationship(A.b.c) attr a:A }';
  const service = new Service(() => {}), uri = 'untitled:reverse-path';
  service.open.set(uri, { text: source, version: 1 }); service.refresh();
  assert.deepEqual(service.document(uri).diagnostics.filter(d => d.severity === 1), []);
  const request = (method, character) => service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: 0, character } });
  const path = source.lastIndexOf('A.b.c');
  assert.equal(request('definition', path + 2).range.start.character, source.indexOf('b:B'));
  assert.equal(request('definition', path + 4).range.start.character, source.indexOf('c:C'));
  assert.ok(request('completion', path + 'A.b.'.length).items.some(item => item.label === 'c'));
  const incomplete = source.replace('A.b.c', 'A.b.');
  service.open.set(uri, { text: incomplete, version: 2 }); service.refresh();
  assert.ok(request('completion', incomplete.lastIndexOf('A.b.') + 'A.b.'.length).items.some(item => item.label === 'c'));
  const invalid = parse(source.replace('A.b.c', 'A.b.missing')); validate([invalid]);
  assert.ok(invalid.diagnostics.some(d => d.message.includes('hop 2 missing')));
});

test('storage decorators complete, navigate and enforce mutually exclusive scalar groups', () => {
  const service = new Service(() => {}), uri = 'untitled:storage';
  for (const [sample, included, excluded] of [
    ['entity A { @| attr x: string }', ['sparse', 'dense'], []],
    ["entity A { @sparse('info') @| attr x: string }", ['title'], ['sparse', 'dense', 'dimension']],
    ["entity A { @| @dense('info') attr x: string }", ['title'], ['sparse', 'dense', 'dimension']],
    ['entity A { @dimension(source: string) @| attr x: string }', ['dimension'], ['sparse', 'dense']],
    ['entity A { @| config attr x: string }', ['title'], ['sparse', 'dense']],
    ['entity A { @| attr x: collection<A> }', ['dimension'], ['sparse', 'dense']],
    ['type items = values<string> entity A { @| attr x: items }', ['dimension'], ['sparse', 'dense']],
  ]) {
    const character = sample.indexOf('|'), text = sample.replace('|', '');
    service.open.set(uri, { text, version: 1 }); service.refresh();
    const labels = service.feature('textDocument/completion', { textDocument: { uri }, position: { line: 0, character } }).items.map(i => i.label);
    for (const name of included) assert.ok(labels.includes(name), sample + ': ' + name);
    for (const name of excluded) assert.ok(!labels.includes(name), sample + ': ' + name);
  }
  for (const name of ['sparse', 'dense']) {
    const text = `entity A { @${name}(cat='info') attr x: string }`;
    service.open.set(uri, { text, version: 1 }); service.refresh();
    assert.deepEqual(service.document(uri).diagnostics, []);
    const request = (method, character) => service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: 0, character } });
    assert.match(request('hover', text.indexOf('@') + 1).contents.value, new RegExp('decorator @' + name + '\\(cat: string\\)'));
    assert.match(request('definition', text.indexOf('@') + 1).uri, /builtins\/decorators.yambl$/);
    assert.match(request('definition', text.indexOf('cat=')).uri, /builtins\/decorators.yambl$/);
    assert.deepEqual(request('completion', text.indexOf('cat=')).items.map(i => i.label), ['cat', 'description']);
  }
});

test('decorator declarations, keywords and builtins navigate and hover', () => {
  const service = new Service(() => {}), uri = 'untitled:decorators';
  const text = "@allow_multiple @targets(DecoratorTargets.All) decorator @tag(text: string = 'x', rank: integer = 1, *source?: string) @tag(text='y') entity A { @title(text='Name') attr name: string }";
  service.open.set(uri, { text, version: 1 }); service.refresh();
  assert.deepEqual(service.document(uri).diagnostics, []);
  const request = (method, character) => service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: 0, character } });
  assert.equal(request('definition', text.indexOf('@tag(text=') + 1).range.start.character, text.indexOf('@tag(') + 1);
  assert.equal(request('definition', text.indexOf("text='y'")).range.start.character, text.indexOf('text: string'));
  assert.match(request('hover', text.indexOf('@tag(text=') + 1).contents.value, /@allow_multiple\ndecorator @tag\(text: string = 'x', rank: integer = 1, \*source\?: string\)/);
  assert.match(request('hover', text.indexOf("text='y'")).contents.value, /text: string = 'x'/);
  assert.match(request('definition', text.indexOf('@title') + 1).uri, /builtins\/decorators.yambl$/);
  assert.match(request('definition', text.indexOf("text='Name'")).uri, /builtins\/decorators.yambl$/);
  assert.match(request('hover', text.indexOf('name: string')).contents.value, /title: Name/);
  assert.equal(request('references', text.indexOf('@tag(') + 1).length, 1);
  service.open.set(uri, { text: text.replace('@allow_multiple ', '').replace("@tag(text='y')", "@tag(text='y') @tag"), version: 2 }); service.refresh();
  assert.ok(service.document(uri).diagnostics.some(d => d.message === 'duplicate decorator: tag'));
});

test('incomplete decorator calls offer visible names and named value parameters', () => {
  const service = new Service(() => {}), uri = 'untitled:decorator-completion';
  const prefix = "@targets(DecoratorTargets.All) decorator @tag(text: string = 'x', rank: integer = 1, *source?: string) ";
  for (const [tail, labels] of [
    ['@', ['tag', 'title', 'allow_multiple']],
    ['@ta', ['tag', 'title', 'allow_multiple']],
    ['@tag(', ['text', 'rank']],
    ['@tag(te', ['text', 'rank']],
    ["@tag(text='x', ", ['rank']],
  ]) {
    const text = prefix + tail;
    service.open.set(uri, { text, version: 1 }); service.refresh();
    const result = service.feature('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: text.length } });
    for (const label of labels) assert.ok(result.items.some(i => i.label === label), tail + ': ' + label);
    assert.ok(!result.items.some(i => i.label === 'source'));
  }
  const text = prefix + '@tag() entity A {}';
  service.open.set(uri, { text, version: 2 }); service.refresh();
  const result = service.feature('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: text.indexOf('@tag()') + 5 } });
  assert.deepEqual(result.items.map(i => i.insertText), ['text=', 'rank=', 'description=']);
});

test('unique_by provides variadic signature and static field completion', () => {
  const service = new Service(() => {}), uri = 'untitled:unique-by';
  const text = '@unique_by(self.) entity A { id id: string attr name: string config attr setting: string attr many: values<string> }';
  service.open.set(uri, { text, version: 1 }); service.refresh();
  const offset = text.indexOf('self.') + 'self.'.length;
  const params = { textDocument: { uri }, position: { line: 0, character: offset } };
  const choices = service.feature('textDocument/completion', params).items.map(item => item.label);
  assert.ok(choices.includes('name'));
  assert.ok(!choices.includes('id'));
  assert.ok(!choices.includes('setting'));
  assert.ok(!choices.includes('many'));
  assert.match(service.feature('textDocument/signatureHelp', params).signatures[0].label, /\.\.\.fields:/);
});

test('captured field owners and normalized metadata distinguish valid overrides', () => {
  const text = "@targets(DecoratorTargets.All) decorator @proxy(target: type<self::entity>) @targets(DecoratorTargets.All) decorator @tag(text: string = 'x') entity Holding { @proxy(Holding) @tag attr security: Security } entity Security {} entity Child inherits Holding { @override @proxy(Holding) @tag(text='x') attr security: Security }";
  const doc = parse(text); validate([doc]);
  assert.ok(doc.diagnostics.some(d => d.message === 'incompatible decorator argument'));
  const valid = parse(text.replace('@proxy(Holding) @tag(text=', '@proxy(Child) @tag(text=')); validate([valid]);
  // The owner-dependent arguments differ, so the metadata contract differs too.
  assert.ok(valid.diagnostics.some(d => d.message.includes('override signature mismatch')));
  const defaults = parse("@targets(DecoratorTargets.All) decorator @tag(text: string = 'x') entity A { @tag attr x: string } entity B inherits A { @override @tag(text='x') attr x: string }");
  validate([defaults]); assert.deepEqual(defaults.diagnostics, []);
});

test('explicit target contracts provide diagnostics, completion, hover and navigation', () => {
  const service = new Service(() => {}), uri = 'untitled:targets';
  let text = '@targets(DecoratorTargets.EntityAttr, categories=AttrCats.Snapshot + AttrCats.Scd) decorator @tag() entity A { @tag snapshot attr x: string }';
  const open = source => { text = source; service.open.set(uri, { text, version: 1 }); service.refresh(); };
  const request = (method, character) => service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: 0, character } });
  open(text);
  assert.deepEqual(service.document(uri).diagnostics, []);
  assert.match(request('hover', text.lastIndexOf('@tag') + 1).contents.value, /^@targets\(DecoratorTargets.EntityAttr, categories=AttrCats.Snapshot \+ AttrCats.Scd\)/);
  assert.match(request('definition', 1).uri, /builtins\/decorators.yambl$/);
  assert.match(request('definition', text.indexOf('categories=')).uri, /builtins\/decorators.yambl$/);
  const target = request('definition', text.indexOf('EntityAttr'));
  assert.match(target.uri, /builtins\/decorator_targets.yambl$/);
  const builtin = require('node:fs').readFileSync(require('node:url').fileURLToPath(target.uri), 'utf8');
  assert.match(builtin.split('\n')[target.range.start.line], /EntityAttr:/);
  const callStart = text.lastIndexOf('@tag');
  open(text.replace('snapshot attr', 'static attr'));
  assert.deepEqual(service.document(uri).diagnostics.map(d => [d.message, d.range.start.character]), [['decorator tag does not allow this target', callStart]]);
  open('decorator @tag()');
  assert.deepEqual(service.document(uri).diagnostics.map(d => d.message), ['decorator requires explicit @targets']);
  for (const [source, labels] of [
    ['@', ['targets']],
    ['@targets(', ['targets', 'categories']],
    ['@targets(DecoratorTargets.EntityAttr, ', ['categories']],
    ['@targets(DecoratorTargets.', ['Entity', 'Value', 'Decodes', 'Type', 'Decorator', 'Id', 'EntityAttr', 'ValueAttr', 'Lookup', 'None', 'All']],
    ['@targets(DecoratorTargets.EntityAttr, categories=AttrCats.', ['Static', 'Config', 'Snapshot', 'Scd', 'None', 'All']],
  ]) {
    open(source);
    const result = request('completion', text.length);
    for (const label of labels) assert.ok(result.items.some(i => i.label === label), source + ': ' + label);
  }
});

test('decorator completion filters all definition kinds and attribute categories', () => {
  const service = new Service(() => {}), uri = 'untitled:target-filter';
  const prefix = [
    '@targets(DecoratorTargets.All) decorator @anywhere()',
    '@targets(DecoratorTargets.None) decorator @nowhere()',
    '@targets(DecoratorTargets.EntityAttr, categories=AttrCats.Config + AttrCats.Static) decorator @setting()',
    '@targets(DecoratorTargets.ValueAttr, categories=AttrCats.Static) decorator @value_field()',
    '@targets(DecoratorTargets.EntityAttr, categories=AttrCats.None) decorator @no_category()',
    '@targets(DecoratorTargets.Id, categories=AttrCats.None) decorator @identity()',
    '@targets(DecoratorTargets.Entity + DecoratorTargets.Type) decorator @model()',
    '@targets(DecoratorTargets.All - DecoratorTargets.EntityAttr - DecoratorTargets.ValueAttr) decorator @definition()',
    'decorator @missing_scope()',
    '@targets(AttrCats.All) decorator @bad_scope()',
  ].join('\n') + '\n';
  const common = ['anywhere', 'description', 'title'];
  const examples = [
    ['@| entity A {}', [...common, 'definition', 'model', 'unique_by']],
    ['@| final entity A {}', [...common, 'definition', 'model', 'unique_by']],
    ['entity Root {} @| entity A inherits Root {}', [...common, 'decodes_rank', 'definition', 'model', 'unique_by']],
    ['@| value item {}', [...common, 'definition']],
    ['@| decodes Codes {}', [...common, 'definition', 'flags']],
    ['@| type label = string', [...common, 'definition', 'model']],
    ['@| @targets(DecoratorTargets.None) decorator @other()', [...common, 'allow_multiple', 'definition']],
    ['entity A { @| id key: string }', [...common, 'definition', 'identity']],
    ['entity A { @| attr x: string }', [...common, 'dense', 'sparse', 'dimension', 'overload', 'override', 'setting']],
    ['entity A { @| static attr x: string }', [...common, 'dense', 'sparse', 'dimension', 'overload', 'override', 'setting']],
    ['entity A { @| config attr x: string }', [...common, 'overload', 'override', 'setting']],
    ['entity A { @| snapshot attr x: string }', [...common, 'dimension', 'overload', 'override', 'temporal']],
    ['entity A { @| scd attr x: string }', [...common, 'dimension', 'overload', 'override', 'temporal']],
    ['entity A {} extend A { @| snapshot attr x: string }', [...common, 'dimension', 'overload', 'override', 'temporal']],
    ['value item { @| attr x: string }', [...common, 'value_field']],
    ['value item { @| static attr x: string }', [...common, 'value_field']],
    ['@|', [...common, 'allow_multiple', 'decodes_rank', 'definition', 'flags', 'model', 'targets', 'unique_by']],
    ['entity A { @|', [...common, 'dense', 'sparse', 'definition', 'dimension', 'extra_input_param', 'identity', 'overload', 'override', 'relationship', 'reverse_relationship', 'setting', 'temporal']],
    ['entity A {} extend A { @| }', [...common, 'definition', 'dense', 'sparse', 'dimension', 'extra_input_param', 'overload', 'override', 'relationship', 'reverse_relationship', 'setting', 'temporal']],
    ['value item { @|', [...common, 'value_field']],
    ['entity A { @t| # misleading decodes {}\n @title(\'@flags }\') snapshot attr x: string }', [...common.filter(n => n !== 'title'), 'dimension', 'overload', 'override', 'temporal']],
    ['entity A { @tem|poral(day: date) snapshot attr x: string }', [...common, 'dimension', 'overload', 'override', 'temporal']],
    ['entity A { @|(day: date) snapshot attr x: string }', [...common, 'dimension', 'overload', 'override', 'temporal']],
    ['@| extend A {} entity A {}', []],
    ['decodes Codes { @| - 1 One: \'One\' }', []],
    ['decorator @|', []],
    ['decorator @other(@|)', []],
    ['type t<a: @|> = a', []],
    ["@title('text @|') entity A {}", []],
    ['# @|\nentity A {}', []],
    ['value item { @| snapshot attr x: string }', []],
    ['entity A {} extend A { @| id key: string }', []],
  ];
  for (const [sample, expected] of examples) {
    const marked = prefix + sample, offset = marked.indexOf('|'), text = marked.replace('|', '');
    service.open.set(uri, { text, version: 1 }); service.refresh();
    const position = require('../language/syntax.cjs').position(text, offset);
    const result = service.feature('textDocument/completion', { textDocument: { uri }, position });
    assert.deepEqual(result.items.map(item => item.label).sort(), [...expected].sort(), sample);
  }
});

test('decorator completion removes nonrepeatable uses on only the current object', () => {
  const service = new Service(() => {}), uri = 'untitled:repeat-filter';
  const prefix = '@targets(DecoratorTargets.All) decorator @once(text: string = \'x\') @targets(DecoratorTargets.All) @allow_multiple decorator @many(text: string = \'x\')\n';
  const cases = [
    ['@once @many @| entity A {}', false, true],
    ['@| @once() @many() entity A {}', false, true],
    ["@once(text='x') @| @many('x') entity A {}", false, true],
    ['@once @many @|', false, true],
    ['@on|ce entity A {}', true, true],
    ['@|once() entity A {}', true, true],
    ['@once @on|ce entity A {}', false, true],
    ['@on|ce @once entity A {}', false, true],
    ['@once entity A {} @| entity B {}', true, true],
    ['@once entity A { @| attr x: string }', true, true],
    ['entity A { @once attr x: string @| attr y: string }', true, true],
    ['entity A { @| attr x: string @once attr y: string }', true, true],
    ['entity A { @once attr x: string } entity B inherits A { @override @| attr x: string }', true, true],
    ['entity A {} extend A { @once @| attr x: string }', false, true],
    ['value item { @once @| attr x: string }', false, true],
    ['entity A { @once @| id key: string }', false, true],
    ['@once @| type name = string', false, true],
    ['@once @| decodes Codes {}', false, true],
    ['@once @| @targets(DecoratorTargets.All) decorator @other()', false, true],
    ['entity A { @once @many @|', false, true],
    ["@once(\n text='@many ( )'\n) # @other\n @| entity A {}", false, true],
    ["# @once\n@| entity A {}", true, true],
    ["@title('@once') @| entity A {}", true, true],
  ];
  for (const [sample, once, many] of cases) {
    const marked = prefix + sample, offset = marked.indexOf('|'), text = marked.replace('|', '');
    service.open.set(uri, { text, version: 1 }); service.refresh();
    const result = service.feature('textDocument/completion', { textDocument: { uri }, position: require('../language/syntax.cjs').position(text, offset) });
    const labels = result.items.map(i => i.label);
    assert.equal(labels.includes('once'), once, sample);
    assert.equal(labels.includes('many'), many, sample);
  }
  for (const [sample, excluded, included] of [
    ["entity A { @title('X') @description('D') @temporal(day: date) @dimension(source: string) @| snapshot attr x: string }", ['title', 'description', 'temporal'], ['dimension']],
    ['@flags @| decodes Codes {}', ['flags'], ['title']],
    ['@allow_multiple @targets(DecoratorTargets.All) @| decorator @other()', ['allow_multiple', 'targets'], ['title']],
  ]) {
    const offset = sample.indexOf('|'), text = sample.replace('|', '');
    service.open.set(uri, { text, version: 1 }); service.refresh();
    const labels = service.feature('textDocument/completion', { textDocument: { uri }, position: require('../language/syntax.cjs').position(text, offset) }).items.map(i => i.label);
    for (const name of excluded) assert.ok(!labels.includes(name), sample + ': ' + name);
    for (const name of included) assert.ok(labels.includes(name), sample + ': ' + name);
  }
});

test('target-filtered completion retains imports in unfinished bodies and reacts to unsaved changes', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { position } = require('../language/syntax.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-target-completion-'));
  try {
    fs.writeFileSync(path.join(root, 'yambl-root.lclcfg'), "prefix: 'test'");
    const definition = 'namespace meta @targets(DecoratorTargets.EntityAttr, categories=AttrCats.Snapshot) decorator @observed()';
    fs.writeFileSync(path.join(root, 'meta.yambl'), definition);
    fs.writeFileSync(path.join(root, 'consumer.yambl'), 'namespace app from meta import observed entity A {}');
    const uri = pathToFileURL(path.join(root, 'consumer.yambl')).href;
    const metaUri = pathToFileURL(path.join(root, 'meta.yambl')).href;
    const service = new Service(() => {});
    const complete = sample => {
      const offset = sample.indexOf('|'), text = sample.replace('|', '');
      service.open.set(uri, { text, version: 1 }); service.refresh();
      return service.feature('textDocument/completion', { textDocument: { uri }, position: position(text, offset) }).items.map(i => i.label);
    };
    const prefix = 'namespace app from meta import observed ';
    assert.ok(complete(prefix + 'entity A { @|').includes('observed'));
    assert.ok(complete(prefix + 'entity A { @| snapshot attr x: string }').includes('observed'));
    assert.ok(!complete(prefix + 'entity A { @observed @| snapshot attr x: string }').includes('observed'));
    service.open.set(metaUri, { text: definition.replace('decorator @observed', '@allow_multiple decorator @observed'), version: 2 });
    assert.ok(complete(prefix + 'entity A { @observed @| snapshot attr x: string }').includes('observed'));
    service.open.set(metaUri, { text: definition, version: 3 });
    assert.ok(!complete(prefix + 'entity A { @observed @| snapshot attr x: string }').includes('observed'));
    assert.ok(!complete(prefix + 'entity A { @| static attr x: string }').includes('observed'));
    assert.ok(!complete('namespace app entity A { @| snapshot attr x: string }').includes('observed'));
    service.open.set(metaUri, { text: definition.replace('AttrCats.Snapshot', 'AttrCats.Static'), version: 2 });
    assert.ok(!complete(prefix + 'entity A { @| snapshot attr x: string }').includes('observed'));
    assert.ok(complete(prefix + 'entity A { @| static attr x: string }').includes('observed'));
    service.open.set(metaUri, { text: 'namespace meta decorator @observed()', version: 3 });
    assert.ok(!complete(prefix + 'entity A { @|').includes('observed'));
    const forward = 'namespace app entity A { @| snapshot attr x: string } @targets(DecoratorTargets.EntityAttr, categories=AttrCats.Snapshot) decorator @future()';
    assert.ok(complete(forward).includes('future'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
