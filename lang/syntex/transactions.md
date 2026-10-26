# Transaction documents

`.yaplan` describes grouped changes to model data. `.yatran` records the plan and
the business data located before and after execution. Both formats use UTF-8
without a BOM, LF line endings, four-space indentation and one final newline.

## Plans

A plan has a name, format version, model semantic digest and named groups.
Names use ASCII identifiers. Entity and attribute references use fully qualified
model names. The digest identifies the compiled model used to interpret the data.

```text
plan settings {
    version 1
    model 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    group fallback {
        update core.Security (security_id, price_fallback_days) {
            'SEC000000001', 10
            'SEC000000002', 15
        }
    }
}
```

The digest above is illustrative. Executable plans use their model's actual digest.
Group names are unique within a plan. Columns are declared once per operation;
every data row has exactly that many values and occupies one physical line.
Nested collection and object literals stay on the same line as their record.

| Operation | Form |
| --- | --- |
| Insert entities | `insert Entity (id_column, field, ...) { ... }` |
| Update entity fields | `update Entity (id_column, field, ...) { ... }` |
| Delete entities | `delete Entity (id_column) { ... }` |
| Delete entities with owned data | `delete Entity owned_data delete_all (id_column) { ... }` |
| Replace a field scope | `replace Entity.field scope (...) columns (...) { ... }` |
| Delete a field scope | `delete Entity.field scope (...)` |

Scope conditions use `coordinate=value` or `coordinate in [start, end)`.
An interval includes its start and excludes its end. The owner ID is required;
dimension and temporal coordinate names come from the model. A scope has no
duplicate coordinate names. Replacement rows describe its complete target data.

## Data literals

Strings, booleans, numbers, collections and objects use YAMBL notation:

```text
'quoted text'
true
-12345678901234567890.125
['first', 'second']
{code: 'CNY', decode: 'Chinese yuan', ordering: 100}
decodes.Currencies.CNY
```

Numbers retain exact integer or decimal values. Strings decode `\'` and `\\`;
other backslash sequences retain their spelling. `#` starts a comment outside a
string. Symbol references are resolved against the model. Expressions and function
calls are not data literals.

## Transaction records

A transaction envelope contains a UUID, version, UTC `time`, integrity `digest`,
the original `plan` block and result `group` blocks. A rollback also includes the
source transaction UUID in `source`.

Each result group contains `change` blocks and any `warning` strings. A change
names its target and resolved `scope`, followed by `before` and `after` images.
Each image uses a qualified business target, a column list and one record per
line. Multiple images retain related data such as an entity and its owned fields.
An empty image records absence. Result groups refer to groups in the embedded plan.

The SHA-256 digest covers normalized document contents except the digest itself.
Comments, indentation and equivalent decimal spellings do not affect integrity.
Formatting validates integrity and preserves literal spellings, comments and row
order. Business payloads are retained in the transaction file; warning messages
identify conflicts without duplicating those payloads.

## Python document tools

`yambl_compiler.transactions.syntax.parse(text)` returns a typed `Plan` or
`Transaction`. Invalid documents raise `DocumentError`, which includes one-based
line and column coordinates. `format_document(text)` in `transactions.formatting`
validates and formats either document. `dumps(document)` in `transactions.writing`
validates the serialized document before returning it; `seal(transaction)` fills
the integrity digest of a newly constructed record.
