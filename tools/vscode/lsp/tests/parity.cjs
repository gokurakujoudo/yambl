'use strict';
// Optional development check. Python is never invoked by the installed extension.
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, format } = require('../language/syntax.cjs');
const { validate } = require('../language/validation.cjs');
const cases = [...require('./cases.json'), ...require('./expression-cases.json'), ...require('./flags-cases.json'), ...require('./decorator-cases.json'), ...require('./computation-cases.json')];
cases.push(...require('./literal-cases.json'));
const workspace = path.resolve(__dirname, '../../../../..');
const model = path.join(workspace, 'fmc-data-model', 'model');
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
    results.append({'syntax': syntax, 'format': [None if isinstance(doc, Diagnostic) else format_document(doc) for doc in docs],
                    'diagnostics': sorted((1 if d.severity == 'error' else 2, d.message) for d in check(docs)) if not any(syntax) else None})
json.dump(results, sys.stdout, ensure_ascii=True)
`;
const result = spawnSync(python, ['-X', 'utf8', '-c', source], { input: JSON.stringify(cases), encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
assert.equal(result.status, 0, result.stderr || result.error?.message);
const expected = JSON.parse(result.stdout);
cases.forEach((group, i) => {
  const docs = group.map((text, i) => parse(text, String(i))); validate(docs);
  const syntax = docs.map(d => d.errors.length > 0);
  const actual = { syntax, format: docs.map(format), diagnostics: syntax.some(Boolean) ? null : docs.flatMap(d => d.diagnostics.map(x => [x.severity, x.message])).sort() };
  assert.deepEqual(actual, expected[i], `Compiler parity failed for case ${i}: ${group}`);
});
console.log(`Passed Python/LSP parity for ${cases.length} compilation units, including current FMC sources.`);
