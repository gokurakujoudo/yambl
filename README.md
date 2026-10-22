# YAMBL

YAMBL stands for **Yet Another Model-Based Language**. It is a domain-specific
language for describing business models.

The language is being designed. This repository records confirmed decisions and
proposals for discussion. A parser and executable examples are not available yet.

## Repository structure

- [language/](language/README.md): lexical rules, syntax, source formatting, file
  structure, and model repository structure.
- [builtins/](builtins/README.md): built-in keywords and the type system.
- [models/](models/README.md): built-in data models.

Draft examples illustrate proposed notation. Their semantics remain open unless
explicitly marked as confirmed.

## Related projects

- [fmc-data-model](https://github.com/gokurakujoudo/fmc-data-model) will use YAMBL
  to describe the data model of a fund management company.
- [yambl-compiler](https://github.com/gokurakujoudo/yambl-compiler) will implement
  the Python parser, syntax checker, formatter, and compiler.

The language definition belongs here. Company-specific models belong in
`fmc-data-model`, and compiler implementation belongs in `yambl-compiler`.
