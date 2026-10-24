'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const output = path.join(root, 'result.json');
  try {
    const extension = vscode.extensions.getExtension('gokurakujoudo.yambl');
    assert.ok(extension); await extension.activate();
    assert.ok(fs.existsSync(path.join(extension.extensionPath, 'lsp/server.cjs')), 'Test must run the packaged extension');
    const uri = vscode.Uri.file(path.join(root, 'child.yambl'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(2, 0));
    assert.ok(completions.items.some(item => item.label === 'inherits'));
    const position = new vscode.Position(1, 'entity Child inherits '.length);
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
    assert.ok(definitions.some(item => item.uri.fsPath.endsWith('base.yambl')));
    const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
    assert.ok(hover.length);
    const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', uri, { tabSize: 4, insertSpaces: true });
    assert.ok(edits.length);
    // VS Code can minimize a server's whole-document edit before returning it.
    let formatted = doc.getText();
    for (const edit of [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start))) {
      formatted = formatted.slice(0, doc.offsetAt(edit.range.start)) + edit.newText + formatted.slice(doc.offsetAt(edit.range.end));
    }
    assert.ok(formatted.includes("attr dynamic: code<'Missing'>"));
    assert.ok(formatted.endsWith('\n') && !formatted.endsWith('\n\n'));
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
    assert.equal(symbols[0].name, 'Child');
    const fieldPosition = doc.positionAt(doc.getText().indexOf('kinds:'));
    const fieldHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, fieldPosition);
    const tooltip = fieldHover.flatMap(h => h.contents.map(c => c.value)).join('\n').replaceAll('&nbsp;', ' ');
    assert.ok(tooltip.includes('title: Currencies'), tooltip); assert.ok(tooltip.includes("description: Child's currencies"), tooltip);
    assert.match(tooltip, /values.*code.*Currencies/);
    const priceHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, doc.positionAt(doc.getText().indexOf('price:')));
    assert.match(priceHover[0].contents[0].value.replaceAll('&nbsp;', ' '), /precision: 18, scale: 4/);
    const legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', uri);
    assert.deepEqual(legend.tokenTypes, ['yamblValueType']);
    const semantic = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', uri);
    const styled = []; let semanticLine = 0, semanticCharacter = 0;
    for (let i = 0; i < semantic.data.length; i += 5) {
      semanticCharacter = semantic.data[i] === 0 ? semanticCharacter + semantic.data[i + 1] : semantic.data[i + 1]; semanticLine += semantic.data[i];
      styled.push(doc.lineAt(semanticLine).text.slice(semanticCharacter, semanticCharacter + semantic.data[i + 2]));
      assert.equal(semantic.data[i + 3], 0);
    }
    assert.equal(styled.filter(name => name === 'Currencies').length, 1);
    assert.ok(!styled.includes('PriceSources'));
    assert.ok(styled.includes('decimal')); assert.ok(!styled.includes('Missing'));
    const dictionaryUri = vscode.Uri.file(path.join(root, 'decodes.yambl'));
    const dictionary = await vscode.workspace.openTextDocument(dictionaryUri);
    const declarationPosition = dictionary.positionAt(dictionary.getText().indexOf('Currencies'));
    const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', dictionaryUri, declarationPosition);
    assert.ok(references.some(r => r.uri.toString() === uri.toString()));
    const editor = await vscode.window.showTextDocument(dictionary);
    editor.selection = new vscode.Selection(declarationPosition, declarationPosition);
    assert.equal(vscode.workspace.getConfiguration('editor.gotoLocation', dictionary).get('alternativeDefinitionCommand'), 'editor.action.referenceSearch.trigger');
    let referenceRequests = 0;
    const observer = vscode.languages.registerReferenceProvider({ language: 'yambl' }, { provideReferences() { referenceRequests++; return []; } });
    try {
      // Ctrl+Click and F12 use the definition action. At the declaration it must enter Peek References.
      await vscode.commands.executeCommand('editor.action.revealDefinition');
      for (let i = 0; i < 30 && !referenceRequests; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(referenceRequests > 0, 'Go to Definition on a declaration must request references');
    } finally { observer.dispose(); await vscode.commands.executeCommand('closeReferenceSearch'); }
    await vscode.window.showTextDocument(doc);
    assert.deepEqual(vscode.languages.getDiagnostics(uri).map(d => d.message), []);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), 'namespace core\nentity Child inherits Base {}\n');
    await vscode.workspace.applyEdit(edit);
    await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(1, 0));
    for (let i = 0; i < 30 && vscode.languages.getDiagnostics(uri).length; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(vscode.languages.getDiagnostics(uri).map(d => d.message), []);
    assert.ok(doc.isDirty, 'Analysis must use unsaved text');
    const relationshipText = `namespace relationships
entity Base { config attr days: integer = 20 }
entity A inherits Base { @overload config attr category: integer = 1 @override config attr days: integer = 10 }
entity B inherits Base { @overload config attr category: integer = 2 }
entity C inherits Base { @overload config attr category: integer = 3 }
entity Deep inherits A { @override config attr days: integer = 5 }
final entity Selection { attr chosen: type<Base> attr rules: field_mapping<AttrCats.Config, self.chosen::value> }
`;
    const relationshipsUri = vscode.Uri.file(path.join(root, 'relationships.yambl'));
    fs.writeFileSync(relationshipsUri.fsPath, relationshipText);
    const relationshipsDoc = await vscode.workspace.openTextDocument(relationshipsUri);
    await vscode.window.showTextDocument(relationshipsDoc);
    const lookup = offset => vscode.commands.executeCommand('vscode.executeDefinitionProvider', relationshipsUri, relationshipsDoc.positionAt(offset));
    const overloadTargets = await lookup(relationshipText.indexOf('@overload') + 1);
    assert.deepEqual(overloadTargets.map(x => x.range.start.line).sort(), [3, 4]);
    const overrideTargets = await lookup(relationshipText.lastIndexOf('@override') + 1);
    assert.deepEqual(overrideTargets.map(x => x.range.start.line), [2]);
    const selfTarget = await lookup(relationshipText.lastIndexOf('chosen'));
    assert.equal(selfTarget[0].range.start.character, relationshipText.split('\n')[6].indexOf('chosen'));
    const fieldCompletions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', relationshipsUri, relationshipsDoc.positionAt(relationshipText.lastIndexOf('chosen')));
    assert.ok(fieldCompletions.items.some(item => item.label === 'chosen'));
    assert.deepEqual(vscode.languages.getDiagnostics(relationshipsUri).map(d => d.message), []);
    const broken = new vscode.WorkspaceEdit();
    const mismatch = relationshipText.indexOf('integer = 2');
    broken.replace(relationshipsUri, new vscode.Range(relationshipsDoc.positionAt(mismatch), relationshipsDoc.positionAt(mismatch + 'integer = 2'.length)), "string = 'two'");
    await vscode.workspace.applyEdit(broken);
    const invalidTargets = await lookup(relationshipText.indexOf('@overload') + 1);
    assert.deepEqual(invalidTargets, []);
    assert.ok(relationshipsDoc.isDirty);
    const flagsText = "namespace flags @flags decodes Rights { - 0b01 Read: 'Read' - 2 Write: 'Write' } type selected<a: code<Rights>> = string entity Choice { attr x: selected<Rights.All - Rights.Read + Rights.Write + Rights.None> }";
    const flagsUri = vscode.Uri.file(path.join(root, 'flags.yambl'));
    fs.writeFileSync(flagsUri.fsPath, flagsText);
    const flagsDoc = await vscode.workspace.openTextDocument(flagsUri);
    await vscode.window.showTextDocument(flagsDoc);
    const flagCompletions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', flagsUri, flagsDoc.positionAt(flagsText.lastIndexOf('Write')));
    assert.ok(flagCompletions.items.some(item => item.label === 'None'));
    assert.ok(flagCompletions.items.some(item => item.label === 'All'));
    const flagTargets = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', flagsUri, flagsDoc.positionAt(flagsText.lastIndexOf('Write')));
    assert.equal(flagTargets[0].range.start.character, flagsText.indexOf('Write'));
    const zeroHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', flagsUri, flagsDoc.positionAt(flagsText.lastIndexOf('None')));
    assert.ok(zeroHover[0].contents[0].value.includes(new vscode.MarkdownString().appendText('0 (generated)').value));
    assert.deepEqual(vscode.languages.getDiagnostics(flagsUri).map(d => d.message), []);
    const decoratorText = "namespace metadata @allow_multiple @targets(DecoratorTargets.All) decorator @note(text: string = 'Note') @note(text='Review') entity Annotated {}";
    const decoratorUri = vscode.Uri.file(path.join(root, 'decorators.yambl'));
    fs.writeFileSync(decoratorUri.fsPath, decoratorText);
    const decoratorDoc = await vscode.workspace.openTextDocument(decoratorUri);
    await vscode.window.showTextDocument(decoratorDoc);
    const parameterTargets = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', decoratorUri, decoratorDoc.positionAt(decoratorText.indexOf("text='Review'")));
    assert.equal(parameterTargets[0].range.start.character, decoratorText.indexOf('text: string'));
    const decoratorHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', decoratorUri, decoratorDoc.positionAt(decoratorText.lastIndexOf('@note') + 1));
    assert.ok(decoratorHover[0].contents[0].value.includes(new vscode.MarkdownString().appendText('@allow_multiple').value));
    assert.ok(decoratorHover[0].contents[0].value.includes(new vscode.MarkdownString().appendText('@targets(DecoratorTargets.All)').value));
    const scopeTargets = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', decoratorUri, decoratorDoc.positionAt(decoratorText.indexOf('@targets') + 1));
    assert.match(scopeTargets[0].uri.path, /builtins\/decorators.yambl$/);
    const parameterCompletions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', decoratorUri, decoratorDoc.positionAt(decoratorText.indexOf("text='Review'")));
    assert.ok(parameterCompletions.items.some(item => item.label === 'text'));
    assert.deepEqual(vscode.languages.getDiagnostics(decoratorUri).map(d => d.message), []);
    const constantNames = ['NOT_DEFINED', 'NOT_APPLICABLE', 'EMPTY', 'NO_ENTRY', 'NO_DATA', 'ENTITY_NOT_FOUND', 'ERROR'];
    const constantsUri = vscode.Uri.file(path.join(root, 'result-constants.yambl'));
    const constantsText = 'namespace results entity Result {\n' + constantNames.map((name, i) => `    attr result_${i}: ${name}`).join('\n') + '\n}\n';
    fs.writeFileSync(constantsUri.fsPath, constantsText);
    const constantsDoc = await vscode.workspace.openTextDocument(constantsUri);
    await vscode.window.showTextDocument(constantsDoc);
    const constantsCompletion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', constantsUri, constantsDoc.positionAt(constantsText.indexOf('NOT_DEFINED')));
    for (const name of constantNames) {
      assert.equal(constantsCompletion.items.find(item => item.label === name).kind, vscode.CompletionItemKind.Constant);
      const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', constantsUri, constantsDoc.positionAt(constantsText.indexOf(name)));
      assert.ok(hover[0].contents[0].value.includes(new vscode.MarkdownString().appendText('Result constant').value));
    }
    assert.deepEqual(vscode.languages.getDiagnostics(constantsUri).map(d => d.message).sort(), constantNames.map(name => `result constant ${name} cannot be used in model expressions`).sort());
    const filteredUri = vscode.Uri.file(path.join(root, 'filtered-decorators.yambl'));
    const filteredText = "namespace filtered entity Item { @title('Price') @dimension(source: string) @description snapshot attr price: decimal @title static attr currency: string }";
    fs.writeFileSync(filteredUri.fsPath, filteredText);
    const filteredDoc = await vscode.workspace.openTextDocument(filteredUri);
    await vscode.window.showTextDocument(filteredDoc);
    for (const [offset, temporal, title] of [[filteredText.indexOf('@description'), true, false], [filteredText.lastIndexOf('@title'), false, true]]) {
      const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', filteredUri, filteredDoc.positionAt(offset + 1));
      const labels = result.items.map(item => item.label);
      assert.equal(labels.includes('title'), title);
      assert.ok(labels.includes('description'));
      assert.equal(labels.includes('temporal'), temporal);
      assert.equal(labels.includes('dimension'), temporal);
      assert.ok(!labels.includes('flags') && !labels.includes('targets') && !labels.includes('allow_multiple'));
    }
    fs.writeFileSync(output, JSON.stringify({ ok: true, features: ['activation', 'completion', 'definition', 'complete attribute hover', 'formatting', 'symbols', 'dynamic Decodes diagnostics', 'semantic styling', 'declaration references peek', 'unsaved changes', 'overload multiple locations', 'nearest override navigation', 'arbitrary self field navigation and completion', 'invalid unsaved marker suppression', 'flags union and generated None', 'decorator signatures and named parameter navigation/completion'] }));
  } catch (error) {
    fs.writeFileSync(output, JSON.stringify({ ok: false, error: error.stack })); throw error;
  }
}
module.exports = { run };
