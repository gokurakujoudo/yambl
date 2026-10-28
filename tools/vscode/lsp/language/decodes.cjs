'use strict';

const isFlags = declaration => declaration.metadata.some(a => a.name === 'flags');
function codeEntries(declaration) {
  const entries = declaration.entries.map(entry => Object.assign(entry, { name: entry.code, doc: entry.doc || declaration.doc, kind: 'code' }));
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
function deriveSubtypes(symbols, issue) {
  const entities = [...symbols.values()].filter(d => d.kind === 'entity');
  const children = parent => entities.filter(d => d.base === parent).sort((a, b) => a.name.value < b.name.value ? -1 : a.name.value > b.name.value ? 1 : 0);
  for (const owner of entities) {
    const entries = [], codes = new Set(), visited = new Set([owner]);
    function visit(parent, parentOrder) {
      for (const child of children(parent)) {
        if (visited.has(child)) continue;
        visited.add(child);
        const code = child.name.value;
        if (codes.has(code)) issue(child.doc, child.name, `duplicate subtype code: ${code}`);
        codes.add(code);
        const call = child.metadata.find(a => a.name === 'decodes_rank');
        const args = call?.arguments || [];
        const rank = args.find(a => a.key?.value === 'k') || args.find(a => a.mode === 'positional');
        const decode = args.find(a => a.key?.value === 'decode') || args.filter(a => a.mode === 'positional')[1];
        const ordering = rank && /^-?\d+$/.test(rank.type.name) ? parentOrder + BigInt(rank.type.name) : BigInt(entries.length + 1) * 100n;
        const value = decode?.type.quoted ? decode.type.token : { ...child.name, value: "'" + code + "'" };
        entries.push({ token: child.name, code: child.name, value, order: { ...child.name, value: ordering.toString() }, doc: child.doc });
        visit(child, ordering);
      }
    }
    visit(owner, 0n);
    const dictionary = { kind: 'decodes', key: owner.key + '::subtypes', name: { ...owner.name, value: owner.name.value + '::subtypes' }, doc: owner.doc, metadata: [], fields: [], entries, subtypeOwner: owner };
    owner.subtypes = dictionary;
    symbols.set(dictionary.key, dictionary);
  }
}
module.exports = { isFlags, codeEntries, checkDecodes, deriveSubtypes };
