'use strict';

const { createHash } = require('node:crypto');
const quote = value => "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
function number(text) {
  if (!/[.eE]/.test(text)) return String(BigInt(text));
  const [, sign, whole, fraction = '', exponent = '0'] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  let digits = whole + fraction, point = whole.length + Number(exponent);
  if (/^0+$/.test(digits)) return '0.0';
  const leading = digits.match(/^0*/)[0].length;
  digits = digits.slice(leading); point -= leading;
  let value = point <= 0 ? '0.' + '0'.repeat(-point) + digits
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
      : digits.slice(0, point) + '.' + digits.slice(point);
  if (value.includes('.')) value = value.replace(/0+$/, '').replace(/\.$/, '');
  return sign + value + (value.includes('.') ? '' : '.0');
}
function literal(value) {
  if (value.kind === 'string') return quote(value.value);
  if (value.kind === 'number') return number(value.value);
  if (value.kind === 'name') return value.value;
  if (value.kind === 'collection') return '[' + value.items.map(literal).join(', ') + ']';
  return '{' + value.items.map(([k, v]) => literal(k) + ': ' + literal(v)).join(', ') + '}';
}
const scope = conditions => 'scope (' + conditions.map(c => c.name.text + (c.end ? ' in [' + literal(c.value) + ', ' + literal(c.end) + ')' : '=' + literal(c.value))).join(', ') + ')';
function rows(header, image, depth) {
  const indent = '    '.repeat(depth);
  return [indent + header + ' (' + image.columns.map(c => c.text).join(', ') + ') {',
    ...image.rows.map(row => indent + '    ' + row.map(literal).join(', ')), indent + '}'];
}
function planLines(plan, depth = 0) {
  const indent = '    '.repeat(depth);
  const lines = [indent + 'plan ' + plan.name.text + ' {', indent + '    version 1'];
  if (plan.model !== null) lines.push(indent + '    model ' + quote(plan.model));
  for (const group of plan.groups) {
    lines.push(indent + '    group ' + group.name.text + ' {');
    for (const op of group.operations) {
      let header = op.kind + ' ' + op.target.text + (op.expect ? ' expect ' + op.expect : '') + (op.owned ? ' owned_data delete_all' : '');
      if (op.scope.length) {
        header += ' ' + scope(op.scope);
        if (op.kind === 'delete') { lines.push(indent + '        ' + header); continue; }
        header += ' columns';
      }
      lines.push(...rows(header, op, depth + 2));
    }
    lines.push(indent + '    }');
  }
  lines.push(indent + '}'); return lines;
}
function semanticDigest(transaction) {
  const lines = ['transaction ' + quote(transaction.id) + ' {', '    version 1', '    time ' + quote(transaction.time)];
  if (transaction.source) lines.push('    source ' + quote(transaction.source));
  lines.push("    digest ''", ...planLines(transaction.plan, 1));
  for (const group of transaction.groups) {
    lines.push('    group ' + group.name.text + ' {');
    for (const change of group.changes) {
      lines.push('        change ' + change.target.text + ' ' + scope(change.scope) + ' {');
      for (const label of ['before', 'after']) for (const image of change[label]) lines.push(...rows(label + ' ' + image.target.text, image, 3));
      lines.push('        }');
    }
    for (const warning of group.warnings) lines.push('        warning ' + quote(warning));
    lines.push('    }');
  }
  lines.push('}');
  return createHash('sha256').update(lines.join('\n') + '\n', 'utf8').digest('hex');
}
module.exports = { semanticDigest, number };
