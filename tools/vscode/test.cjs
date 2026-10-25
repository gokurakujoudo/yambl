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

  expectScope('@flags', '@flags', 'entity.name.function.yambl');
  for (const name of ['sparse', 'dense']) {
    expectScope(`@${name}(cat='bond_info')`, '@' + name, 'entity.name.function.yambl');
    expectScope(`@${name}(cat='bond_info')`, 'cat', 'variable.parameter.yambl');
    expectScope(`@${name}(cat='bond_info')`, 'bond_info', 'string.quoted.single.yambl');
  }
  expectScope('@targets(DecoratorTargets.EntityAttr, categories=AttrCats.Snapshot + AttrCats.Scd)', '@targets', 'entity.name.function.yambl');
  expectScope('@targets(DecoratorTargets.EntityAttr)', 'DecoratorTargets', 'support.type.yambl');
  expectScope('@targets(DecoratorTargets.EntityAttr)', 'EntityAttr', 'constant.other.yambl');
  expectScope('@targets(DecoratorTargets.All - DecoratorTargets.Id)', 'All', 'constant.other.yambl');
  expectScope('@targets(DecoratorTargets.All - DecoratorTargets.Id)', '-', 'keyword.operator.bitwise.yambl');
  expectScope('@targets(DecoratorTargets.None)', 'None', 'constant.other.yambl');
  expectScope('@targets(DecoratorTargets.EntityAttr, categories=AttrCats.Snapshot)', 'categories', 'variable.parameter.yambl');
  expectScope('decorator @tag(text: string)', 'decorator', 'keyword.declaration.yambl');
  expectScope('decorator @tag(text: string)', '@tag', 'entity.name.function.yambl');
  expectScope('@allow_multiple', '@allow_multiple', 'entity.name.function.yambl');
  expectScope('decorator @tag(*source?: string)', '*', 'keyword.operator.yambl');
  expectScope('decorator @tag(*source?: string)', '?', 'keyword.operator.yambl');
  expectScope('decorator @tag(*source?: string)', 'source', 'variable.other.property.yambl');
  expectScope("@tag(text='Name')", 'text', 'variable.parameter.yambl');
  expectScope('type<self::entity>', 'entity', 'variable.language.yambl');
  expectScope("    - 0b00001 Attr: 'Attribute'", '0b00001', 'constant.numeric.yambl');
  expectScope("    - 0b00001 Attr: 'Attribute'", 'Attr', 'constant.other.yambl');
  expectScope('attrs<AttrCats.Static+AttrCats.Config, Entity>', '+', 'keyword.operator.bitwise.yambl');
  expectScope('attrs<AttrCats.None, Entity>', 'None', 'constant.other.yambl');
  expectScope('attrs<AttrCats.All-AttrCats.Snapshot, Entity>', 'All', 'constant.other.yambl');
  expectScope('attrs<AttrCats.All-AttrCats.Snapshot, Entity>', '-', 'keyword.operator.bitwise.yambl');
  expectScope('attrs<AttrCats.Static+AttrCats.Config, Entity>', 'Config', 'constant.other.yambl');

  expectScope('attr x: Attr::type', '::', 'punctuation.accessor.yambl');
  expectScope('attr x: Attr::type', 'type', 'variable.language.yambl');
  expectScope('attr x: self.kind::value', 'value', 'variable.language.yambl');
  expectScope('type selected<t: type<Entity>> = t', 'selected', 'support.type.yambl');
  expectScope('value quote {', 'value', 'storage.type.yambl');
  expectScope('value quote {', 'quote', 'support.type.yambl');
  expectScope('@dimension(source: string, preference: Hierarchy)', 'Hierarchy', 'entity.name.type.yambl');
  let markdownState = grammar.tokenizeLine('---', textmate.INITIAL).ruleStack;
  for (const line of ['# Heading', "value fake { attr a: 'literal' }", '']) {
    const result = grammar.tokenizeLine(line, markdownState);
    assert.ok(result.tokens.every(t => t.scopes.includes('comment.block.documentation.yambl')));
    markdownState = result.ruleStack; checks++;
  }
  markdownState = grammar.tokenizeLine('---', markdownState).ruleStack;
  assert.ok(grammar.tokenizeLine('value real {', markdownState).tokens.some(t => t.scopes.includes('storage.type.yambl'))); checks++;

  // A new language-server keyword must also have a TextMate scope in this release.
  const vocabulary = require('../lsp/language/syntax.cjs');
  for (const keyword of vocabulary.keywords) {
    const scope = ['entity', 'type'].includes(keyword) ? 'storage.type.yambl'
      : ['namespace', 'from', 'import', 'let', 'return', 'if', 'then', 'else', 'case', 'and', 'or', 'not'].includes(keyword) ? 'keyword.control.yambl' : 'keyword.declaration.yambl';
    const line = keyword === 'namespace' ? 'namespace core' : keyword === 'type' ? 'type example = string' : `${keyword} Thing`;
    expectScope(line, keyword, scope);
  }
  for (const annotation of vocabulary.annotations) expectScope(`@${annotation}('x')`, '@' + annotation, 'entity.name.function.yambl');
  for (const constant of vocabulary.constants) expectScope(constant, constant, 'constant.language.yambl');
  for (const constant of Object.keys(vocabulary.resultConstants)) {
    expectScope(`@title(${constant})`, constant, 'constant.language.yambl');
    expectScope(`@title('${constant}')`, constant, 'string.quoted.single.yambl');
    expectScope(`# ${constant}`, constant, 'comment.line.number-sign.yambl');
  }
  expectScope('Codes.ERROR', 'ERROR', 'constant.other.yambl');
  for (const type of [...vocabulary.values, ...vocabulary.generics]) {
    expectScope(`attr field: ${type}${vocabulary.generics.includes(type) ? '<Thing>' : ''}`, type, 'support.type.yambl');
  }

  expectScope('namespace core', 'core', 'entity.name.namespace.yambl');
  expectScope('final entity ConfigGroup {', 'final', 'keyword.declaration.yambl');
  expectScope('final entity ConfigGroup {', 'ConfigGroup', 'entity.name.type.yambl');
  expectScope('static attr selected: type<Entity>', 'static', 'keyword.declaration.yambl');
  expectScope('static attr selected: type<Entity>', 'type', 'support.type.yambl');
  expectScope('static attr selected: type<Entity>', 'Entity', 'entity.name.type.yambl');
  expectScope('attr when: field_mapping<AttrCats.Static, self.selected::value>', 'field_mapping', 'support.type.yambl');
  expectScope('attr when: field_mapping<AttrCats.Static, self.selected::value>', 'self', 'keyword.declaration.yambl');
  expectScope('@overload', '@overload', 'entity.name.function.yambl');
  expectScope('@override', '@override', 'entity.name.function.yambl');
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
  expectScope("@dimension(source: code<'PriceSources'>)", '@dimension', 'entity.name.function.yambl');
  expectScope("@dimension(source: code<'PriceSources'>)", 'code', 'support.type.yambl');
  expectScope("@dimension(source: code<'PriceSources'>)", 'PriceSources', 'string.quoted.single.yambl');
  expectScope("attr currency: code<'Currencies'>", "'Currencies'", 'string.quoted.single.yambl');
  expectScope("attr currency: code<'Currencies'>", 'Currencies', 'string.quoted.single.yambl');
  expectScope("attr codes: values<code<'Currencies'>>", 'Currencies', 'string.quoted.single.yambl');
  expectScope('attr source: code<PriceSources>', 'PriceSources', 'support.type.yambl');
  expectScope('decodes Currencies {', 'decodes', 'keyword.declaration.yambl');
  expectScope('decodes Currencies {', 'Currencies', 'support.type.yambl');
  expectScope("    - 100 CNY: 'CNY'", '100', 'constant.numeric.yambl');
  expectScope("    - 100 CNY: 'CNY'", 'CNY:', 'constant.other.yambl');
  expectScope("    - 100 CNY: 'CNY'", "'CNY'", 'string.quoted.single.yambl');
  expectScope("    - 100 CNY: 'C#NY'  # label", '#NY', 'string.quoted.single.yambl');
  expectScope("    - 100 CNY: 'C#NY'  # label", '# label', 'comment.line.number-sign.yambl');
  expectScope('attr currency: code<Currencies>', 'code<', 'support.type.yambl');
  expectScope('attr currency: code<Currencies>', 'Currencies', 'support.type.yambl');
  expectScope('attr currencies: values<code<Currencies>>', 'code<', 'support.type.yambl');
  expectScope('attr code: string', 'code:', 'variable.other.property.yambl');
  expectScope('Currencies.CNY', 'Currencies', 'support.type.yambl');
  expectScope('Currencies.CNY', '.', 'punctuation.accessor.yambl');
  expectScope('Currencies.CNY', 'CNY', 'constant.other.yambl');
  expectScope('attr dictionary: Decodes', 'Decodes', 'entity.name.type.yambl');
  expectScope("'Currencies.CNY'", 'Currencies', 'string.quoted.single.yambl');
  expectScope('# Currencies.CNY', 'Currencies', 'comment.line.number-sign.yambl');
  expectScope('@temporal(as_of_date: date)', '@temporal', 'entity.name.function.yambl');
  expectScope('@temporal(as_of_date: date)', 'as_of_date', 'variable.other.property.yambl');
  expectScope('snapshot attr holdings: collection<HoldingEntry>', 'snapshot', 'keyword.declaration.yambl');
  for (const word of ['computed', 'dimension', 'hierarchy', 'fallback_days', 'let', 'return', 'if', 'then', 'else', 'case', 'and', 'or', 'not']) {
    expectScope(word, word, ['computed', 'dimension', 'hierarchy', 'fallback_days'].includes(word) ? 'keyword.declaration.yambl' : 'keyword.control.yambl');
  }
  expectScope('case PARTIAL as p -> p.value', 'PARTIAL', 'constant.language.yambl');
  for (const line of ['h -> h.security', 'case EMPTY -> 0', 'input.day ?? input.as_of_date']) {
    const operator = line.includes('->') ? '->' : '??';
    const index = line.indexOf(operator);
    const token = grammar.tokenizeLine(line, textmate.INITIAL).tokens.find(t => t.startIndex === index);
    assert.equal(token.endIndex, index + 2, 'multi-character operator must be one token');
    assert.ok(token.scopes.includes('keyword.operator.yambl'));
    checks++;
  }
  expectScope("value price_source: code<'PriceSources'>", 'price_source', 'variable.other.property.yambl');
  expectScope("hierarchy price_hierarchy: Hierarchy = 'LocalHierarchy'", 'price_hierarchy', 'variable.other.property.yambl');
  expectScope('decorator @extra_input_params(*parameter: input_type)', 'input_type', 'support.type.yambl');
  expectScope('self.price::best_available()', '::', 'punctuation.accessor.yambl');
  expectScope('snapshot attr holdings: collection<HoldingEntry>', 'HoldingEntry', 'entity.name.type.yambl');
  for (const type of ['bool', 'string', 'integer', 'float', 'decimal', 'date', 'datetime', 'snowflake_id', 'collection', 'values', 'mapping']) {
    expectScope(`attr field: ${type}`, type, 'support.type.yambl');
  }
  expectScope('attr weights: mapping<Security, decimal[precision: 18, scale: 4]>', 'precision', 'variable.parameter.yambl');
  expectScope('attr weights: mapping<Security, decimal[precision: 18, scale: 4]>', '18', 'constant.numeric.yambl');
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
  expectScope('@dimension(source: string) static attr value: string', 'static', 'keyword.declaration.yambl');
  expectScope('AttrCats.Static + AttrCats.Config', 'Static', 'constant.other.yambl');
  registry.dispose();
  console.log(`Passed ${checks} TextMate highlighting checks using VS Code's bundled engine.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
