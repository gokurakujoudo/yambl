'use strict';

const snake = name => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name);

function checkLookups(documents, symbols, issue) {
  const entities = [...symbols.values()].filter(d => d.kind === 'entity');
  for (const entity of entities) entity.ownLookups = new Map();
  for (const doc of documents.filter(d => !d.errors.length)) for (const declaration of doc.declarations) {
    const owner = doc.scope.get(declaration.name.value);
    for (const lookup of declaration.lookups || []) {
      doc.bindings.set(lookup.name.start, lookup);
      if (!snake(lookup.name.value)) issue(doc, lookup.name, 'lookup names must use snake_case');
      if (!lookup.keys.length) issue(doc, lookup.token, 'lookup requires at least one key');
      const keys = new Set();
      for (const key of lookup.keys) {
        doc.bindings.set(key.name.start, key);
        if (!snake(key.name.value)) issue(doc, key.name, 'lookup key names must use snake_case');
        if (keys.has(key.name.value)) issue(doc, key.name, `duplicate lookup key: ${key.name.value}`);
        keys.add(key.name.value);
      }
      if (owner?.kind !== 'entity') continue;
      lookup.entity = owner;
      if (owner.ownLookups.has(lookup.name.value)) issue(doc, lookup.name, `duplicate lookup declaration: ${lookup.name.value}`);
      else owner.ownLookups.set(lookup.name.value, lookup);
    }
  }
  for (const entity of entities) {
    entity.effectiveLookups = new Map();
    for (const ancestor of [...entity.ancestors].reverse()) for (const [name, lookup] of ancestor.ownLookups) entity.effectiveLookups.set(name, lookup);
    for (const [name, lookup] of entity.ownLookups) {
      if (entity.effectiveLookups.has(name)) issue(lookup.doc, lookup.name, `lookup redeclares inherited rule: ${name}`);
      entity.effectiveLookups.set(name, lookup);
    }
  }
}

module.exports = { checkLookups };
