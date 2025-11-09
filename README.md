# Lx Core Prototype

This repository hosts a minimal interpreter and CLI for the proposed Lx language core described in `SPEC.md`. It includes:

- A Peggy-based parser (`grammar/lx.pegjs`) that recognises modules, types, functions, and tests.
- A TypeScript AST, type checker, and interpreter covering the v0.1 core.
- A CLI (`lx`) with `run`, `test`, and `check` commands.
- A worked example under `examples/median.lx`.

## Getting started

```bash
npm install
npm run build
node dist/cli.js test examples/median.lx
```

After `npm install`, the `prepare` script builds the project automatically and generates the parser. To try the CLI without reinstalling, run `npm run build`.

### CLI usage

```
lx run <file.lx> <module.fn> [json-arg ...]
lx test <file.lx>
lx check <file.lx>
```

Arguments to `lx run` are parsed as JSON and converted to interpreter values (numbers, strings, booleans, and arrays).

## Development workflow

- Update `grammar/lx.pegjs` and regen the parser with `npm run gen:parser`.
- The generated parser (`src/parser.generated.js`) is ignored by git; rebuild to regenerate it.
- The TypeScript sources live in `src/` and compile to `dist/` via `npm run build`.

Unit tests are currently expressed in Lx itself via `test` blocks. Running `npm test` rebuilds the compiler and executes the sample tests.
