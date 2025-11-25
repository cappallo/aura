# Lx Implementation Status Report

**Last Updated:** November 25, 2025
**Overall Progress:** ~88% (Core ~87%, Tooling ~95%, Concurrency ~80%)

The Lx project has a working **minimal interpreter** covering the foundational subset described in the ROADMAP.

---

## 🗺️ Roadmap & Priorities

This section tracks **future** work. Completed items are moved to the [Detailed Implementation Status](#-detailed-implementation-status) section.

### **Priority 10: The Basics (Standard Library & I/O)**
**Status:** 🟡 In Progress
**Goal:** Enable real-world application development.
- [x] **String Operations**: split, join, contains, starts_with, ends_with, trim, to_upper, to_lower, replace, index_of
- [x] **List Operations**: head, tail, take, drop, reverse, contains, find, flat_map, zip, enumerate
- [ ] **Networking**: TCP/UDP sockets, HTTP client/server bindings
- [ ] **File I/O**: File reading/writing, directory traversal, path manipulation
- [ ] **System**: Environment variables, process arguments, subprocess spawning
- [ ] **Date & Time**: Clock access, durations, formatting
- [ ] **Random**: General purpose RNG (beyond testing)

### **Priority 11: Active Comments (LLM Control Plane)**
**Status:** ✅ Complete
**Goal:** Implement first-class support for `/// prompt`, `/// context`, and `/// why`.
- [x] Define syntax and semantics in `SPEC.md`
- [x] Update parser to recognize top-level active comments
- [x] Expose active comments in AST for tooling
- [x] Add `lx active-comments` command to extract and report active comments

### **Future Priorities**
- **Schema Migrations**: Version transforms and data migration execution (SPEC §10.2).
- **Static Verification**: SMT solving for contracts (SPEC §7.1).
- **Effect Polymorphism**: Effect row variables (SPEC §5.3).
- **Optimization**: Performance improvements.

---

## 📊 Feature Status Matrix

| Area | Feature | Status | Notes |
|------|---------|--------|-------|
| **Core** | Modules & Imports | ✅ | Full resolution, dependency graph |
| | Types (ADT, Alias, Generic) | ✅ | Full inference (Hindley-Milner) |
| | Functions & Effects | ✅ | Pure by default, explicit effects |
| | Pattern Matching | ✅ | Exhaustive, destructuring |
| | Contracts | 🟡 | Runtime checks ✅, Static SMT ❌ |
| **Concurrency** | Actors | ✅ | Typed state, async message handlers |
| | Message Passing | ✅ | Mailboxes, typed `ActorRef<Msg>` |
| | Structured Async | ✅ | `async_group` with cancellation |
| | Supervision | ✅ | Trees, failure propagation, restarts |
| | Determinism | ✅ | Seedable RNG, deterministic scheduler |
| **Data** | Schemas | ✅ | `@version`, field validation |
| | JSON Codecs | ✅ | Auto-generated from schemas |
| **Tooling** | Parser | ✅ | Peggy-based, error recovery |
| | CLI | ✅ | `run`, `test`, `check`, `format` |
| | Execution Tracing | ✅ | `lx explain` (step-by-step trace) |
| | Formatting | ✅ | Canonical, deterministic output |
| | Refactoring | ✅ | Rename, Move, Update Params, Replace Pattern |
| | Active Comments | ✅ | Parser, AST, `lx active-comments` command |
| | DRY Enforcement | ✅ | Structural hashing detects duplicates |

---

## 🛠️ Detailed Implementation Status

### 1. Language Core
- **Type System**: Full Hindley-Milner inference with unification. Supports Records, Sum Types (ADTs), Aliases, Generics, and Optional sugar (`T?`).
- **Effect System**: Explicit effect tracking (`[Io, Concurrent]`). Typechecker enforces subset rules.
- **Control Flow**: `if`, `match` (exhaustive), recursion. No loops yet (use recursion or list builtins).
- **Values**: Int, Bool, String, List, Unit, ADTs.

### 2. Concurrency (Actor Model)
- **Actors**: `actor Name(params)` declarations with private `state`.
- **Handlers**: `on Message(params)` handlers. Single-threaded execution per actor.
- **Mailboxes**: Ordered, at-least-once delivery.
- **Scheduling**:
    - `immediate`: Process messages as they arrive (default).
    - `deterministic`: Queue messages, process via `Concurrent.step()` for testing.
- **Supervision**: Parent actors receive `ChildFailed` signals and manage child lifecycles.
- **Async Groups**: `async_group { ... }` for structured concurrency within handlers.

### 3. Tooling & DX (LLM-First)
- **Structured Output**: `--format=json` for all commands. Machine-readable errors and logs.
- **AST Input**: `--input=ast` allows executing JSON ASTs directly (skipping parsing).
- **Patch-Based Editing**: `lx patch-body` allows surgical updates to functions by symbol ID.
- **Refactoring Engine**:
    - `rename type/fn`: Updates declarations and usages across files.
    - `move type/fn`: Moves symbols and updates imports (auto-inserts new imports).
    - `update param_list`: Updates signatures and call sites (supports default values).
    - `replace pattern`: AST-based pattern replacement.
- **Documentation**: `/// spec:` comments are parsed and validated against function signatures.
- **DRY Enforcement**: `lx check` performs structural hashing to detect duplicated code logic (ignoring variable/field names) and suggests reuse.

### 4. Testing & Verification
- **Unit Tests**: `test name { ... }` blocks.
- **Property Tests**: `property name { ... }` with generators and shrinking.
- **Contracts**: `requires` / `ensures` checked at runtime.

---

## 🎯 Working Examples

The `examples/` directory contains verified "gold standard" code.

### Basics
- `median.lx`: Pure functions with tests
- `greetings.lx`: String manipulation
- `builtins.lx`: Standard library usage
- `list_operations.lx`: List manipulation
- `option.lx` / `simple_option.lx`: Option type usage
- `result.lx`: Error handling patterns
- `fibonacci.lx`: Recursion benchmarks
- `string_list_builtins.lx`: Extended string and list operations (split, join, trim, head, tail, zip, etc.)

### Concurrency & Actors
- `actor_basic.lx`: Core actor patterns (state, handlers, sending)
- `actor_supervision.lx`: Failure handling and supervision trees
- `actor_scheduler.lx`: Deterministic testing with `Concurrent.step`
- `actor_async_group.lx`: Structured async tasks within actors
- `async_group_return.lx`: Async return semantics

### Data & Schemas
- `schema.lx`: Basic schema declarations
- `schema_versioned.lx`: `@version` annotations
- `schema_codecs.lx`: JSON codec generation
- `structured_output.lx`: JSON output formatting

### Tooling & Testing
- `comments.lx`: Active comments and specs
- `refactor_sample.lx`: Refactoring targets
- `property_basics.lx`: Property-based testing
- `property_shrinking.lx`: Counterexample shrinking
- `property_deterministic.lx`: Deterministic RNG testing
- `logging.lx`: Structured logging

---

## 🔧 Development Guide

### Build Commands
```bash
npm run build          # Compile TypeScript + generate parser
npm run gen:parser     # Generate parser only
npm test               # Run all example tests
```

### CLI Usage
```bash
lx run [--format=json|text] [--input=source|ast] [--seed=N] <file.lx> <module.fn> [args...]
lx test [--format=json|text] [--input=source|ast] [--seed=N] <file.lx>
lx check [--format=json|text] [--input=source|ast] <file.lx>
lx format <file.lx>
lx explain [--format=json|text] [--input=source|ast] <file.lx> <module.fn>
lx patch-body <file.lx> <module.fn> <bodySnippet.lx>
lx apply-refactor <file.lx> <refactorName>
```

### Adding New Features
1.  **AST**: Update `src/ast.ts`.
2.  **Grammar**: Extend `grammar/lx.pegjs`.
3.  **Typechecker**: Update `src/typecheck/` (types, checkers, inference).
4.  **Interpreter**: Update `src/interpreter/` (evaluation, runtime, values).
5.  **Example**: Add a file in `examples/` to verify.
6.  **Status**: Update Feature Matrix and Detailed Status sections in this file.

---

## 🎯 Alignment with THOUGHTS.md

| Principle | Status | Notes |
|-----------|--------|-------|
| **Regular, low-context syntax** | ✅ | Simple keywords, explicit syntax. |
| **AST-first design** | ✅ | JSON AST input/output supported. |
| **Redundancy allowed** | ✅ | Verbose keywords, explicit types. |
| **Pure-by-default** | ✅ | Explicit `[Effects]`. |
| **Strong, local types** | ✅ | HM inference, location-based errors. |
| **Total behavior** | ✅ | No undefined behavior. |
| **Natural-language specs** | ✅ | `/// spec:` implemented. |
| **Inline tests** | ✅ | `test` and `property` blocks. |
| **Schema-first data** | ✅ | Schemas and codecs implemented. |
| **Deterministic replay** | ✅ | Seedable RNG, structured logs. |
| **Explicit explain hooks** | ✅ | `lx explain` traces execution. |
| **Patch-based edits** | ✅ | `lx patch-body` implemented. |
| **Guided refactors** | ✅ | Rename, Move, Update Params. |
| **Safe concurrency** | ✅ | Actors, supervision, async_group. |
| **Holes/partial code** | ✅ | `hole()` expression supported. |

---

---

## 🐛 Known Issues / Gaps
1.  **Standard Library**: Very limited. Missing File I/O, Networking, Date/Time.
2.  **No REPL**: Interaction is file-based only.
3.  **Parallel Primitives**: `parallel_map` exists but runs sequentially.

---

## 📚 References
- **[SPEC.md](SPEC.md)**: Full Language Specification.
- **[LX_AI_GUIDE.md](LX_AI_GUIDE.md)**: Guide for AI Agents.
- **[THOUGHTS.md](THOUGHTS.md)**: Design Philosophy.
