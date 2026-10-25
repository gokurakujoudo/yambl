'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Service } = require('../service.cjs');
const { parse, format, resultConstants } = require('../language/syntax.cjs');
const { validate } = require('../language/validation.cjs');

const expected = {
  NOT_DEFINED: 'actual type', NOT_APPLICABLE: 'business context', EMPTY: 'record exists',
  NO_ENTRY: 'does not exist in storage', NO_DATA: 'retrieval requirements',
  ENTITY_NOT_FOUND: 'Dereferencing', ERROR: 'error occurred',
  PARTIAL: 'usable data',
};

test('result constants and PARTIAL share definitions, completion kinds and hover meanings', () => {
  assert.deepEqual(Object.keys(resultConstants), Object.keys(expected));
  const service = new Service(() => {}), uri = 'untitled:result-constants';
  for (const [name, meaning] of Object.entries(expected)) {
    const text = `entity A { attr x: ${name} }`;
    service.open.set(uri, { text, version: 1 }); service.refresh();
    const request = method => service.feature('textDocument/' + method, { textDocument: { uri }, position: { line: 0, character: text.indexOf(name) + 1 } });
    const items = request('completion').items;
    for (const constant of Object.keys(expected)) {
      const item = items.find(i => i.label === constant);
      assert.equal(item.kind, 21);
      assert.ok(item.detail.includes(expected[constant]));
    }
    assert.ok(!items.some(i => i.label === 'UNKNOWN'));
    assert.ok(request('hover').contents.value.includes(meaning));
    assert.match(request('hover').contents.value, /explicit recover/);
    assert.deepEqual(service.document(uri).diagnostics.map(d => d.message), [`result constant ${name} cannot be used in model expressions`]);
    assert.equal(request('definition'), null);
    assert.equal(format(parse(format(parse(text)))), format(parse(text)));
  }
});

test('result constants cannot shadow declarations or gain assignment and propagation behavior', () => {
  for (const name of Object.keys(expected)) {
    for (const prefix of ['', 'namespace builtins ', 'namespace business ']) {
      const doc = parse(`${prefix}entity ${name} {}`); validate([doc]);
      assert.ok(doc.diagnostics.some(d => d.message === `duplicate or reserved declaration: ${name}`));
    }
    for (const text of [
      `@title(${name}) entity A {}`, `entity A { attr x: exact<${name}> }`,
      `entity A { attr x: ${name} + AttrCats.Static }`,
      `@targets(DecoratorTargets.All) decorator @note(text: string = ${name})`,
    ]) {
      const doc = parse(text); validate([doc]);
      assert.ok(doc.diagnostics.some(d => d.message === `result constant ${name} cannot be used in model expressions`));
    }
    assert.ok(parse(`entity A { config attr x: string = ${name} }`).errors.length);
    const doc = parse(`@title('${name}') entity A { config attr text: string = '${name}' }`); validate([doc]);
    assert.deepEqual(doc.diagnostics, []);
  }
  const doc = parse("decodes Codes { - 1 ERROR: 'Error' } @title(Codes.ERROR) entity A {} entity Empty {}"); validate([doc]);
  assert.deepEqual(doc.diagnostics, []);
});
