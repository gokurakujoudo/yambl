# YAMBL

YAMBL stands for **Yet Another Model-Based Language**. It is a domain-specific
language for describing business models.

This repository will define the language syntax, semantics, and source formatting
rules. The language specification and examples are pending; this repository
currently contains the project documentation and Git ignore rules.

## Related projects

- [fmc-data-model](https://github.com/gokurakujoudo/fmc-data-model) will use YAMBL
  to describe the data model of a fund management company.
- [yambl-compiler](https://github.com/gokurakujoudo/yambl-compiler) will implement
  the Python parser, syntax checker, formatter, and compiler.

The language definition belongs here. Company-specific models belong in
`fmc-data-model`, and compiler implementation belongs in `yambl-compiler`.
