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
lx run [--format=json|text] [--input=source|ast] <file> <module.fn> [args...]
lx test [--format=json|text] [--input=source|ast] <file>
lx check [--format=json|text] [--input=source|ast] <file>
lx format <file.lx>
lx explain [--format=json|text] [--input=source|ast] <file> <module.fn> [args...]
```

Arguments to `lx run` and `lx explain` are parsed as JSON and converted to interpreter values (numbers, strings, booleans, and arrays).

**Structured output:** Use `--format=json` to get machine-readable JSON output (errors, logs, results) suitable for LLM consumption. Default is `--format=text` for human-readable output.

**AST input:** Use `--input=ast` to treat the file as JSON that already matches the Lx AST schema. This lets LLMs emit structured modules that can be executed directly without going through the parser. See `examples/ast_demo.json` for a complete sample.

**Holes:** Use `hole("label")` inside an expression to mark unfinished code. The typechecker reports any remaining holes (with their labels and locations) so you can commit partial work safely.

**LLM-friendly tools:**
- `lx format` - Produces deterministic, canonical formatting from AST
- `lx explain` - Shows step-by-step execution trace with function calls, returns, and variable bindings

Examples:
```bash
# Run with JSON output
lx run --format=json examples/structured_output.lx examples.structured_output.compute 5

# Check for type errors with structured output
lx check --format=json examples/error_example.lx

# Format code canonically
lx format examples/median.lx

# Explain execution with trace
lx explain examples/median.lx median '[2,4,6,8]'

# Get execution trace as JSON
lx explain --format=json examples/median.lx median '[2,4,6,8]'

# Run a JSON AST module
lx test --input=ast examples/ast_demo.json
lx run --input=ast examples/ast_demo.json app.ast_demo.add 2 3
```

## Documentation

- **[SPEC.md](SPEC.md)** - Full language specification
- **[CONCURRENCY.md](CONCURRENCY.md)** - Detailed concurrency model (actors, structured async, supervision)
- **[THOUGHTS.md](THOUGHTS.md)** - Design philosophy and LLM-first principles
- **[ROADMAP.md](ROADMAP.md)** - Implementation strategy and v0.1 scope
- **[STATUS.md](STATUS.md)** - Current implementation status and next priorities

## Development workflow

- Update `grammar/lx.pegjs` and regen the parser with `npm run gen:parser`.
- The generated parser (`src/parser.generated.js`) is ignored by git; rebuild to regenerate it.
- The TypeScript sources live in `src/` and compile to `dist/` via `npm run build`.

Unit tests are currently expressed in Lx itself via `test` blocks. Running `npm test` rebuilds the compiler and executes the sample tests.
