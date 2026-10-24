'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Service } = require('../service.cjs');
const { parse } = require('../language/syntax.cjs');
const { validate } = require('../language/validation.cjs');

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
  assert.deepEqual(result.items.map(i => i.insertText), ['text=', 'rank=']);
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
    ['@targets(DecoratorTargets.', ['Entity', 'Value', 'Decodes', 'Type', 'Decorator', 'Id', 'EntityAttr', 'ValueAttr', 'None', 'All']],
    ['@targets(DecoratorTargets.EntityAttr, categories=AttrCats.', ['Attr', 'Static', 'Config', 'Snapshot', 'Scd', 'None', 'All']],
  ]) {
    open(source);
    const result = request('completion', text.length);
    for (const label of labels) assert.ok(result.items.some(i => i.label === label), source + ': ' + label);
  }
});
