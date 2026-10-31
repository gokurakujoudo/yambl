'use strict';
// Optional development check. Python is never invoked by the installed extension.
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, format } = require('../language/syntax.cjs');
const { validate } = require('../language/validation.cjs');
const cases = [...require('./cases.json'), ...require('./expression-cases.json'), ...require('./flags-cases.json'), ...require('./decorator-cases.json'), ...require('./computation-cases.json')];
cases.push(
  ["hierarchy H { - 1 'x' } entity A { id id: string attr h: Hierarchy } entity B inherits A { @override attr h: exact<H> }"],
  ['entity A { id id:string @relationship(one, maybe) attr b:B } entity B { id id:string @relationship(one, maybe) attr c:C } entity C { id id:string @reverse_relationship(A.b.c) attr a:A }'],
  ['entity A { id id:string @relationship(one, maybe) attr b:B } entity B { id id:string @relationship(many, maybe) attr c:C } entity C { id id:string @reverse_relationship(A.b.c) attr a:A }'],
  ['entity A { id id:string @relationship(one, maybe) attr b:B } entity B { id id:string @relationship(one, maybe) attr c:C } entity C { id id:string @reverse_relationship(A.b.missing) attr a:A }'],
  ['entity A { attr n: integer constraint valid { let x = self.n::value() assert x > 0 let y = 2 assert y > x } }'],
  ['entity A { constraint valid { assert later > 0 let later = 1 assert 2 } } entity B inherits A { constraint valid {} }'],
  ['entity A { snapshot attr n: integer constraint c { assert self.n::value() > 0 } }'],
  ["decodes Sources { - 1 Feed: 'Feed' } entity E { dimension feed { value source: code<Sources> hierarchy order: Hierarchy } @dimension(feed) attr price: integer computed attr chosen: code<Sources> { return self.price::best_available().dimensions.source } }"],
  ["entity E { attr price: integer computed attr amount: integer { return self.price::best_available() * 2 } }"],
  ["entity E { attr price: integer computed attr amount: integer { return self.price::best_available().dimensions.missing } }"],
);
cases.push(...require('./literal-cases.json'));
cases.push(...require('./lookup-cases.json'));
const lookupSemanticStart = cases.length;
cases.push(...require('./lookup-semantic-cases.json'));
const lookupSemanticEnd = cases.length;
const workspace = path.resolve(__dirname, '../../../../..');
const compilerFixtures = path.join(workspace, 'yambl-compiler/tests/fixtures/editor');
for (const name of ['cases.json', 'expression-cases.json', 'flags-cases.json', 'decorator-cases.json', 'transaction-cases.json', 'transaction-image-cases.json', 'transaction-type-cases.json']) {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(compilerFixtures, name), 'utf8')), JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8')), `Compiler fixture differs: ${name}`);
}
const model = path.join(__dirname, 'fixtures', 'example', 'model');
const files = require('../service.cjs').sources(model);
cases.push(files.map(file => fs.readFileSync(file, 'utf8')));
const modelRoot = require('../language/relationships.cjs').modelRoot;
cases.push(require('../service.cjs').sources(modelRoot).map(file => fs.readFileSync(file, 'utf8')));
const python = process.argv[2] || path.join(workspace, 'yambl-compiler/venv/Scripts/python.exe');
const grammar = fs.readFileSync(path.join(workspace, 'yambl-compiler/src/yambl_compiler/grammars/yambl.lark'), 'utf8');
const vocabulary = require('../language/syntax.cjs');
for (const name of ['NOT_DEFINED', 'NOT_APPLICABLE', 'EMPTY', 'NO_ENTRY', 'NO_DATA', 'ENTITY_NOT_FOUND', 'ERROR']) {
  for (const text of [
    `entity A { attr x: ${name} }`, `type label = ${name}`, `@title(${name}) entity A {}`,
    `entity A { attr x: exact<${name}> }`, `entity A { attr x: ${name} + AttrCats.Static }`,
    `@targets(DecoratorTargets.All) decorator @note(text: string = ${name})`,
    `entity ${name} {}`, `namespace builtins entity ${name} {}`,
    `entity A { config attr x: string = ${name} }`,
    `entity A { attr x: code<${name}> }`, `entity A { attr x: code<'${name}'> }`,
    `@title('${name}') entity A { config attr x: string = '${name}' }`,
  ]) cases.push([text]);
}
cases.push(["decodes Codes { - 1 ERROR: 'Error' } @title(Codes.ERROR) entity Empty {}"]);

const relationshipStart = cases.length;
for (const x of ['one', 'many']) for (const [y, target] of [['maybe', 'Target'], ['one', 'Target'], ['maybe', 'collection<Target>'], ['many', 'collection<Target>']]) {
  const reverse = x === 'one' ? 'Source' : 'collection<Source>';
  cases.push([`entity Source { id id:string @relationship(${x}, ${y}) attr target:${target} } entity Target { id id:string @reverse_relationship(Source.target) attr sources:${reverse} }`]);
}
cases.push(
  ['entity A { @relationship(maybe, one) attr b:B } entity B {}'],
  ["entity A { @relationship(one, 'one') attr b:B } entity B {}"],
  ['entity A { @relationship(one, bad) attr b:B } entity B {}'],
  ['entity A { @relationship(one, one) attr b:collection<B> } entity B {}'],
  ['entity A { @relationship(one) attr b:B } entity B {}'],
  ['entity A { @relationship(x=one, y=one, y=one) attr b:B } entity B {}'],
  ['entity A { @relationship(one, many) attr b:B } entity B {}'],
  ['entity A { @relationship(one, one) attr b:string }'],
  ['entity A { @relationship(many, one) attr b:Entity }'],
  ['entity A { attr b:B } entity B { @reverse_relationship(A.b) attr a:collection<A> }'],
  ['entity A { @relationship(one, one) attr b:B } entity B { @reverse_relationship(A.b) attr a:collection<A> }'],
  ['entity A { @relationship(many, one) @temporal(date:date) scd attr b:B } entity B { @reverse_relationship(A.b) @temporal(day:date) scd attr a:collection<A> }'],
  ["dimension d { value source:string hierarchy h:Hierarchy = 'H' } entity A { @dimension(d) @relationship(many, one) attr b:B } entity B {}"],
  ["dimension a { value source:string } dimension b { value source:string } entity A { @dimension(a) @relationship(many,one) attr b:B } entity B { @dimension(b) @reverse_relationship(A.b) attr a:collection<A> }"],
  ['entity A { @relationship(many,one) attr b:B } entity B { @reverse_relationship(A.missing) attr a:collection<A> }'],
  ['entity A { @relationship(many,one) attr b:A } entity B { @reverse_relationship(A.b) attr a:collection<A> }'],
  ['entity A { @relationship(many,one) attr b:B } entity B { @sparse(\'x\') @reverse_relationship(A.b) attr a:collection<A> }'],
  ['namespace source entity Source { id id:string @relationship(y=one,x=many) attr target:Target } entity Child inherits Source {} entity Target { id id:string }', 'namespace use from source import Child from source import Target extend Target { @reverse_relationship(target=Child.target) attr sources:collection<Child> }'],
);
const relationshipEnd = cases.length;

cases.push(
  ["decodes Sources { - 1 Wind: 'Wind' } hierarchy Preferred { - 1 Sources.Wind - 2 'Manual' } dimension source_dim { value source: code<Sources> hierarchy priority: Hierarchy = Preferred } entity E { @dimension(source_dim) snapshot attr price: integer computed attr x: integer { return self.price::best_available(priority=Sources::hierarchy()).value } }"],
  ["namespace common decodes Sources { - 1 Wind: 'Wind' } hierarchy Preferred { - 1 Sources.Wind } dimension source_dim { value source: code<Sources> hierarchy priority: Hierarchy = Preferred }", "namespace model from common import source_dim entity E { @dimension(source_dim) snapshot attr price: integer }"],
  ["hierarchy H { - 1 'a' - 1 'b' }"],
  ["@flags decodes Flags { - 1 A: 'a' } hierarchy H { - 1 Flags.A }"],
  ["dimension shared { value source: string fallback_days = self.x::value() }"],
  ["decodes D { - 1 A: 'A' } hierarchy H { - 1 D.Bad - 2 Missing.X }"],
  ["dimension d { value source: string hierarchy priority: Hierarchy = Missing }"],
  ["@flags decodes Flags { - 1 A: 'a' } dimension d { value source: string hierarchy priority: Hierarchy = Flags::hierarchy() }"],
  ["@flags decodes Flags { - 1 A: 'a' } entity E { dimension d { value source: string hierarchy priority: Hierarchy } @dimension(d) snapshot attr price: integer computed attr x: integer { return self.price::best_available(priority=Flags::hierarchy()).value } }"],
  ["entity E { static attr dictionary: Decodes dimension d { value source: string hierarchy priority: Hierarchy = self.dictionary::value()::hierarchy() } @dimension(d) snapshot attr price: integer }"],
  ["dimension d { value source: string hierarchy priority: Hierarchy = 42 }"],
  ["dimension d { value Bad: string }"],
  ["const H: string = 'Local' dimension d { value source: string hierarchy priority: Hierarchy = H }"],
  ["dimension source_dim { value source: string } entity E { attr wrong: source_dim }"],
  ["hierarchy Preferred {} entity E { attr wrong: Preferred }"],
  ["entity E { static attr bad: string dimension d { value source: string hierarchy priority: Hierarchy = self.bad::value()::hierarchy() } @dimension(d) snapshot attr price: integer }"],
  ["dimension d { value source: string hierarchy h: Hierarchy = EMPTY }"],
  ["dimension d { value source: string hierarchy h: Hierarchy = if true then EMPTY else 'Local' }"],
  ["hierarchy A {} hierarchy B {} dimension d { value source: string hierarchy h: Hierarchy = if true then A else B }"],
  ["namespace one hierarchy H {- 1 'A'} dimension d_one {value source:string hierarchy h:Hierarchy=H}", "namespace two hierarchy H {- 1 'B'} dimension d_two {value source:string hierarchy h:Hierarchy=H}", "namespace use from one import d_one from two import d_two entity E {id id:string @dimension(d_one) attr x:string @dimension(d_two) attr y:string computed attr z:bool {return self.x::best_available().value == self.y::best_available().value}}"],
  ["namespace one hierarchy H {- 1 'A'} dimension d_one {value source:string hierarchy h:Hierarchy=H}", "namespace two from one import H dimension d_two {value source:string hierarchy h:Hierarchy=H}", "namespace use from one import d_one from two import d_two entity E {id id:string @dimension(d_one) attr x:string @dimension(d_two) attr y:string computed attr z:bool {return self.x::best_available().value == self.y::best_available().value}}"],
  ['entity Root {} entity Child inherits Root {} entity Leaf inherits Child {} entity Use { attr choice: code<Root::subtypes> attr empty: code<Leaf::subtypes> }'],
  ['entity Root {} entity Child inherits Root {} entity Use { computed attr selected: code<Root::subtypes> { return Root::subtypes.Child } }'],
  ['entity Root {} entity Child inherits Root {} const CHOICE: code<Root::subtypes> = Root::subtypes.Child'],
  ['entity Root {} entity Use { computed attr selected: code<Root::subtypes> { return Root::subtypes.Bad } }'],

  ["entity Root {} @decodes_rank(-5, 'Child') entity Child inherits Root {} @decodes_rank(5, 'Leaf') entity Leaf inherits Child {}"],
  ["@decodes_rank(1, 'Root') entity Root {}"],
  ['namespace core entity Root {}', 'namespace left from core import Root entity Same inherits Root {}', 'namespace right from core import Root entity Same inherits Root {}'],
  ['entity Root {} entity Use { attr invalid: code<Root::subtypes.Unknown> }'],
);

cases.push(
  ["type segment = string['[A-Z]+'] type identifier = string[regex: '${segment}']"],
  ["type identifier = string['${missing}']"],
  ["type segment = string type identifier = string['${segment}']"],
  ["type first = string['${second}'] type second = string['${first}']"],
  ["type identifier = string['\\${missing}']"],
  ["abstract entity Root { abstract computed attr label: string } entity Child inherits Root { @override computed attr label: string { return 'Child' } }"],
  ['abstract entity Root { abstract computed attr label: string } entity Child inherits Root {}'],
  ["namespace core abstract entity Root {}", "namespace derived from core import Root extend Root { abstract computed attr label: string } entity Child inherits Root { @override computed attr label: string { return 'Child' } }"],
  ["abstract entity Root {} @decodes_rank(1, 'Group') abstract entity Group inherits Root {}"],
  ["abstract entity Root { abstract computed attr v: integer } entity A inherits Root { @override @extra_input_param(day: date = '2026-01-01') computed attr v: integer { return 1 } } entity B inherits Root { @override @extra_input_param(day: date = '2026-02-01') computed attr v: integer { return 2 } }"],
);

for (const line of grammar.split('\n')) {
  const match = /^[A-Z]+: \/(.+)\\b\//.exec(line);
  if (!match) continue;
  for (const word of match[1].replace(/^\(\?:|\)$/g, '').split('|')) {
    assert.ok([...vocabulary.keywords, ...vocabulary.annotations, ...vocabulary.constants].includes(word), `Compiler keyword missing from LSP/highlighting vocabulary: ${word}`);
  }
}
const source = `
import json, sys
from pathlib import Path
from yambl_compiler.languages.yambl.syntax.parser import parse, Diagnostic
from yambl_compiler.languages.yambl.semantics.validation import check
from yambl_compiler.languages.yambl.formatting.formatter import format_document
results = []
for group in json.load(sys.stdin):
    docs = [parse(text, Path(str(i))) for i, text in enumerate(group)]
    syntax = [isinstance(doc, Diagnostic) for doc in docs]
    diagnostics = check(docs) if not any(syntax) else []
    results.append({'syntax': syntax, 'format': [None if isinstance(doc, Diagnostic) else format_document(doc) for doc in docs],
                    'diagnostics': sorted((1 if d.severity == 'error' else 2, d.message) for d in diagnostics) if not any(syntax) else None,
                    'locations': sorted((1 if d.severity == 'error' else 2, d.message, d.line, d.column) for d in diagnostics) if not any(syntax) else None})
json.dump(results, sys.stdout, ensure_ascii=True)
`;
const result = spawnSync(python, ['-X', 'utf8', '-c', source], { input: JSON.stringify(cases), encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
assert.equal(result.status, 0, result.stderr || result.error?.message);
const expected = JSON.parse(result.stdout);
cases.forEach((group, i) => {
  const docs = group.map((text, i) => parse(text, String(i))); validate(docs);
  const syntax = docs.map(d => d.errors.length > 0);
  const actual = { syntax, format: docs.map(format), diagnostics: syntax.some(Boolean) ? null : docs.flatMap(d => d.diagnostics.map(x => [x.severity, x.message])).sort() };
  if ((i >= lookupSemanticStart && i < lookupSemanticEnd) || (i >= relationshipStart && i < relationshipEnd)) {
    actual.locations = syntax.some(Boolean) ? null : docs.flatMap(d => d.diagnostics.map(x => [x.severity, x.message, x.range.start.line + 1, x.range.start.character + 1])).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[2] - b[2] || a[3] - b[3]);
  } else delete expected[i].locations;
  assert.deepEqual(actual, expected[i], `Compiler parity failed for case ${i}: ${group}`);
});
console.log(`Passed Python/LSP parity for ${cases.length} compilation units, including the example model.`);

const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'yambl-builtin-lookup-parity-'));
try {
  const pythonBuiltins = `
import json, sys
from pathlib import Path
from yambl_compiler.languages.yambl.semantics.builtins import RESULT_CONSTANTS, load_models
from yambl_compiler.languages.yambl.semantics.symbols import resolve_scopes
from yambl_compiler.languages.yambl.semantics.validation import analyze_units
from yambl_compiler.languages.yambl.syntax.parser import parse
diagnostics = []
units = resolve_scopes([parse(sys.argv[5], Path('business.yambl'))], diagnostics, load_models(Path(sys.argv[1])), RESULT_CONSTANTS)
analysis = analyze_units(units, diagnostics)
rule = analysis.lookups[('builtins', sys.argv[2])][sys.argv[3]]
print(json.dumps({'type': rule.keys[0].type.name, 'inputs': [(p.name, p.type.name) for p in rule.inputs],
    'business_has_source': 'SOURCE' in units[0].scope,
    'diagnostics': sorted((d.message, d.line, d.column) for d in analysis.diagnostics if d.path.name == sys.argv[4])}))
`;
  for (const scenario of [
    { name: 'valid', entity: 'Hierarchy', rule: 'by_id', file: 'hierarchy.yambl', declarations: 'id hierarchy_id: string\n    lookup by_id { key = self.hierarchy_id::value() }' },
    { name: 'invalid', entity: 'Hierarchy', rule: 'by_id', file: 'hierarchy.yambl', declarations: 'id hierarchy_id: string\n    lookup by_id { key = self.missing::value() }' },
    { name: 'dimension', entity: 'Hierarchy', rule: 'by_id', file: 'hierarchy.yambl', declarations: "id hierarchy_id: string\n    dimension d { value source: string }\n    @dimension(d) @temporal(day: date) scd attr label: string\n    lookup by_id { key = self.label::value(day=input.query, source='fixed') }" },
    { name: 'constant', entity: 'Hierarchy', rule: 'by_id', file: 'hierarchy.yambl', constant: true, declarations: "id hierarchy_id: string\n    dimension d { value source: string }\n    @dimension(d) attr label: string\n    lookup by_id { key = self.label::value(source=SOURCE) }" },
    { name: 'extension', entity: 'BuiltinOpen', rule: 'by_label', file: 'extension.yambl', declarations: 'id hierarchy_id: string' },
    { name: 'shadow', entity: 'Hierarchy', rule: 'by_id', file: 'business.yambl', declarations: 'id hierarchy_id: string\n    lookup by_id { key = self.hierarchy_id::value() }', business: 'namespace builtins final entity Hierarchy { id hierarchy_id: string lookup by_id { key = self.hierarchy_id::value() } }' },
  ]) {
    const root = path.join(temporary, scenario.name);
    fs.cpSync(path.join(__dirname, '../language'), path.join(root, 'language'), { recursive: true });
    fs.cpSync(modelRoot, path.join(root, 'lang'), { recursive: true });
    const hierarchyPath = path.join(root, 'lang/models/hierarchy.yambl');
    const original = fs.readFileSync(hierarchyPath, 'utf8');
    let edited = original.replace('id hierarchy_id: string', scenario.declarations);
    if (scenario.constant) edited = edited.replace('final entity Hierarchy {', "const SOURCE: string = 'feed'\nfinal entity Hierarchy {");
    if (scenario.name !== 'extension') assert.notEqual(edited, original);
    fs.writeFileSync(hierarchyPath, edited, 'utf8');
    if (scenario.name === 'extension') {
      fs.appendFileSync(hierarchyPath, '\nentity BuiltinOpen { id key: string }\n', 'utf8');
      fs.writeFileSync(path.join(root, 'lang/models/extension.yambl'), 'namespace builtins\nextend BuiltinOpen { attr label: string lookup by_label { key = self.label::value() } }\n', 'utf8');
    }
    const isolatedSyntax = require(path.join(root, 'language/syntax.cjs'));
    const isolatedValidation = require(path.join(root, 'language/validation.cjs'));
    const business = scenario.business || 'entity E { id id: string }';
    const businessDocument = isolatedSyntax.parse(business, 'business.yambl');
    const symbols = isolatedValidation.validate([businessDocument]);
    const hierarchy = symbols.get('\0builtins\0' + scenario.entity);
    const lookup = hierarchy.effectiveLookups.get(scenario.rule);
    const actual = {
      type: lookup.keys[0].resolvedType.name,
      inputs: lookup.inferredInputs.map(item => [item.name, item.type.name]),
      business_has_source: businessDocument.scope.has('SOURCE'),
      diagnostics: lookup.doc.diagnostics.map(item => [item.message, item.range.start.line + 1, item.range.start.character + 1]).sort(),
    };
    const result = spawnSync(python, ['-X', 'utf8', '-c', pythonBuiltins, path.join(root, 'lang'), scenario.entity, scenario.rule, scenario.file, business], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(actual, JSON.parse(result.stdout), `Builtin lookup parity failed for ${scenario.name}`);
  }
  console.log('Passed isolated builtin lookup parity for direct, invalid, dimensional, constant, extended and shadowed paths.');
} finally {
  fs.rmSync(temporary, { recursive: true });
}

const hierarchyInputs = `hierarchy Preferred { - 1 'A' }
entity E {
  @temporal(day: date) scd attr dictionary: Decodes
  dimension d { value source: string hierarchy h: Hierarchy = self.dictionary::value()::hierarchy() }
  dimension d2 { value origin: string hierarchy h2: Hierarchy = self.dictionary::value(day=input.history_day)::hierarchy() }
  @dimension(d) static attr label: string
  @dimension(d2) static attr market: string
  @dimension(d) @temporal(day: date) snapshot attr observed: string
  computed attr automatic: string { return self.label::best_available().value }
  computed attr explicit_hierarchy: string { return self.label::best_available(h=Preferred).value }
  computed attr explicit_source: string { return self.label::best_available(source='A').value }
  computed attr alias: string { return self.label::best_available(h=input.choice).value }
  @extra_input_param(choice: Hierarchy = 'Preferred')
  computed attr alias_declared: string { return self.label::best_available(h=input.choice).value }
  computed attr fallback: string { return self.label::best_available(h=input.choice ?? Preferred).value }
  @extra_input_param(h: Hierarchy = 'Preferred')
  computed attr declared: string { return self.label::best_available().value }
  computed attr renamed: string { return self.observed::best_available(day=input.query).value }
  computed attr nested: string { return self.renamed::value(query=input.nested_day) }
  computed attr source_date: string { return self.market::best_available().value }
}`;
const hierarchyInputPython = `
import json, sys
from pathlib import Path
from yambl_compiler.languages.yambl.syntax.parser import parse
from yambl_compiler.languages.yambl.semantics.validation import analyze
analysis = analyze([parse(sys.stdin.read(), Path('model.yambl'))])
names = ('automatic', 'explicit_hierarchy', 'explicit_source', 'alias', 'alias_declared', 'fallback', 'declared', 'renamed', 'nested', 'source_date')
print(json.dumps({name: [(item.name, item.type.name, item.required) for item in analysis.calculations[(('', 'E'), name)].inputs] for name in names}))
`;
const hierarchyResult = spawnSync(python, ['-X', 'utf8', '-c', hierarchyInputPython], { input: hierarchyInputs, encoding: 'utf8', windowsHide: true });
assert.equal(hierarchyResult.status, 0, hierarchyResult.stderr || hierarchyResult.error?.message);
const hierarchyDoc = parse(hierarchyInputs, 'model.yambl'); validate([hierarchyDoc]);
const hierarchyEntity = hierarchyDoc.declarations.find(d => d.name.value === 'E');
const hierarchyActual = Object.fromEntries(hierarchyEntity.fields.filter(f => f.calculation).map(f => [f.name.value, f.inferredInputs.map(p => [p.name, p.type.name, p.required])]));
assert.deepEqual(hierarchyActual, JSON.parse(hierarchyResult.stdout), 'Hierarchy default input parity failed');
console.log('Passed Python/LSP hierarchy default input parity.');
