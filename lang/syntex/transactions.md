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

`time` uses `YYYY-MM-DDTHH:MM:SS[.fraction]Z`, with a valid calendar date,
year 0001–9999, hour 00–23 and minute/second 00–59. Fractional seconds are optional.
The writer records UTC; offsets and alternative date separators are not accepted.
Numeric values preserve exact precision within the runtime's integer and Decimal
limits. If expanding a number for an integrity digest exceeds runtime resources,
the document is rejected with a diagnostic.

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

`yambl_compiler.languages.yaplan.syntax.parse(text)` returns a typed `Plan`;
`yambl_compiler.languages.yatran.syntax.parse(text)` returns a verified `Transaction`.
Both use Lark. Their grammars and shared lexical rules live in `grammars/`.
`languages.shared.documents.parse(text)` selects the language from the document
header. Invalid documents raise `languages.shared.syntax.DocumentError`, which
includes one-based line and column coordinates.

`languages.shared.formatting.format_document(text)` validates and formats either
document. `transactions.writing.dumps(document)` validates serialized contents
before returning them; `languages.yatran.writing.seal(transaction)` fills the
integrity digest of a newly constructed record. These module paths are relative
to `yambl_compiler`, or to the generated data package when using its copies.
Generated packages declare both lclang and Lark dependencies, using the versions
declared by the compiler, and include the data-language grammar files.

## Configured data operations

Generated packages expose a model-specific data interface, such as `FmcData`.
`await FmcData.create(config_path)` initializes a new repository;
`await FmcData.open(config_path)` opens an existing one and restores pending
transaction exports. Both reject configuration or model mismatches.

Creation rejects an existing target. It prepares and checks the initial data at a
temporary location in the destination directory, closes its resources, then renames
it to the configured path. An interruption before that rename leaves the target
absent; an interruption afterward leaves a complete repository that can be opened.
An abrupt process exit can leave an unpublished temporary preparation directory.

The `.lclcfg` entry requires `backend: 'sqlite'` or `backend: 'files'` and a
nonempty `path` string. lclang loads and evaluates the configuration. Relative
repository paths resolve from the entry configuration's directory.

`data.read()` creates a consistent typed reader. `data.apply(plan_path)` commits
an entire Plan. `data.rollback(transaction_path, groups=None)` reverses all groups
or the selected names. Both return a transaction ID, managed file path, change
count and conflict warnings. `data.export(id)` republishes a committed transaction
file. Close readers and data interfaces when finished; the data interface also
supports `with`.

Rollback compares typed values using unordered collection and mapping semantics,
including collections nested in ConfigGroup mappings. Reordering those values
does not create a conflict. A conflicting field or scope is skipped with a warning;
other eligible changes commit together, and the new transaction records both the
changes and the skipped conflicts.

Generated packages provide the same operations through lclang workflows:

```sh
python -m fmc_model create -o config sqlite.lclcfg
python -m fmc_model apply -o config sqlite.lclcfg -o source demo.yaplan
python -m fmc_model check-data -o config sqlite.lclcfg
python -m fmc_model rollback -o config sqlite.lclcfg -o source transaction.yatran -o groups "LCL[['prices']]"
```

The backend is selected by the repository configuration. CLI overrides follow
lclang syntax; `LCL[...]` marks an expression, including a list of group names.
`--dryrun` checks configuration and input syntax without committing, recovering
exports or cleaning files. It does not validate a candidate write against stored
data. `check-data --dryrun` performs read-only data validation.

A `publication_pending` result means the data commit succeeded and its `.yatran`
export needs recovery. Opening the repository or starting another write restores
the export. Do not reapply the Plan to recover a committed transaction. Skipped
rollback conflicts are reported as `committed_with_warnings`; the other changes
in that rollback have committed.
