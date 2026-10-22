const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Run with VS Code's Electron executable to use its bundled TextMate and Oniguruma.
async function main() {
  const codeRoot = path.dirname(process.execPath);
  const candidates = [codeRoot, ...fs.readdirSync(codeRoot).map(name => path.join(codeRoot, name))];
  const appRoot = candidates.map(root => path.join(root, 'resources', 'app'))
    .find(root => fs.existsSync(path.join(root, 'node_modules.asar', 'vscode-textmate', 'package.json')));
  assert.ok(appRoot, 'Run this check with VS Code Code.exe and ELECTRON_RUN_AS_NODE=1.');
  const textmate = require(path.join(appRoot, 'node_modules.asar', 'vscode-textmate'));
  const oniguruma = require(path.join(appRoot, 'node_modules.asar', 'vscode-oniguruma'));
  const wasm = fs.readFileSync(path.join(appRoot, 'node_modules.asar.unpacked', 'vscode-oniguruma', 'release', 'onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const language = manifest.contributes.languages[0];
  assert.equal(language.id, 'yambl');
  assert.ok(language.extensions.includes('.yambl'));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, language.configuration), 'utf8'));
  assert.equal(config.comments.lineComment, '#');
  const grammarFile = path.join(__dirname, manifest.contributes.grammars[0].path);
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: content => new oniguruma.OnigString(content),
    }),
    loadGrammar: async scope => scope === 'source.yambl'
      ? textmate.parseRawGrammar(fs.readFileSync(grammarFile, 'utf8'), grammarFile) : null,
  });
  const grammar = await registry.loadGrammar('source.yambl');
  assert.ok(grammar);

  let checks = 0;
  function expectScope(line, fragment, scope) {
    const offset = line.indexOf(fragment);
    assert.ok(offset >= 0, `Missing fragment: ${fragment}`);
    const tokens = grammar.tokenizeLine(line, textmate.INITIAL).tokens;
    const token = tokens.find(item => item.startIndex <= offset && offset < item.endIndex);
    assert.ok(token && token.scopes.includes(scope), `${fragment}: expected ${scope}, got ${JSON.stringify(token)}`);
    checks++;
  }

  expectScope('namespace core', 'core', 'entity.name.namespace.yambl');
  expectScope('namespace decodes', 'decodes', 'entity.name.namespace.yambl');
  expectScope('from decodes import Currencies', 'from', 'keyword.control.yambl');
  expectScope('from decodes import Currencies', 'decodes', 'entity.name.namespace.yambl');
  expectScope('from decodes import Currencies', 'import', 'keyword.control.yambl');
  expectScope('from decodes import Currencies', 'Currencies', 'variable.other.yambl');
  expectScope('# from decodes import Currencies', 'from', 'comment.line.number-sign.yambl');
  expectScope('entity Fund {', 'entity', 'storage.type.yambl');
  expectScope('entity Fund {', 'Fund', 'entity.name.type.yambl');
  expectScope('extend Security {', 'extend', 'keyword.declaration.yambl');
  expectScope('extend Security {', 'Security', 'entity.name.type.yambl');
  expectScope('entity Bond inherits Security {', 'inherits', 'keyword.declaration.yambl');
  expectScope('entity Bond inherits Security {', 'Security', 'entity.name.type.yambl');
  expectScope('scd attr notional: decimal', 'scd', 'keyword.declaration.yambl');
  expectScope('config attr days: integer = 20', 'config', 'keyword.declaration.yambl');
  expectScope('config attr days: integer = 20', '=', 'keyword.operator.assignment.yambl');
  expectScope('config attr estimate: float = 1.2e-3', '1.2e-3', 'constant.numeric.yambl');
  expectScope('config attr active: bool = true', 'true', 'constant.language.yambl');
  expectScope('NOT_DEFINED', 'NOT_DEFINED', 'constant.language.yambl');
  expectScope("@title('Currency')", '@title', 'entity.name.function.yambl');
  expectScope("@description('Security\\'s # currency')", '# currency', 'string.quoted.single.yambl');
  expectScope("@description('Security\\'s currency')", "\\'", 'constant.character.escape.yambl');
  expectScope("@dimensions(source: code<'PriceSources'>)", '@dimensions', 'entity.name.function.yambl');
  expectScope("@dimensions(source: code<'PriceSources'>)", 'code', 'support.type.yambl');
  expectScope("@dimensions(source: code<'PriceSources'>)", 'PriceSources', 'string.quoted.single.yambl');
  expectScope('decodes Currencies {', 'decodes', 'keyword.declaration.yambl');
  expectScope('decodes Currencies {', 'Currencies', 'entity.name.constant.yambl');
  expectScope("    - 100 CNY: 'CNY'", '100', 'constant.numeric.yambl');
  expectScope("    - 100 CNY: 'CNY'", 'CNY:', 'constant.other.yambl');
  expectScope("    - 100 CNY: 'CNY'", "'CNY'", 'string.quoted.single.yambl');
  expectScope("    - 100 CNY: 'C#NY'  # label", '#NY', 'string.quoted.single.yambl');
  expectScope("    - 100 CNY: 'C#NY'  # label", '# label', 'comment.line.number-sign.yambl');
  expectScope('attr currency: code<Currencies>', 'code<', 'support.type.yambl');
  expectScope('attr currency: code<Currencies>', 'Currencies', 'entity.name.constant.yambl');
  expectScope('attr currencies: values<code<Currencies>>', 'code<', 'support.type.yambl');
  expectScope('attr code: string', 'code:', 'variable.other.property.yambl');
  expectScope('Currencies.CNY', 'Currencies', 'entity.name.constant.yambl');
  expectScope('Currencies.CNY', '.', 'punctuation.accessor.yambl');
  expectScope('Currencies.CNY', 'CNY', 'constant.other.yambl');
  expectScope('attr dictionary: Decodes', 'Decodes', 'entity.name.type.yambl');
  expectScope("'Currencies.CNY'", 'Currencies', 'string.quoted.single.yambl');
  expectScope('# Currencies.CNY', 'Currencies', 'comment.line.number-sign.yambl');
  expectScope('@temporal(as_of_date: date)', '@temporal', 'entity.name.function.yambl');
  expectScope('@temporal(as_of_date: date)', 'as_of_date', 'variable.other.property.yambl');
  expectScope('snapshot attr holdings: collection<HoldingEntry>', 'snapshot', 'keyword.declaration.yambl');
  expectScope('snapshot attr holdings: collection<HoldingEntry>', 'HoldingEntry', 'entity.name.type.yambl');
  for (const type of ['bool', 'string', 'integer', 'float', 'decimal', 'date', 'datetime', 'snowflake_id', 'collection', 'values', 'map']) {
    expectScope(`attr field: ${type}`, type, 'support.type.yambl');
  }
  expectScope('attr weights: map<Security, decimal[precision: 18, scale: 4]>', 'precision', 'variable.parameter.yambl');
  expectScope('attr weights: map<Security, decimal[precision: 18, scale: 4]>', '18', 'constant.numeric.yambl');
  expectScope('attr labels: values<string>', '<', 'punctuation.section.yambl');
  expectScope('#comment without a space', '#', 'comment.line.number-sign.yambl');
  expectScope('attr amount: decimal#comment', '#', 'comment.line.number-sign.yambl');
  expectScope("attr code: string[regex: '[A-Z#]+']  # actual comment", '#]+', 'string.quoted.single.yambl');
  expectScope("attr code: string[regex: '[A-Z#]+']  # actual comment", '# actual', 'comment.line.number-sign.yambl');
  expectScope("attr code: string['it\\'s#text']  # end", '#text', 'string.quoted.single.yambl');
  const unfinished = grammar.tokenizeLine("attr code: string['unfinished", textmate.INITIAL);
  const nextLine = grammar.tokenizeLine('entity Fund {', unfinished.ruleStack);
  assert.ok(nextLine.tokens.some(token => token.scopes.includes('storage.type.yambl')));
  checks++;
  registry.dispose();
  console.log(`Passed ${checks} TextMate highlighting checks using VS Code's bundled engine.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
