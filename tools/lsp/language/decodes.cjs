'use strict';

const isFlags = declaration => declaration.metadata.some(a => a.name === 'flags');
function codeEntries(declaration) {
  const entries = declaration.entries.map(entry => Object.assign(entry, { name: entry.code, doc: declaration.doc, kind: 'code' }));
  if (!isFlags(declaration)) return entries;
  // A generated member navigates to its owning dictionary.
  declaration.generatedEntries ||= ['None', 'All'].map(value => ({ name: { ...declaration.name, value }, doc: declaration.doc, kind: 'code', generated: true }));
  return [...entries, ...declaration.generatedEntries];
}
function checkDecodes(declaration, issue) {
  const doc = declaration.doc, markers = declaration.metadata.filter(a => a.name === 'flags');
  if (markers.length > 1) issue(doc, markers.at(-1).token, 'duplicate flags annotation');
  const codes = new Set(), masks = new Set();
  for (const entry of declaration.entries) {
    const code = entry.code.value;
    if (!/^[A-Z][A-Za-z0-9]*$/.test(code)) issue(doc, entry.token, 'Decodes codes must use PascalCase');
    if (codes.has(code)) issue(doc, entry.token, `duplicate code in Decodes: ${code}`);
    codes.add(code);
    if (markers.length) {
      if (['None', 'All'].includes(code)) issue(doc, entry.token, `flags code ${code} is generated automatically`);
      const text = entry.order.value, mask = text.startsWith('-') ? -BigInt(text.slice(1)) : BigInt(text);
      if (mask <= 0n || (mask & (mask - 1n))) issue(doc, entry.token, 'flags entries require a positive single-bit mask');
      if (masks.has(mask)) issue(doc, entry.token, 'duplicate flags mask');
      masks.add(mask);
    }
  }
}
module.exports = { isFlags, codeEntries, checkDecodes };
