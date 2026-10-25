'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const rootName = 'yambl-root.lclcfg';
function configError(filename, line, message) {
  return Object.assign(new Error(message), { uri: pathToFileURL(filename).href, line });
}
function readPrefix(filename, text) {
  if (text === undefined) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filename)); }
    catch (error) { throw configError(filename, 0, `Cannot read root configuration: ${error.message}`); }
  }
  let prefix;
  const lines = text.replace(/^\ufeff/, '').split(/\r?\n/);
  for (const [line, content] of lines.entries()) {
    if (!content.trim() || content.trimStart().startsWith('#')) continue;
    const match = /^\s*prefix\s*:\s*(['"])([A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*|)\1\s*(?:#.*)?$/.exec(content);
    if (!match || prefix !== undefined) throw configError(filename, line, 'expected one literal prefix declaration');
    prefix = match[2];
  }
  if (prefix === undefined) throw configError(filename, 0, 'missing prefix declaration');
  return prefix;
}
function sources(root, boundary = root) {
  const result = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.isSymbolicLink() || item.name.startsWith('.') || ['venv', '.venv', 'env', 'build', 'dist', '__pycache__', 'node_modules'].includes(item.name)) continue;
    const full = path.join(root, item.name);
    if (item.name === rootName && root !== boundary) throw configError(full, 0, 'nested or multiple model repositories are unsupported');
    if (item.isDirectory()) result.push(...sources(full, boundary));
    else if (item.isFile() && item.name.endsWith('.yambl')) result.push(full);
  }
  return result.sort();
}
module.exports = { readPrefix, sources, rootName, configError };
