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
    assert.ok(formatted.includes('attr kind: code<Missing>'));
    assert.ok(formatted.endsWith('\n') && !formatted.endsWith('\n\n'));
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
    assert.equal(symbols[0].name, 'Child');
    // Feature requests flush pending analysis; allow the diagnostic notification to reach VS Code.
    for (let i = 0; i < 30 && !vscode.languages.getDiagnostics(uri).length; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(vscode.languages.getDiagnostics(uri).some(d => d.severity === vscode.DiagnosticSeverity.Warning && d.message.includes('Missing')));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), 'namespace core\nentity Child inherits Base {}\n');
    await vscode.workspace.applyEdit(edit);
    await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(1, 0));
    for (let i = 0; i < 30 && vscode.languages.getDiagnostics(uri).length; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(vscode.languages.getDiagnostics(uri).map(d => d.message), []);
    assert.ok(doc.isDirty, 'Analysis must use unsaved text');
    fs.writeFileSync(output, JSON.stringify({ ok: true, features: ['activation', 'completion', 'definition', 'hover', 'formatting', 'symbols', 'diagnostics', 'unsaved changes'] }));
  } catch (error) {
    fs.writeFileSync(output, JSON.stringify({ ok: false, error: error.stack })); throw error;
  }
}
module.exports = { run };
