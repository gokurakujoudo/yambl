# YAMBL language server

This server provides diagnostics, document formatting, completion, hover, definition
lookup, references, semantic coloring, and document symbols for the current YAMBL syntax. It communicates over
stdio using [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
with UTF-8 message bodies and UTF-16 document positions.

The [VS Code extension](../README.md) includes all server files and starts
the server with VS Code's own Node runtime. Users do not need Python, a separate
Node installation, npm packages, another extension, or a network connection.
There are no runtime downloads or external service calls.

The seven result constants `NOT_DEFINED`, `NOT_APPLICABLE`, `EMPTY`, `NO_ENTRY`,
`NO_DATA`, `ENTITY_NOT_FOUND`, and `ERROR` share their definitions with Python in
`lang/builtins/result-constants.json`. Completion identifies them as constants;
hover explains each result. Their declaration names are reserved, and using them
in field defaults produces diagnostics. Calculation expressions support native
results, lazy recover branches and Partial values.

## Model checking

The server reads the nearest `yambl-root.lclcfg` as a root marker and checks YAMBL
files under that root. It reads one static literal `prefix` and resolves file namespaces
and imports relative to it. Nested repositories, duplicate keys and expressions
produce errors at the configuration file. Without a marker,
it checks only the open document, matching the Python CLI's single-file behavior.
Hidden directories, virtual environments, build output, `node_modules`, and symbolic
links encountered during scans are skipped. Separate roots have separate symbol tables.

Unsaved editor buffers replace their disk versions during analysis. Opening,
editing, saving, closing, and changes to watched files update diagnostics. Changes
are coalesced over 120 ms. Closing a buffer restores its disk contents for other
open documents in the same compilation unit.

Checks cover namespace imports, types, metadata, configuration literals, dimensions,
structured values, containment cycles, entity extensions, final restrictions, overload/override contracts, dependent field
mappings, inherited field conflicts, and inheritance cycles. Unresolved bare Decodes
names are errors. Quoted external dictionaries are allowed without editor diagnostics. Missing explicit imports
and unknown entity types remain errors. The Python CLI still reports external
dictionary dependencies as warnings; the editor suppresses only those warnings.
Extension fields belong to their
target entity and retain their original definition locations and scopes.

Formatting preserves comments and string spelling and ends with exactly one LF.
A document with a syntax error produces no formatting edits. Completion offers
built-ins and names visible in the current file. Hover and completion describe
built-in types. Signature help explains the arguments of `decimal[...]`,
`string[...]`, and generic types; completion offers named parameters and visible
names appropriate to the generic argument. Definition lookup follows imports,
entity references, inheritance, extension targets, and defined Decodes names,
including quoted identifiers. External Decodes have no definition to navigate to.
On an `@overload` marker, definition lookup returns the other branch implementations.
On `@override`, it returns the nearest inherited declaration. Invalid field contracts
produce no marker navigation. `self.field` selects a field descriptor; `::type`
and `::value` access its type and instance value. Completion after `self.` lists
effective fields, including inherited and extended ones. Nested instance paths
also offer field navigation and completion.
The outline shows extension attributes as `Entity.field`, without adding an entity.

Attribute hover includes its full type, including generic arguments and named or
positional parameters, plus `title` and `description` when present. Escaped string
quotes are displayed as quotes. Decodes names use the same semantic token and
TextMate scope as built-in value types, including declarations, imports, and unquoted
code arguments such as `code<Currencies>`. Quoted arguments such as
`code<'PriceSources'>` retain string coloring, whether the dictionary is defined or external.

Ctrl+Click or F12 on a Decodes declaration opens Peek References. Clicking a use
still goes to its declaration. The reference list covers the compilation unit,
including imports, nested code types, and dimensions; it uses resolved symbol
identity so equal names in other namespaces or roots stay separate. Unsaved changes
update the list. The extension sets YAMBL's default alternative-definition command
to `editor.action.referenceSearch.trigger`; a user override of that setting takes
precedence. Find All References is also available.

## Implementation and tests

`language/` contains the parser, formatter, and validator. `service.cjs` handles
source discovery and editor features. `protocol.cjs` frames JSON-RPC messages, and
`server.cjs` implements the LSP lifecycle and document synchronization. The VS Code
client uses native [language feature providers](https://code.visualstudio.com/api/references/vscode-api)
and shares the framing implementation.

Run the offline tests with VS Code's runtime from the `yambl` repository:

```powershell
.\tools\vscode\test.ps1
```

For development with Node installed, the server can also run as `node tools/vscode/lsp/server.cjs`.
Its stdin/stdout are protocol streams, not an interactive command prompt. Cross-check
the JavaScript implementation against the sibling Python compiler:

```console
node tools/vscode/lsp/tests/parity.cjs
```

The parity check uses the compiler's existing venv, or a Python executable supplied
as its first argument. It compares syntax acceptance, core diagnostics before the
editor's dynamic-Decodes filter, and formatted
output for the regression corpus and current model files. Python is a development
test dependency only. New keywords must be added to both implementations and the
TextMate grammar; the vocabulary tests check this link.

The editor implementation is separate from the Python compiler so the VSIX can
run by itself. Changes to language rules require updating both and extending the
parity corpus. This is not a stable intermediate representation or a data runtime.

Current limits: local desktop/remote extension hosts with file URIs and untitled
buffers; no browser or virtual filesystem support, rename,
code actions, incremental text edits, or runtime evaluation. The server requests
full document synchronization. It rescans an affected compilation unit rather than
maintaining a dependency cache; large repositories may need indexing later.

Built-in models are read from `yambl/lang` during development and from resources
included in the VSIX after installation. The installed extension needs no source
checkout. Value types receive value-type semantic coloring and support navigation.
Markdown blocks are opaque to language features and retain body whitespace during
formatting. Root-configuration edits, including unsaved changes, refresh diagnostics.

Type definitions (`type ... = ...`), attrs/mapping key bindings, exact constraints,
and dependent `::type` / `::value` paths share the compiler syntax and diagnostics.
The packaged lang tree includes language-defined AttrCats, DecoratorTargets, decorator signatures and field_mapping.

`@flags` dictionaries accept distinct positive single-bit entry masks and provide
`None` and `All` automatically. Codes declared in YAMBL use PascalCase. `+` adds
flags and `-` removes them, left to right; repeated additions or removals have no
further effect. Dictionary member completion includes both generated codes.
Code references navigate to entries; generated members navigate to the dictionary.

## Decorators

The language service resolves `decorator @name(...)` declarations from the current
namespace, imports and bundled built-ins. It checks positional and named values,
caller-defined key/type pairs, defaults, repetition and captured `self` constraints.
Completion after `@` filters visible decorators by their declared `@targets` and
the following definition or attribute category. Before that definition is written,
it offers candidates for the kinds still possible at the current nesting level.
Value attributes use Static; extend bodies use entity attributes. Comments, strings,
dictionary entries and formal parameters do not offer decorator names. Missing or
invalid target contracts are omitted. Imports and unsaved scope changes are respected.
Decorators already used on the same object are omitted unless declared
`@allow_multiple`. Uses both before and after the cursor count; the invocation
whose name is being edited does not. Other fields and enclosing declarations do
not consume that object's decorator choices.
Inside a call, completion offers ordinary parameter names with `=`. Hovers show signatures, defaults, explicit `@targets` scopes and `@allow_multiple`.
Every decorator must declare `@targets`; diagnostics check its target kinds and
attribute categories from the language sources. Target codes, generated All/None
and named arguments complete and navigate to their definitions.
Decorator calls navigate to declarations and named arguments to formal parameters.
Override and overload calls retain their field-relationship navigation.
Relationship cardinalities complete inside `@relationship`. A `@reverse_relationship`
target navigates to its forward field; the language service checks both sides' types,
categories, temporal parameters and dimension identities.
`::entity` selects a concrete field descriptor's declaring entity.

## Computation editing

Hovers retain entity and collection types for local bindings and lambda parameters.
Method hovers show the receiver, result type and operation contract. Completion on
`holdings.` offers sequence methods; completion on `h.` and reference paths offers
resolved fields. Field uses participate in definition navigation and reference search.

`::value(...)` and `::best_available(...)` provide named parameter
completion and signature help. The editor inserts `name=` and preserves snippets.
`input.` lists inferred and explicitly declared inputs, their types and defaults.
`@extra_input_param` supplies optional input declarations and descriptions; `??`
handles omitted inputs.
The formatter preserves multiline lambda bodies and chained recovery calls.

The server is an internal component of `tools/vscode/`. Stored and computed field
calls share `::value(...)`; `::best_available(...)` remains restricted to stored
fields. Old `::at(...)` calls report migration errors. Terminal implicit field
reads are rejected in value contexts, while intermediate scalar-reference paths
remain navigable. Completion after `::` includes call snippets and works before
parentheses have been entered.
