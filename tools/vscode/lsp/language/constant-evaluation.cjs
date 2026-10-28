'use strict';

const { signatures } = require('./conversions.cjs');

// Constant numbers retain integer ratios until an explicitly floating operation.
class Ratio {
  constructor(n, d = 1n) { if (!d) throw Error('Fraction(1, 0)'); if (d < 0n) { n = -n; d = -d; } const gcd = (a, b) => b ? gcd(b, a % b) : a; const g = gcd(n < 0n ? -n : n, d); this.n = n / g; this.d = d / g; }
  static text(text) {
    if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)) throw Error('invalid decimal text');
    const [mantissa, exponent = '0'] = text.toLowerCase().split('e'), decimals = mantissa.split('.')[1]?.length || 0, scale = Number(exponent) - decimals;
    const n = BigInt(mantissa.replace('.', ''));
    return scale >= 0 ? new Ratio(n * 10n ** BigInt(scale)) : new Ratio(n, 10n ** BigInt(-scale));
  }
  static float(value) {
    if (!Number.isFinite(value)) throw Error('nonfinite numeric conversion');
    if (value === 0) return new Ratio(0n);
    const bytes = new DataView(new ArrayBuffer(8)); bytes.setFloat64(0, value); const bits = bytes.getBigUint64(0);
    const exponent = Number((bits >> 52n) & 2047n), fraction = bits & ((1n << 52n) - 1n);
    const n = (bits >> 63n ? -1n : 1n) * (fraction + (exponent ? 1n << 52n : 0n)), power = (exponent || 1) - 1075;
    return power >= 0 ? new Ratio(n << BigInt(power)) : new Ratio(n, 1n << BigInt(-power));
  }
  float() {
    let result = Number(this.n) / Number(this.d);
    if (Number.isNaN(result)) { const a = this.n.toString(), b = this.d.toString(); result = Number(a.slice(0, 16)) / Number(b.slice(0, 16)) * 10 ** (a.length - b.length); }
    if (!Number.isFinite(result)) throw Error('nonfinite floating-point calculation');
    return result;
  }
  text() {
    if (this.d === 1n) return this.n.toString();
    let d = this.d, twos = 0, fives = 0;
    while (d % 2n === 0n) { d /= 2n; twos++; }
    while (d % 5n === 0n) { d /= 5n; fives++; }
    if (d !== 1n) throw Error('nonterminating decimal constant');
    const scale = Math.max(twos, fives), n = this.n * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives), negative = n < 0n;
    const digits = (negative ? -n : n).toString().padStart(scale + 1, '0');
    return (negative ? '-' : '') + digits.slice(0, -scale) + '.' + digits.slice(-scale);
  }
}
const numeric = value => value instanceof Ratio ? value : typeof value === 'number' ? Ratio.float(value) : typeof value === 'string' ? Ratio.text(value) : (() => { throw Error('conversion requires a number or numeric string'); })();
const truth = value => value instanceof Ratio ? value.n !== 0n : Boolean(value);
function conversion(name, args) {
  const value = args[0];
  if (name === 'to_string') return value instanceof Ratio ? value.text() : typeof value === 'object' ? value.iso : String(value);
  if (name === 'parse_date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('parse_date requires YYYY-MM-DD');
    const parsed = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value || value.startsWith('0000')) throw Error('invalid ISO calendar date');
    return { iso: value, kind: 'date' };
  }
  if (name === 'format_date') return value.iso;
  if (name === 'parse_datetime') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw Error('parse_datetime requires ISO datetime with explicit timezone');
    conversion('parse_date', [value.slice(0, 10)]);
    const parsed = new Date(value); if (!Number.isFinite(+parsed)) throw Error('invalid ISO datetime');
    const fraction = /\.(\d+)/.exec(value)?.[1].padEnd(6, '0') || '';
    return { iso: parsed.toISOString().slice(0, 19) + (fraction && Number(fraction) ? '.' + fraction : '') + 'Z', kind: 'datetime' };
  }
  if (name === 'format_datetime') return value.iso;
  const number = numeric(value);
  if (name === 'to_decimal') return number;
  if (name === 'to_integer') { if (number.d !== 1n) throw Error('to_integer does not truncate; use truncate or round explicitly'); return number; }
  if (name === 'to_float') { const floating = number.float(), exact = Ratio.float(floating); if (exact.n !== number.n || exact.d !== number.d) throw Error('to_float cannot represent this value exactly'); return floating; }
  const scale = numeric(args[1]), mode = name === 'truncate' ? 'toward_zero' : args[2];
  if (scale.d !== 1n || !['half_even', 'half_up', 'floor', 'ceil', 'toward_zero'].includes(mode)) throw Error('scale must be integer and mode must be an explicit rounding mode');
  const unit = 10n ** (scale.n < 0n ? -scale.n : scale.n), n = number.n * (scale.n >= 0n ? unit : 1n), d = number.d * (scale.n < 0n ? unit : 1n);
  const negative = n < 0n, a = negative ? -n : n; let q = a / d; const r = a % d;
  if (r && ((mode === 'floor' && negative) || (mode === 'ceil' && !negative) || (mode === 'half_up' && 2n * r >= d) || (mode === 'half_even' && (2n * r > d || (2n * r === d && q % 2n))))) q++;
  if (negative) q = -q;
  return scale.n >= 0n ? new Ratio(q, unit) : new Ratio(q * unit);
}
function evaluate(node, resolve) {
  const child = n => evaluate(n, resolve);
  if (node.kind === 'string') return node.inferred?.type?.name === 'date' || node.inferred?.type?.name === 'datetime' ? conversion('parse_' + node.inferred.type.name, [node.value]) : node.value;
  if (['integer', 'decimal'].includes(node.kind)) { const value = Ratio.text(node.value); return node.inferred?.type?.name === 'float' ? value.float() : value; }
  if (node.kind === 'bool') return node.value === 'true';
  if (node.kind === 'name') return resolve(node.value);
  if (node.kind === 'member' && node.operands[0].kind === 'name') return resolve(node.operands[0].value + '.' + node.value);
  if (node.kind === 'member' && node.operands[0].kind === 'descriptor' && node.operands[0].value === 'subtypes' && node.operands[0].operands[0].kind === 'name') return resolve(node.operands[0].operands[0].value + '::subtypes.' + node.value);
  if (node.kind === 'sequence') return node.operands.map(child);
  if (node.kind === 'object') { const result = new Map(); for (let i = 0; i < node.operands.length; i += 2) { const key = node.operands[i], value = child(node.operands[i + 1]), actual = key.kind === 'name' ? key.value : child(key); if (result.has(actual)) throw Error('duplicate mapping literal key'); result.set(actual, value); } return result; }
  if (node.kind === 'conditional') return child(node.operands[truth(child(node.operands[0])) ? 1 : 2]);
  if (node.kind === 'unary') { const value = child(node.operands[0]); if (node.value === 'not') return !truth(value); const n = numeric(value); return new Ratio(-n.n, n.d); }
  if (node.kind === 'binary') {
    const a = child(node.operands[0]); if (node.value === 'and') return truth(a) && child(node.operands[1]); if (node.value === 'or') return truth(a) || child(node.operands[1]); const b = child(node.operands[1]);
    if (['==', '!=', '<', '<=', '>', '>='].includes(node.value)) { const x = a instanceof Ratio ? a.n * numeric(b).d : a?.iso || a, y = a instanceof Ratio ? numeric(b).n * a.d : b?.iso || b; return ({ '==': () => x === y, '!=': () => x !== y, '<': () => x < y, '<=': () => x <= y, '>': () => x > y, '>=': () => x >= y })[node.value](); }
    const x = numeric(a), y = numeric(b);
    if (['+', '-', '*'].includes(node.value) && (typeof a === 'number' || typeof b === 'number')) {
      const left = x.float(), right = y.float(), result = node.value === '+' ? left + right : node.value === '-' ? left - right : left * right;
      if (!Number.isFinite(result)) throw Error('nonfinite floating-point calculation'); return result;
    }
    if (node.value === '+') return new Ratio(x.n * y.d + y.n * x.d, x.d * y.d); if (node.value === '-') return new Ratio(x.n * y.d - y.n * x.d, x.d * y.d); if (node.value === '*') return new Ratio(x.n * y.n, x.d * y.d);
    const ratio = new Ratio(x.n * y.d, x.d * y.n); if (node.value === '/') return ratio.float(); if (node.value === '//') return new Ratio(ratio.n / ratio.d - (ratio.n < 0n && ratio.n % ratio.d ? 1n : 0n));
  }
  if (node.kind === 'call' && node.operands[0].kind === 'name') { const name = node.operands[0].value, signature = signatures[name], args = new Map(node.arguments.map((a, i) => [a.name || signature[i][0], child(a.expression)])); return conversion(name, signature.map(([key]) => args.get(key))); }
  throw Error('constant expressions cannot read fields, inputs or non-normal results');
}
module.exports = { evaluate, conversion, Ratio };
