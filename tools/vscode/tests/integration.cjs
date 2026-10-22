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
    assert.ok(formatted.includes('attr dynamic: code<Missing>'));
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
    assert.ok(styled.includes('decimal')); assert.ok(styled.includes('Missing'));
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
    fs.writeFileSync(output, JSON.stringify({ ok: true, features: ['activation', 'completion', 'definition', 'complete attribute hover', 'formatting', 'symbols', 'dynamic Decodes diagnostics', 'semantic styling', 'declaration references peek', 'unsaved changes'] }));
  } catch (error) {
    fs.writeFileSync(output, JSON.stringify({ ok: false, error: error.stack })); throw error;
  }
}
module.exports = { run };
