'use strict';

// Pure scalar conversion signatures; numeric execution belongs to the Python runtime.
const signatures = {
  to_string: [['value', 'scalar']],
  to_integer: [['value', 'number_or_string']],
  to_decimal: [['value', 'number_or_string']],
  to_float: [['value', 'number_or_string']],
  parse_date: [['text', 'string']], format_date: [['value', 'date']],
  parse_datetime: [['text', 'string']], format_datetime: [['value', 'datetime']],
  truncate: [['value', 'number'], ['scale', 'integer']],
  round: [['value', 'number'], ['scale', 'integer'], ['mode', 'string']],
};
const returns = { to_string: 'string', to_integer: 'integer', to_decimal: 'decimal', to_float: 'float', parse_date: 'date', format_date: 'string', parse_datetime: 'datetime', format_datetime: 'string', truncate: 'decimal', round: 'decimal' };
module.exports = { signatures, returns };
