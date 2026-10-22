# YAMBL

YAMBL stands for **Yet Another Model-Based Language**. It is a domain-specific
language for describing business models.

The language is being designed. This repository records confirmed decisions and
proposals for discussion. The companion compiler checks and formats the current
examples, including attribute extensions, final entities, overload/override field
contracts, dependent field mappings, ConfigGroup, and external Decodes.

## Repository structure

- [language/](language/README.md): lexical rules, syntax, source formatting, file
  structure, and model repository structure.
- [builtins/](builtins/README.md): built-in keywords, types, and constants.
- [models/](models/README.md): built-in data models.
- [tools/vscode/](tools/vscode/README.md): VS Code highlighting, language features,
  and local installation scripts.
- [tools/lsp/](tools/lsp/README.md): a self-contained language server included in
  the VS Code extension, with no external runtime or service setup.

Draft examples illustrate proposed notation. Their semantics remain open unless
explicitly marked as confirmed.

## Related projects

- [fmc-data-model](https://github.com/gokurakujoudo/fmc-data-model) uses YAMBL
  to describe the data model of a fund management company.
- [yambl-compiler](https://github.com/gokurakujoudo/yambl-compiler) provides the
  Python parser, static checker, and formatter. A stable intermediate representation
  and target generation are planned.

The language definition belongs here. Company-specific models belong in
`fmc-data-model`, and compiler implementation belongs in `yambl-compiler`.
