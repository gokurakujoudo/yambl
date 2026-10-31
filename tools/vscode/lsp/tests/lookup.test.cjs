'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Service } = require('../service.cjs');
const { position } = require('../language/syntax.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function editor(source) {
  const service = new Service(() => {}), uri = 'untitled:lookup', offset = source.indexOf('|');
  const text = source.replace('|', '');
  service.open.set(uri, { text, version: 1 }); service.refresh();
  const feature = method => service.feature('textDocument/' + method, { textDocument: { uri }, position: position(text, offset), context: { includeDeclaration: false } });
  return { text, service, uri, feature };
}
const labels = result => result.items.map(item => item.label);

test('fixed lookup bindings report static and compile-time evaluation failures', () => {
  const { parse } = require('../language/syntax.cjs');
  const { validate } = require('../language/validation.cjs');
  const cases = [
    ['1 // 0', 'incompatible binding for parameter: day'],
    ['parse_date()', 'missing builtin argument: text'],
    ["parse_date('2024-01-01', '2024-01-02')", 'invalid, duplicate or out-of-order builtin argument: '],
    ['parse_date(to_string(1 // 0))', 'lookup binding evaluation failed: Fraction(1, 0)'],
    ["parse_date('bad')", 'lookup binding evaluation failed: parse_date requires YYYY-MM-DD'],
  ];
  for (const [binding, expected] of cases) {
    const doc = parse(`entity E { dimension source { value index: string } @dimension(source) @temporal(day: date) scd attr name: string lookup fixed { name = self.name::value(day=${binding}, index='valid') } }`, 'fixed.yambl');
    validate([doc]);
    assert.deepEqual(doc.diagnostics.map(item => item.message), [expected], binding);
  }
});

test('fixed lookup string comparisons use Unicode code point order', () => {
  const { parse } = require('../language/syntax.cjs');
  const { validate } = require('../language/validation.cjs');
  const astral = String.fromCodePoint(0x1f600), bmp = String.fromCodePoint(0xe000);
  for (const [operator, expected] of [['>', []], ['<', ['lookup binding evaluation failed: Fraction(1, 0)']]]) {
    const source = `entity E { dimension d { value origin: string } @dimension(d) attr name: string lookup fixed { name = self.name::value(origin=if '${astral}' ${operator} '${bmp}' then 'ok' else to_string(1 // 0)) } }`;
    const doc = parse(source, 'unicode.yambl'); validate([doc]);
    assert.deepEqual(doc.diagnostics.map(item => item.message), expected, operator);
  }
});

test('fixed lookup compares structured constants by their nested fields', () => {
  const { parse } = require('../language/syntax.cjs');
  const { validate } = require('../language/validation.cjs');
  for (const [text, operator, expected] of [
    ['x', '==', []], ['y', '==', ['lookup binding evaluation failed: Fraction(1, 0)']],
    ['x', '!=', ['lookup binding evaluation failed: Fraction(1, 0)']], ['y', '!=', []],
  ]) {
    const source = `value inner { attr amount: decimal attr day: date } value outer { attr inner: inner attr text: string }
      const A: outer = {inner: {amount: 1.0, day: '2026-01-01'}, text: 'x'}
      const B: outer = {inner: {amount: 1.00, day: '2026-01-01'}, text: '${text}'}
      entity E { dimension d { value origin: string } @dimension(d) attr name: string lookup fixed { name = self.name::value(origin=if A ${operator} B then 'ok' else to_string(1 // 0)) } }`;
    const doc = parse(source, 'structured.yambl'); validate([doc]);
    assert.deepEqual(doc.diagnostics.map(item => item.message), expected, `${text} ${operator}`);
  }
});

test('structured constant equality compares reference IDs and normalized datetimes', () => {
  const { parse } = require('../language/syntax.cjs');
  const { validate } = require('../language/validation.cjs');
  for (const [target, expected] of [['R1', []], ['R2', ['lookup binding evaluation failed: Fraction(1, 0)']]]) {
    const source = `entity Ref { id id: string } value data_record { attr target: Ref attr stamp: datetime }
      const A: data_record = {target: 'R1', stamp: '2026-01-01T08:00:00+08:00'}
      const B: data_record = {target: '${target}', stamp: '2026-01-01T00:00:00Z'}
      entity E { dimension d { value origin: string } @dimension(d) attr name: string lookup fixed { name = self.name::value(origin=if A == B then 'ok' else to_string(1 // 0)) } }`;
    const doc = parse(source, 'references.yambl'); validate([doc]);
    assert.deepEqual(doc.diagnostics.map(item => item.message), expected, target);
  }
});

test('lookup skips statically invalid constants while retaining other dependency errors', () => {
  const { parse } = require('../language/syntax.cjs');
  const { validate } = require('../language/validation.cjs');
  const cases = [
    ["entity Security { id security_id: integer } value holding { attr security: Security } const A: holding = {security: 'abc'} entity E { dimension d { value origin: string } @dimension(d) attr name: string lookup fixed { name = self.name::value(origin=if A == A then 'ok' else 'no') } }", ['incompatible reference literal ID type']],
    ["const BAD: date = parse_date('bad') entity E { @temporal(day:date) scd attr x:string lookup a { x=self.x::value(day=BAD) } }", ['constant evaluation failed: parse_date requires YYYY-MM-DD', 'lookup binding evaluation failed: cannot evaluate lookup binding: BAD']],
    ["entity E { dimension d { value origin:string } @dimension(d) attr x:string lookup a { x=self.x::value(origin=MISSING) } }", ['lookup binding requires a pure expression of inputs, literals, constants or dictionary members']],
  ];
  for (const [source, expected] of cases) {
    const doc = parse(source, 'invalid-constant.yambl'); validate([doc]);
    assert.deepEqual(doc.diagnostics.map(item => item.message), expected);
  }
});

test('lookup avoids uncertain decimal and float evaluation, including an error it cannot yet diagnose', () => {
  const { parse } = require('../language/syntax.cjs');
  const { validate } = require('../language/validation.cjs');
  const cases = [
    "if to_string(1.00) == '1.00' then 'ok' else to_string(1 // 0)",
    "if to_string(1.00) == '1.00' then to_string(1 // 0) else 'ok'",
    "if 1 / 2 == 0.5 then 'ok' else to_string(1 // 0)",
    'to_string(1 / 0)',
    "if TEXT == '1.00' then 'ok' else to_string(1 // 0)",
  ];
  for (const binding of cases) {
    const doc = parse(`const TEXT: string = to_string(1.00) entity E { dimension d { value origin: string } @dimension(d) attr name: string lookup fixed { name = self.name::value(origin=${binding}) } }`, 'uncertain.yambl');
    validate([doc]);
    assert.deepEqual(doc.diagnostics.map(item => item.message), [], binding);
  }
});

test('lookup accepts optional inputs and pure fallback bindings', () => {
  const { parse } = require('../language/syntax.cjs');
  const { validate } = require('../language/validation.cjs');
  const doc = parse(`entity E {
    id id: string
    @temporal(day: date) scd attr value: string
    @extra_input_param(selected: date, 'Optional date')
    lookup by_value { value = self.value::value(day=input.selected ?? input.day) }
  }`, 'optional.yambl');
  validate([doc]);
  assert.deepEqual(doc.errors, []);
  assert.deepEqual(doc.diagnostics, []);
  const lookup = doc.declarations[0].lookups[0];
  assert.deepEqual(lookup.inferredInputs.map(p => [p.name, p.required]), [['day', true], ['selected', false]]);
  const old = parse('entity E { @extra_input_params(day: date) lookup by_id { id = self.id::value() } id id: string }', 'old.yambl');
  validate([old]);
  assert.ok(old.diagnostics.some(d => d.message === 'use @extra_input_param instead of @extra_input_params'));
  assert.ok(labels(editor('entity E { @| lookup by_id { id = self.id::value() } id id: string }').feature('completion')).includes('extra_input_param'));
});

test('lookup inputs follow conversion signatures and declared fallback defaults', () => {
  const { parse } = require('../language/syntax.cjs');
  const { validate } = require('../language/validation.cjs');
  const doc = parse(`entity E {
    dimension source { value source: string }
    @dimension(source) @temporal(day: date) scd attr value: string
    lookup converted { value = self.value::value(day=parse_date(input.same), source=input.same) }
    lookup conditional { value = self.value::value(day=if true then parse_date(input.text) else parse_date('2026-01-01'), source='x') }
    lookup branches { value = self.value::value(day=if input.first and not input.second then input.start else input.end, source='x') }
    @extra_input_param(day: date = '2026-01-01')
    lookup defaulted { value = self.value::value(day=input.day ?? input.fallback, source='x') }
  }`, 'expressions.yambl');
  validate([doc]);
  assert.deepEqual(doc.diagnostics, []);
  const [converted, conditional, branches, defaulted] = doc.declarations[0].lookups;
  assert.deepEqual(converted.inferredInputs.map(p => [p.name, p.type.name]), [['same', 'string']]);
  assert.deepEqual(conditional.inferredInputs.map(p => [p.name, p.type.name]), [['text', 'string']]);
  assert.deepEqual(branches.inferredInputs.map(p => [p.name, p.type.name]), [['end', 'date'], ['first', 'bool'], ['second', 'bool'], ['start', 'date']]);
  assert.deepEqual(defaulted.inferredInputs.map(p => [p.name, p.type.name]), [['day', 'date']]);

  const custom = parse('@targets(DecoratorTargets.Lookup) decorator @extra_input_params(*x: input_type) entity E { @extra_input_params(day: date) lookup old { x = self.name::value() } attr name: string }', 'custom.yambl');
  validate([custom]);
  assert.equal(custom.diagnostics.filter(d => d.message === 'use @extra_input_param instead of @extra_input_params').length, 2);
});

test('embedded builtin lookups are analyzed and are not duplicated when authoring builtins', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-lookup-builtins-'));
  t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  fs.cpSync(path.join(__dirname, '../language'), path.join(root, 'language'), { recursive: true });
  fs.cpSync(path.resolve(__dirname, '../../../../lang'), path.join(root, 'lang'), { recursive: true });
  const model = path.join(root, 'lang/models/hierarchy.yambl');
  const original = fs.readFileSync(model, 'utf8');
  const edited = original.replace('id hierarchy_id: string', 'id hierarchy_id: string\n    lookup by_id { key = self.hierarchy_id::value() }');
  assert.notEqual(edited, original);
  fs.writeFileSync(model, edited, 'utf8');
  const { parse } = require(path.join(root, 'language/syntax.cjs'));
  const { validate } = require(path.join(root, 'language/validation.cjs'));
  const { builtinModels } = require(path.join(root, 'language/relationships.cjs'));
  const business = parse('entity E { id id: string }', 'business.yambl');
  validate([business]);
  const hierarchy = builtinModels.get('Hierarchy');
  const lookup = hierarchy.effectiveLookups.get('by_id');
  assert.ok(lookup);
  assert.deepEqual(lookup.keys.map(key => [key.name.value, key.resolvedType.name]), [['key', 'string']]);
  assert.deepEqual(lookup.inferredInputs, []);
  assert.deepEqual(hierarchy.doc.diagnostics, []);

  const authored = parse(edited, pathToFileURL(model).href);
  authored.builtin = true;
  const symbols = validate([authored]);
  const active = symbols.get('\0builtins\0Hierarchy');
  assert.equal(active.effectiveLookups.size, 1);
  assert.equal(active.effectiveLookups.get('by_id').doc, authored);
  assert.ok(!authored.diagnostics.some(d => /duplicate lookup/.test(d.message)));

  const partial = parse('namespace builtins final entity Hierarchy { id hierarchy_id: string }', 'partial.yambl');
  const partialSymbols = validate([partial]);
  assert.equal(partialSymbols.get('\0builtins\0Hierarchy').doc, partial);
  assert.equal(partialSymbols.get('\0builtins\0Hierarchy').effectiveLookups.size, 0);
  assert.equal(partialSymbols.get('\0builtins\0hierarchy_entry').kind, 'value');
  assert.deepEqual(partial.diagnostics, []);
});

test('invalid embedded builtin lookup receives its field diagnostic', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-lookup-builtin-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  fs.cpSync(path.join(__dirname, '../language'), path.join(root, 'language'), { recursive: true });
  fs.cpSync(path.resolve(__dirname, '../../../../lang'), path.join(root, 'lang'), { recursive: true });
  const model = path.join(root, 'lang/models/hierarchy.yambl');
  const original = fs.readFileSync(model, 'utf8');
  fs.writeFileSync(model, original.replace('id hierarchy_id: string', 'id hierarchy_id: string\n    lookup by_id { key = self.missing::value() }'), 'utf8');
  const { parse } = require(path.join(root, 'language/syntax.cjs'));
  const { validate } = require(path.join(root, 'language/validation.cjs'));
  const { builtinModels } = require(path.join(root, 'language/relationships.cjs'));
  validate([parse('entity E { id id: string }', 'business.yambl')]);
  const diagnostics = builtinModels.get('Hierarchy').doc.diagnostics;
  assert.ok(diagnostics.some(item => item.message === 'unknown entity field: missing'), JSON.stringify(diagnostics));
});

test('embedded builtin lookup infers temporal and dimension inputs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-lookup-builtin-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  fs.cpSync(path.join(__dirname, '../language'), path.join(root, 'language'), { recursive: true });
  fs.cpSync(path.resolve(__dirname, '../../../../lang'), path.join(root, 'lang'), { recursive: true });
  const model = path.join(root, 'lang/models/hierarchy.yambl');
  const original = fs.readFileSync(model, 'utf8');
  const declarations = `id hierarchy_id: string
    dimension d { value source: string }
    @dimension(d) @temporal(day: date) scd attr label: string
    lookup by_label { key = self.label::value(day=input.query, source='fixed') }`;
  fs.writeFileSync(model, original.replace('id hierarchy_id: string', declarations), 'utf8');
  const { parse } = require(path.join(root, 'language/syntax.cjs'));
  const { validate } = require(path.join(root, 'language/validation.cjs'));
  const { builtinModels } = require(path.join(root, 'language/relationships.cjs'));
  validate([parse('entity E { id id: string }', 'business.yambl')]);
  const hierarchy = builtinModels.get('Hierarchy');
  const lookup = hierarchy.effectiveLookups.get('by_label');
  assert.deepEqual(lookup.inferredInputs.map(item => [item.name, item.type.name]), [['query', 'date']]);
  assert.equal(lookup.keys[0].resolvedType.name, 'string');
  assert.deepEqual(hierarchy.doc.diagnostics, []);
});

test('embedded builtin lookup resolves local constants without exporting them', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-lookup-builtin-constant-'));
  t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  fs.cpSync(path.join(__dirname, '../language'), path.join(root, 'language'), { recursive: true });
  fs.cpSync(path.resolve(__dirname, '../../../../lang'), path.join(root, 'lang'), { recursive: true });
  const model = path.join(root, 'lang/models/hierarchy.yambl');
  const original = fs.readFileSync(model, 'utf8');
  const declarations = `id hierarchy_id: string
    dimension d { value source: string }
    @dimension(d) attr label: string
    lookup by_label { key = self.label::value(source=SOURCE) }`;
  const edited = original.replace('final entity Hierarchy {', "const SOURCE: string = 'feed'\nfinal entity Hierarchy {")
    .replace('id hierarchy_id: string', declarations);
  fs.writeFileSync(model, edited, 'utf8');
  const { parse } = require(path.join(root, 'language/syntax.cjs'));
  const { validate } = require(path.join(root, 'language/validation.cjs'));
  const { builtinModels } = require(path.join(root, 'language/relationships.cjs'));
  const business = parse('entity E { id id: string }', 'business.yambl');
  validate([business]);
  const lookup = builtinModels.get('Hierarchy').effectiveLookups.get('by_label');
  assert.equal(lookup.keys[0].resolvedType.name, 'string');
  assert.deepEqual(lookup.inferredInputs, []);
  assert.deepEqual(lookup.doc.diagnostics, []);
  assert.equal(business.scope.has('SOURCE'), false);

  const independent = parse("const SOURCE: string = 'local' entity E { id id: string }", 'independent.yambl');
  validate([independent]);
  assert.deepEqual(independent.diagnostics, []);
  assert.equal(independent.scope.get('SOURCE'), independent.declarations[0]);
});

test('embedded builtin extensions retain entity identity and lookup fields across refreshes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-builtin-lookup-extend-'));
  t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  fs.cpSync(path.join(__dirname, '../language'), path.join(root, 'language'), { recursive: true });
  fs.cpSync(path.resolve(__dirname, '../../../../lang'), path.join(root, 'lang'), { recursive: true });
  const model = path.join(root, 'lang/models/hierarchy.yambl');
  fs.appendFileSync(model, '\nentity BuiltinOpen { id key: string }\n', 'utf8');
  const extension = path.join(root, 'lang/models/extension.yambl');
  fs.writeFileSync(extension, 'namespace builtins\nextend BuiltinOpen { attr label: string lookup by_label { key = self.label::value() } }\n', 'utf8');
  const { parse } = require(path.join(root, 'language/syntax.cjs'));
  const { validate } = require(path.join(root, 'language/validation.cjs'));
  const { builtinModels } = require(path.join(root, 'language/relationships.cjs'));
  for (let pass = 0; pass < 2; pass++) {
    validate([parse('entity E { id id: string }', 'business.yambl')]);
    const entity = builtinModels.get('BuiltinOpen');
    assert.equal(entity.kind, 'entity');
    const lookup = entity.effectiveLookups.get('by_label');
    assert.equal(lookup.keys[0].resolvedType.name, 'string');
    assert.equal(lookup.doc.uri, pathToFileURL(extension).href);
    assert.deepEqual(lookup.doc.diagnostics, []);
  }
  const authored = parse('namespace builtins entity BuiltinOpen { id key: string }', 'authored.yambl');
  const symbols = validate([authored]);
  const replacement = symbols.get('\0builtins\0BuiltinOpen');
  assert.equal(replacement.doc, authored);
  assert.equal(replacement.effectiveLookups.size, 0);
  assert.equal(replacement.effective.has('label'), false);
  assert.deepEqual(authored.diagnostics, []);
});

test('lookup snippets are offered only within entity or extend bodies', () => {
  for (const [source, offered] of [['entity A { | }', true], ['entity A {} extend A { | }', true], ['value a { | }', false], ['|', false], ['entity A { lookup x { | } }', false]]) {
    const item = editor(source).feature('completion').items.find(entry => entry.label === 'lookup');
    assert.equal(Boolean(item), offered, source);
    if (item) assert.match(item.insertText, /lookup \$\{1:name\}/);
  }
});

test('lookup completion recovers paths and node-specific parameters', () => {
  const model = 'entity Issuer { attr name: string } entity A { attr issuer: Issuer @temporal(day: date) scd attr code: string ';
  for (const [body, expected] of [
    ['lookup by_ { key = self.| } }', ['issuer', 'code']],
    ['lookup by_ { key = self.issuer.| } }', ['name']],
    ['lookup by_ { key = self.code::| } }', ['value']],
    ['lookup by_ { key = self.code::value(| } }', ['day']],
    ['lookup by_ { key = self.code::value(day=| } }', ['input']],
    ['lookup by_ { key = self.code::value(day=input.query) other = self.code::value(day=input.|) } }', ['query']],
  ]) {
    const items = labels(editor(model + body).feature('completion'));
    for (const name of expected) assert.ok(items.includes(name), `${body}: ${name}`);
    if (body.includes('::|')) assert.ok(!items.includes('best_available'));
  }
});

test('lookup field completion distinguishes references and omits unsupported fields', () => {
  const result = editor('entity Issuer { attr name: string } entity A { attr issuer: Issuer attr name: string attr items: values<string> config attr setting: integer = 1 lookup by_name { key = self.| } }').feature('completion');
  assert.match(result.items.find(i => i.label === 'issuer').detail, /Entity reference; path can continue/);
  assert.match(result.items.find(i => i.label === 'name').detail, /^Value/);
  assert.ok(!labels(result).includes('items'));
  assert.ok(!labels(result).includes('setting'));
});

test('lookup completion excludes sibling-only and unsupported calculated fields', () => {
  const source = `entity Root { attr root: string }
entity Sibling inherits Root { attr sibling: string }
entity Branch inherits Root { computed attr calculated: string { return 'x' } @temporal(day: date) snapshot attr snapshot: string lookup chosen { key = self.| } }
entity Child inherits Branch { attr descendant: string }`;
  const result = labels(editor(source).feature('completion'));
  assert.ok(result.includes('root'));
  assert.ok(result.includes('descendant'));
  for (const name of ['sibling', 'calculated', 'snapshot']) assert.ok(!result.includes(name), name);
});

test('lookup suggestions are suppressed in comments, strings and Markdown blocks', () => {
  for (const source of ['entity A { # |lookup example\n }', "entity A { @title('|lookup example') attr x: string }", 'entity A {\n---\n|lookup example\n---\n}']) {
    const result = editor(source).feature('completion');
    assert.ok(!result || !result.items.some(item => item.label === 'lookup'), source);
  }
});

test('lookup input references and inferred names follow unsaved edits', () => {
  const service = new Service(() => {}), uri = 'untitled:lookup-updates';
  let text = `entity A { @temporal(day: date) scd attr code: string lookup by_code {
    first = self.code::value(day=input.current)
    second = self.code::value(day=input.current)
  } }`;
  const feature = (method, offset) => service.feature('textDocument/' + method, { textDocument: { uri }, position: position(text, offset), context: { includeDeclaration: false } });
  service.open.set(uri, { text, version: 1 }); service.refresh();
  assert.equal(feature('references', text.indexOf('input.current') + 'input.'.length).length, 2);
  text = text.replaceAll('input.current', 'input.latest');
  service.open.set(uri, { text, version: 2 }); service.refresh();
  const completion = feature('completion', text.lastIndexOf('input.latest') + 'input.'.length).items.map(item => item.label);
  assert.ok(completion.includes('latest'));
  assert.ok(!completion.includes('current'));
});

test('lookup parameter completion excludes already bound parameters', () => {
  const prefix = 'entity A { dimension d { value source: string } @dimension(d) @temporal(day: date) scd attr code: string lookup by_code { key = self.code::value(day=input.query, ';
  for (const suffix of ['|) } }', 'so|) } }']) {
    const items = labels(editor(prefix + suffix).feature('completion'));
    assert.ok(items.includes('source'), suffix);
    assert.ok(!items.includes('day'), suffix);
  }
});

test('lookup inferred signatures follow field, dimension and fixed binding edits', () => {
  const service = new Service(() => {}), uri = 'untitled:lookup-edits';
  let text = `entity A {
    dimension d { value source: string }
    @dimension(d) @temporal(day: date) scd attr code: string
    attr label: integer
    lookup by_code { key = self.code::value() }
  }`;
  let version = 0;
  const refresh = () => { service.open.set(uri, { text, version: ++version }); service.refresh(); };
  const hover = () => service.feature('textDocument/hover', { textDocument: { uri }, position: position(text, text.indexOf('by_code')) }).contents.value;
  refresh();
  assert.match(hover(), /key: string/);
  assert.match(hover(), /day: date/);
  assert.match(hover(), /source: string/);
  text = text.replace('value source: string', 'value origin: string');
  refresh();
  assert.match(hover(), /origin: string/);
  assert.doesNotMatch(hover(), /source: string/);
  text = text.replace('self.code::value()', "self.code::value(day=input.query, origin='fixed')");
  refresh();
  assert.match(hover(), /query: date/);
  assert.doesNotMatch(hover(), /origin: string|day: date/);
  text = text.replace("self.code::value(day=input.query, origin='fixed')", 'self.label::value()');
  refresh();
  assert.match(hover(), /key: integer/);
  assert.doesNotMatch(hover(), /query: date|origin: string|day: date/);
});

test('lookup binding completion suggests typed constants and dictionary members', () => {
  const source = `decodes Sources { - 1 Primary: 'Primary' }
const PREFERRED: code<Sources> = Sources.Primary
const WRONG: integer = 1
entity A { dimension sources { value source: code<Sources> } @dimension(sources) attr code: string lookup by_code { code = self.code::value(source=|) } }`;
  const items = labels(editor(source).feature('completion'));
  assert.ok(items.includes('Sources.Primary'));
  assert.ok(items.includes('PREFERRED'));
  assert.ok(items.includes('input'));
  assert.ok(!items.includes('WRONG'));
});

test('lookup handles multiline intermediate calls and tracks active parameters', () => {
  const prefix = `entity Issuer { attr name: string }
entity A { dimension source { value source: string } @dimension(source) @temporal(day: date) scd attr issuer: Issuer
lookup by_issuer { name = self.issuer::value(\n    day=input.day,\n    source='fixed'\n)`;
  assert.ok(labels(editor(prefix + '.| } }').feature('completion')).includes('name'));
  const signature = editor(prefix.replace("source='fixed'", '|source=\'fixed\'') + '.name::value() } }').feature('signatureHelp');
  assert.deepEqual(signature.signatures[0].parameters.map(p => p.label).sort(), ['day: date', 'source: string']);
  assert.equal(signature.signatures[0].parameters[signature.activeParameter].label, 'source: string');
});

test('lookup hover, definitions, references, signature and outline use analyzed rule', () => {
  const model = `entity Issuer { attr name: string }
entity A {
    attr issuer: Issuer
    @temporal(day: date) scd attr code: string
    lookup by_code { key = self.code::value(day=input.query) name = self.issuer.name::value() }
}
extend A { lookup by_id { key = self.code::value() } }`;
  const at = needle => editor(model.replace(needle, '|' + needle));
  assert.match(at('by_code').feature('hover').contents.value, /Keys: key: string, name: string/);
  assert.match(at('by_code').feature('hover').contents.value, /prepare_a_by_code\(\*, query: date\) -> Success<AByCodeMatcher> \| NonNormalResult/);
  assert.match(at('key = self.code').feature('hover').contents.value, /Source: self.code::value/);
  assert.equal(at('issuer.name').feature('definition').range.start.line, 2);
  const input = at('query)');
  assert.equal(input.feature('references').length, 1);
  assert.match(input.feature('hover').contents.value, /input\.query: date \(required\)/);
  const signature = editor(model.replace('day=input.query', '|day=input.query')).feature('signatureHelp');
  assert.match(signature.signatures[0].label, /value\(day: date\)/);
  const symbols = at('by_code').feature('documentSymbol');
  const rule = symbols.find(s => s.name === 'A').children.find(s => s.name === 'by_code');
  assert.deepEqual(rule.children.map(s => s.name), ['key', 'name']);
  assert.ok(symbols.some(s => s.name === 'A.by_id'));
});

test('lookup names preserve acronym spelling and inherited matcher identity', () => {
  const source = 'entity FXRate { id id: string lookup |by_client_id { client_id = self.id::value() } } entity FXBond inherits FXRate {}';
  const hover = editor(source).feature('hover').contents.value;
  assert.match(hover, /prepare_f_x_rate_by_client_id\(\) -> Success<FXRateByClientIdMatcher> \| NonNormalResult/);
  assert.match(hover, /prepare_f_x_bond_by_client_id\(\) -> Success<FXRateByClientIdMatcher> \| NonNormalResult/);
  assert.ok(labels(editor('entity FXRate { | }').feature('completion')).includes('lookup'));
});

test('unfinished lookup does not hide other declarations from navigation or completion', () => {
  for (const unfinished of ['lookup broken { key = self. }', 'lookup by_', 'lookup { key = self.id::value() }']) {
    const text = `entity A { ${unfinished} }
entity B { attr label: string computed attr result: string { return self.|label::value() } }`;
    const edit = editor(text);
    assert.equal(edit.feature('definition').range.start.line, 1, unfinished);
    assert.ok(labels(edit.feature('completion')).includes('label'));
    assert.ok(edit.service.document(edit.uri).errors.length);
  }
});

test('unfinished lookup preserves other rules in the same entity', () => {
  const source = 'entity A { id id: string lookup valid { key = self.|id::value() } lookup broken { key = self. } }';
  const edit = editor(source);
  assert.ok(edit.service.document(edit.uri).errors.length);
  assert.equal(edit.feature('definition').range.start.character, source.indexOf('id id:') + 3);
  assert.ok(labels(edit.feature('completion')).includes('id'));
});

test('an unfinished lookup at end of file preserves earlier declarations', () => {
  for (const unfinished of ['lookup by_', 'lookup pending { key = self.', 'lookup pending { key = self.id::value(']) {
    const source = `entity B { attr label: string computed attr result: string { return self.|label::value() } }\nentity A { ${unfinished}`;
    const edit = editor(source);
    assert.ok(edit.service.document(edit.uri).errors.length);
    assert.equal(edit.feature('definition').range.start.line, 0, unfinished);
    assert.ok(labels(edit.feature('completion')).includes('label'));
  }
});

test('lookup paths, parameters and references navigate across files and inheritance', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yambl-lookup-'));
  t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 3 }));
  const files = {
    'yambl-root.lclcfg': "prefix: ''",
    'shared.yambl': "namespace shared decodes Sources { - 1 Primary: 'Primary' } const DAY: date = parse_date('2026-10-28') const OTHER: date = parse_date('2026-10-29')",
    'base.yambl': 'namespace core from shared import Sources entity Issuer { attr name: string } entity Security { id id: string attr name: string attr issuer: Issuer dimension sources { value source: code<Sources> } }',
    'extension.yambl': 'namespace core from shared import Sources from shared import DAY extend Security { @dimension(sources) @temporal(day: date) scd attr external: string lookup by_data { label = self.name::value() issuer = self.issuer.name::value() ext = self.external::value(day=DAY, source=Sources.Primary) } }',
    'child.yambl': 'namespace core entity Bond inherits Security { computed attr value: string { return self.external::value() } }',
  };
  const uris = {};
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name); fs.writeFileSync(file, text, 'utf8'); uris[name] = pathToFileURL(file).href;
  }
  const service = new Service(() => {});
  service.open.set(uris['extension.yambl'], { text: files['extension.yambl'], version: 1 }); service.refresh();
  const feature = (file, method, offset) => service.feature('textDocument/' + method, { textDocument: { uri: uris[file] }, position: position(service.document(uris[file]).text, offset), context: { includeDeclaration: false } });
  const extension = files['extension.yambl'];
  const location = (file, offset, length) => ({ uri: uris[file], range: { start: position(files[file], offset), end: position(files[file], offset + length) } });
  const base = files['base.yambl'];
  const shared = files['shared.yambl'];
  const securityName = base.indexOf('attr name: string', base.indexOf('entity Security')) + 'attr '.length;
  assert.deepEqual(feature('extension.yambl', 'definition', extension.indexOf('self.name') + 5), location('base.yambl', securityName, 'name'.length));
  assert.deepEqual(feature('extension.yambl', 'definition', extension.indexOf('issuer.name') + 'issuer.'.length), location('base.yambl', base.indexOf('attr name: string') + 'attr '.length, 'name'.length));
  assert.deepEqual(feature('extension.yambl', 'definition', extension.lastIndexOf('Sources.Primary') + 'Sources.'.length), location('shared.yambl', shared.indexOf('Primary'), 'Primary'.length));
  assert.deepEqual(feature('extension.yambl', 'definition', extension.lastIndexOf('DAY')), location('shared.yambl', shared.indexOf('DAY'), 'DAY'.length));
  assert.deepEqual(feature('extension.yambl', 'definition', extension.indexOf('day=DAY')), location('extension.yambl', extension.indexOf('day: date'), 'day'.length));
  assert.deepEqual(feature('extension.yambl', 'definition', extension.indexOf('source=Sources')), location('base.yambl', base.indexOf('value source') + 'value '.length, 'source'.length));
  assert.ok(feature('base.yambl', 'references', securityName).some(item => JSON.stringify(item) === JSON.stringify(location('extension.yambl', extension.indexOf('self.name') + 5, 'name'.length))));
  assert.ok(feature('base.yambl', 'references', base.indexOf('value source') + 'value '.length).some(item => JSON.stringify(item) === JSON.stringify(location('extension.yambl', extension.indexOf('source=Sources'), 'source'.length))));
  assert.ok(feature('shared.yambl', 'references', shared.indexOf('Primary')).some(item => JSON.stringify(item) === JSON.stringify(location('extension.yambl', extension.lastIndexOf('Sources.Primary') + 'Sources.'.length, 'Primary'.length))));
  assert.ok(feature('shared.yambl', 'references', shared.indexOf('DAY')).some(item => JSON.stringify(item) === JSON.stringify(location('extension.yambl', extension.lastIndexOf('DAY'), 'DAY'.length))));
  assert.equal(feature('extension.yambl', 'definition', extension.indexOf('self.name') + 5).uri, uris['base.yambl']);
  assert.equal(feature('extension.yambl', 'definition', extension.indexOf('issuer.name') + 'issuer.'.length).uri, uris['base.yambl']);
  assert.equal(feature('extension.yambl', 'definition', extension.lastIndexOf('Sources.Primary') + 'Sources.'.length).uri, uris['shared.yambl']);
  assert.equal(feature('extension.yambl', 'definition', extension.lastIndexOf('DAY')).uri, uris['shared.yambl']);
  assert.equal(feature('extension.yambl', 'definition', extension.indexOf('day=DAY')).uri, uris['extension.yambl']);
  assert.equal(feature('extension.yambl', 'definition', extension.indexOf('source=Sources')).uri, uris['base.yambl']);
  assert.ok(feature('base.yambl', 'references', base.indexOf('attr name: string', base.indexOf('entity Security')) + 5).some(item => item.uri === uris['extension.yambl']));
  assert.ok(feature('base.yambl', 'references', base.indexOf('value source') + 'value '.length).some(item => item.uri === uris['extension.yambl']));
  assert.ok(feature('shared.yambl', 'references', files['shared.yambl'].indexOf('Primary')).some(item => item.uri === uris['extension.yambl']));
  assert.ok(feature('shared.yambl', 'references', files['shared.yambl'].indexOf('DAY')).some(item => item.uri === uris['extension.yambl']));
  const changedImport = extension.replace('import DAY', 'import OTHER').replace('day=DAY', 'day=OTHER');
  service.open.set(uris['extension.yambl'], { text: changedImport, version: 2 }); service.refresh();
  assert.deepEqual(feature('extension.yambl', 'definition', changedImport.lastIndexOf('OTHER')), location('shared.yambl', shared.indexOf('OTHER'), 'OTHER'.length));
  assert.ok(!feature('shared.yambl', 'references', shared.indexOf('DAY')).some(item => item.uri === uris['extension.yambl']));
  assert.ok(feature('shared.yambl', 'references', shared.indexOf('OTHER')).some(item => item.uri === uris['extension.yambl']));
  const broken = extension.replace('self.name::value()', 'self.');
  service.open.set(uris['extension.yambl'], { text: broken, version: 3 }); service.refresh();
  assert.ok(service.document(uris['extension.yambl']).errors.length);
  const child = files['child.yambl'];
  assert.equal(feature('child.yambl', 'definition', child.indexOf('self.external') + 5).uri, uris['extension.yambl']);
  assert.ok(labels(feature('child.yambl', 'completion', child.indexOf('self.external') + 5)).includes('external'));
  const childPartial = child.replace('computed attr value: string { return self.external::value() }', 'lookup by_external { key = self. }');
  service.open.set(uris['child.yambl'], { text: childPartial, version: 2 }); service.refresh();
  assert.ok(labels(feature('child.yambl', 'completion', childPartial.indexOf('self.') + 5)).includes('external'));
  service.open.set(uris['extension.yambl'], { text: extension, version: 4 }); service.refresh();
  assert.equal(feature('extension.yambl', 'definition', extension.indexOf('self.name') + 5).uri, uris['base.yambl']);
});
