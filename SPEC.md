I have the spec below for a new LLM-friendly programming language / environment. What is the easiest way to get from this spec to something real I can run? Is that something you can spit out for me? Spec and comments below:

---

Here’s a cleaned-up, coherent take on **Lx**, plus a critique of the original draft baked in.

---

## 0. High-level critique of the draft

Before locking in a design, here are the main issues and adjustments:

1. **Two different meanings for `spec`**
   Used both for function contracts and type invariants. That’s confusing for tools and humans. I’ll split this into:

   * `contract fn ...` for functions,
   * `contract type ...` for types,
   * plus `test` / `property` as separate constructs.

2. **Effects syntax and semantics underspecified**
   `[Db, Log] Result<...>` is nice, but:

   * No clarity on whether effect sets are ordered, extensible, or hierarchical.
   * No story for effect polymorphism.
     I’ll define a **simple row-like effect system** with:
   * unordered sets,
   * no subeffect lattice,
   * optional row variables for library code, but conservative and analyzable.

3. **Actors half-specified**
   The draft shows `actor Mailer { on SendEmail(...) { ... } }` and `Mailer ! SendEmail(req)` but:

   * No state definition,
   * No lifecycle,
   * No failure/backpressure semantics.
     I’ll give actors explicit `state` and narrow semantics: **single-threaded mailboxes, typed messages, at-least-once delivery by default.**

4. **Schemas vs types**
   `schema` and `type` are nearly identical syntactically but their relationship is fuzzy:

   * How do you get from `schema UserRecord` to `type User`?
   * How are versions represented?
     I’ll define:
   * `schema` = external shape + versioned,
   * `type` = internal domain model,
   * a standard mechanism to derive mapping functions and codecs.

5. **Refactors and migrations**
   Great idea, but currently hand-wavy:

   * `refactor rename_type Email -> UserEmail` – what about module qualification, generics, imports, etc.?
   * `migration v3_add_created_at...` uses `UserRecord_v2` / `_v3` without specifying where those come from.
     I’ll define:
   * A small, explicit **refactor DSL** (rename symbol, move symbol, change parameter list) with tool-checked scope.
   * Schema versions as attributes, generating suffixed types automatically (e.g. `UserRecord@2`, `UserRecord@3` for migrations).

6. **Spec language too unconstrained**
   The spec examples use arbitrary expressions (`sort(list)`, comprehension-like code) that quickly destroy decidability.
   I’ll:

   * Restrict contracts to a **first-order, side-effect-free expression language**,
   * Allow SMT-friendly operators plus explicit “runtime only” predicates,
   * Make it explicit which parts are statically checkable vs runtime/assertions.

7. **Explain / logging / tracing**
   `explain` looks like a magic top-level command. Better to:

   * Keep core language small,
   * Treat `explain` as **tooling** (debug mode, instrumentation), not as a keyword.

8. **General complexity risk**
   There’s a temptation to throw in everything: ADTs, generics, effects, actors, refactors, schemas, SMT, property testing. That’s fine as long as:

   * Semantics are small and orthogonal,
   * No feature undermines static analyzability (e.g. runtime reflection, dynamic code loading).
     I’ll keep each subsystem minimalist and compositional.

What follows is a consolidated Lx design that sticks to the goals and trims or sharpens where needed.

---

## 1. Design goals

**Primary goals**

1. **LLM-first, analyzer-first**
   Code is written and edited mostly by LLMs under a compiler/analyzer; humans provide intent and review. Everything must be:

   * unambiguous,
   * machine-checkable,
   * easy to slice into local, self-contained pieces.

2. **Strong static guarantees**

   * Total visibility of dependencies: no hidden global state, no runtime patching.
   * Simple, expressive **algebraic types** + **effect system**.
   * Contracts, invariants, and schemas as first-class, machine-readable artifacts.

3. **Partial-context friendliness**

   * Any function/module can be understood by an LLM with:

     * its own body,
     * its type and contract,
     * signatures/contracts of direct dependencies,
     * optionally a compiler-generated summary of non-local context.

4. **Safe evolution**

   * Explicit constructs for **refactors** and **migrations**.
   * Analyzer computes blast radius; LLM edits only what’s in the slice.

5. **Constrained expressiveness**

   * No features that wreck static analysis (reflection, “eval”, monkeypatching).
   * No clever tricks that defeat the analyzer for the sake of convenience.

---

## 2. Core concepts

Lx’s core building blocks:

* **Module** – one per file, defines a namespace.
* **Type** – algebraic data type (sum/product), type alias, optionally generic.
* **Schema** – versioned description of external data (JSON, DB, messages).
* **Function (`fn`)** – pure by default, effect-annotated when needed.
* **Effect** – named side-effect capability (e.g. `Db`, `Log`, `Http`).
* **Actor** – single-threaded stateful entity with a typed message protocol.
* **Contracts** – pre/postconditions and invariants on functions and types.
* **Tests / Properties** – example-based and property-based tests.
* **Refactors** – static transformations over the code graph.
* **Migrations** – transformations over schema-versioned data.

Everything is:

* Statically typed,
* Fully explicit at the boundaries (I/O, effects, actor interfaces),
* Amenable to static graph construction (no hidden edges).

---

## 3. Syntax and grammar sketch

### 3.1. Lexical elements

* Identifiers: `[_A-Za-z][_A-Za-z0-9]*`
* Types: Capitalized by convention: `User`, `Result`, `UserId`.
* Keywords (non-exhaustive):
  `module`, `import`, `as`, `type`, `schema`, `fn`, `effect`,
  `actor`, `state`, `on`, `contract`, `requires`, `ensures`, `invariant`,
  `match`, `case`, `let`, `return`, `test`, `property`,
  `refactor`, `migration`, `from`, `to`, `where`.

No operator overloading beyond a fixed set (`+ - * / == != <= >= && ||` etc.). No macros.

### 3.2. Modules and imports

```lx
module app.user

import std.list
import std.result as Result
import app.http
```

**Grammar sketch (EBNF style):**

```ebnf
Module      ::= "module" ModuleName NEWLINE { Import } { TopLevelDecl }
ModuleName  ::= Ident { "." Ident }

Import      ::= "import" ModuleName [ "as" Ident ] NEWLINE
TopLevelDecl::= TypeDecl | SchemaDecl | EffectDecl | FnDecl
              | ActorDecl | ContractDecl | TestDecl | PropertyDecl
              | RefactorDecl | MigrationDecl
```

### 3.3. Types

Product type:

```lx
type UserId = Int

type User {
  id: UserId
  email: String?
  name: String
  created_at: Instant
}
```

Sum type:

```lx
type SaveError =
  | ValidationError { message: String }
  | Conflict       { existing: UserId }
  | StorageError   { reason: String }
```

Generics:

```lx
type Result<T, E> =
  | Ok  { value: T }
  | Err { error: E }
```

Optional sugar:

* `T?` is sugar for `Option<T>`, where:

```lx
type Option<T> =
  | Some { value: T }
  | None
```

**Grammar sketch:**

```ebnf
TypeDecl   ::= "type" Ident [ TypeParams ] "=" SumType NEWLINE
             | "type" Ident [ TypeParams ] "{" FieldList "}" NEWLINE
             | "type" Ident "=" TypeExpr NEWLINE

TypeParams ::= "<" Ident { "," Ident } ">"
SumType    ::= Variant { "|" Variant }
Variant    ::= Ident [ "{" FieldList "}" ]
FieldList  ::= Field { NEWLINE Field }
Field      ::= Ident ":" TypeExpr

TypeExpr   ::= SimpleType { TypeExprSuffix }
SimpleType ::= Ident | "(" TypeExpr ")"
TypeExprSuffix
            ::= "<" TypeExpr { "," TypeExpr } ">"
             | "?"
```

### 3.4. Functions and expressions

Pure function:

```lx
fn median(list: List<Float>) -> Float {
  let sorted = list.sort()
  let n = sorted.length()
  let idx = (n - 1) / 2
  return sorted[idx]
}
```

Effectful function:

```lx
effect Db
effect Log

fn save_user(user: User) -> [Db, Log] Result<UserId, SaveError> {
  Log.debug("saving_user", { email: user.email })
  let id = Db.insert_user(user)
  return Ok { value: id }
}
```

**Grammar (simplified):**

```ebnf
EffectDecl ::= "effect" Ident NEWLINE

FnDecl     ::= "fn" Ident "(" ParamList? ")" "->" ReturnType Block

ParamList  ::= Param { "," Param }
Param      ::= Ident ":" TypeExpr

ReturnType ::= TypeExpr
             | "[" EffectList "]" TypeExpr
EffectList ::= Ident { "," Ident }

Block      ::= "{" { Stmt } "}"
Stmt       ::= LetStmt | ExprStmt | ReturnStmt | MatchStmt
LetStmt    ::= "let" Ident "=" Expr NEWLINE
ReturnStmt ::= "return" Expr NEWLINE
ExprStmt   ::= Expr NEWLINE

MatchStmt  ::= "match" Expr "{" { "case" Pattern "=>" Block } "}"
Pattern    ::= Ident | Ident "{" PatternFields "}" | "_"
PatternFields ::= Ident ":" Pattern { "," Ident ":" Pattern }
```

Expressions are standard expression AST with no reflection or dynamic code loading.

---

## 4. Type system

### 4.1. Overview

* **Static, strong, no implicit casts.**
* **Algebraic data types** (sum/product).
* **Rank-1 generics** (like ML/Haskell without higher-rank types).
* **Global type inference** within a module is allowed but conservative: tools can always request or enforce explicit annotations for public APIs.

### 4.2. Primitives

* `Int`, `Float`, `Bool`, `String`, `Instant`, `Unit`.
* `List<T>`, `Map<K, V>` in the standard library.
* Nullable: `T?` ⇒ `Option<T>`.

### 4.3. Type inference

* Standard Hindley–Milner-style inference *within* a module, plus:

  * All exported functions **must** declare their type.
* No ad-hoc overloading: if the symbol is `+`, it has a small, fixed set of types known to the compiler (e.g. `Int + Int`, `Float + Float`).

### 4.4. Pattern matching & exhaustiveness

* `match` is exhaustive for ADTs:

  * compiler must ensure all constructors are covered or there’s a `_` fallback.
* Non-exhaustive matches are rejected unless there’s an explicit `_` with an `unreachable()` or explicit error.

### 4.5. Variance & generics

* Type parameters default to invariant.
* No subtyping beyond:

  * optional `T?` vs `Option<T>`,
  * special case `Unit` (single value) treated like void.

No inheritance, traits, or interfaces in v1 to keep the type graph simple and fully explicit. Behaviors come from functions over data.

---

## 5. Effect system

### 5.1. Effects as capability sets

Effects are just **names**:

```lx
effect Db
effect Log
effect Http
```

A function’s return type can include an effect set:

```lx
fn f(x: Int) -> [Db, Log] Result<Int, DbError> { ... }
```

Meaning:

* Executing `f` may perform `Db` and `Log` effects.
* `f` can only call other functions whose effect set is a **subset** of `{Db, Log}`.

Pure functions omit the effect list:

```lx
fn g(x: Int) -> Int { ... }  // pure
```

### 5.2. Static rules

1. **Effect monotonicity:**
   If `fn h` has effects `E(h)`, it may only call `fn g` if `E(g) ⊆ E(h)`.

2. **No hidden effects:**
   No foreign function can smuggle in hidden IO; any function interacting with the outside world must declare effects.

3. **Effect inference:**

   * For local functions: inferred as the union of callee effects plus any built-in effectful operations.
   * For exported functions: must annotate; compiler checks that inferred effects are a subset of declared ones (otherwise error).

### 5.3. Optional effect polymorphism

To keep library code usable, we allow **effect row variables** at function level, but very narrowly:

```lx
fn map<T, U, e>(xs: List<T>, f: fn(T) -> [e] U) -> [e] List<U> { ... }
```

Here `e` is an effect row variable, representing an unknown set of effects. Rules:

* No arithmetic or equality on effect rows.
* Rows cannot be partially constrained (no “`[Log | e]`” nonsense in v1).
* They only propagate: the function echoes the effect set of its callback.

This is still analyzable: the compiler can instantiate `e` at call sites.

---

## 6. Concurrency model

**Note:** This section provides a high-level overview. For the complete concurrency design including structured async, supervision trees, deterministic testing, and data-parallel primitives, see [`CONCURRENCY.md`](CONCURRENCY.md).

### 6.1. Actors

Actors are single-threaded entities with:

* Internal mutable state,
* A typed message protocol (`Msg` ADT),
* A mailbox.

Syntax:

```lx
type MailerMsg =
  | SendEmail { req: EmailRequest }
  | Shutdown

actor Mailer {
  state {
    sent_count: Int
  }

  on SendEmail(msg: SendEmail) -> [Http, Log] Result<Unit, MailError> {
    Log.info("sending_email", { to: msg.req.to })
    Http.send_email(msg.req)?
    state.sent_count = state.sent_count + 1
    return Ok { value: () }
  }

  on Shutdown(msg: Shutdown) -> [Log] Unit {
    Log.info("mailer_shutdown", { total: state.sent_count })
    // actor terminates after handler completes
  }
}
```

Message send:

```lx
fn notify_user(user: User, text: String, mailer: MailerRef)
  -> [Log] Unit 
{
  let msg = SendEmail { req: EmailRequest { to: user.email, body: text } }
  mailer.send(msg)
}
```

### 6.2. Semantics

* Each actor has a **type**: `Actor<Msg, State>` (opaque in user code).
* `mailer: MailerRef` is a value of some abstract type representing a handle to the `Mailer` actor.
* `mailer.send(msg)`:

  * enqueues `msg` into the mailbox (non-blocking),
  * returns `Unit` or a typed `Result` if we support request/response patterns.

Ordering & delivery:

* Messages from a single sender to a single actor are **ordered**.
* Delivery is at-least-once by default (simplest assumption). At-most-once can be a runtime configuration, not a type property in v1.

Effects:

* Inside an actor handler, you can use any effects you declare in the handler signature.
* The **Actor** model itself does not appear as an effect; the concurrency semantics are defined operationally, not as an effect.

Backpressure / failure:

* Simple v1:

  * `send` never blocks; if the actor is terminated, `send` returns a `Result<Unit, ActorError>`.
* More advanced patterns (streams, backpressure, supervision trees) are deferred to future versions.

Key property: All actor interaction is via **typed messages**, so the analyzer can construct a message graph (who sends what to whom).

### 6.3. Structured Async and Parallelism

**For v0.1:** Actors use simple synchronous message handlers.

**Future enhancements** (detailed in [`CONCURRENCY.md`](CONCURRENCY.md)):
- **Structured async tasks** within actors for concurrent I/O operations
- **Data-parallel primitives** (`parallel_map`, `parallel_fold`) for pure CPU-bound work
- **Supervision trees** for robust failure handling and actor lifecycle management
- **Deterministic scheduling** mode for reproducible testing and debugging
- **Concurrency effect** (`Effect<Concurrent>`) for spawning actors and tasks

These features will be added incrementally after the core actor model is implemented.

---

## 7. Contracts, specs, and tests

### 7.1. Contracts on functions

Syntax:

```lx
contract fn median(list: List<Float>) -> Float {
  description: "Median of non-empty list; lower-middle for even length."

  requires:
    length(list) > 0

  ensures:
    exists(x in list) x == result

  ensures:
    let s = sort(list) in
    let n = length(s) in
    let idx = (n - 1) / 2 in
    result == s[idx]
}
```

Rules:

* `requires` and `ensures` contain expressions in a **pure, side-effect-free contract language**:

  * arithmetic, boolean ops,
  * let-bindings,
  * quantifiers over finite collections (`forall(x in list)`, `exists(...)`),
  * calls to functions explicitly marked as `@pure_contract` in their declaration.
* `result` is bound in `ensures`.

Verification:

* Static: the compiler may attempt SMT checks on simple contracts.
* Runtime: for debug/test builds, contracts become assertions.
  Failure produces structured error data: function name, arguments, violated clause, evaluated context.

### 7.2. Contracts on types (invariants)

```lx
contract type User {
  invariant:
    name != ""
  invariant:
    email == None || is_valid_email(email)
}
```

* Invariants must hold:

  * after construction,
  * after any function explicitly marked as a **trusted mutator** of that type (if Lx allows in-place updates).
* In pure Lx (immutable data), invariants are checked on constructor functions and any accessors that synthesize a new `User`.

### 7.3. Tests

Example tests:

```lx
test median_examples {
  test.assert_equal(median([1.0]), 1.0)
  test.assert_equal(median([1.0, 3.0, 5.0]), 3.0)
  test.assert_equal(median([2.0, 4.0, 6.0, 8.0]), 4.0)
}
```

Semantics:

* `test` blocks define named tests in the enclosing module.
* The test runner executes them; failures return structured reports.

### 7.4. Property-based tests

```lx
property median_in_range(list: List<Float> where length(list) > 0) {
  let m = median(list)
  assert(min(list) <= m && m <= max(list))
}
```

Parameter generation semantics:

* For each parameter `x: T where P(x)`:

  * Use a default generator for `T`,
  * Filter with predicate `P`; if too many are rejected, the runner fails with “unsatisfiable generator” (also useful feedback).

Failure reports:

* Include:

  * property name,
  * minimal counterexample (after shrinking),
  * stack trace to failure assertion,
  * serialized input values.

This is exactly the kind of structured data an LLM loves.

---

## 8. Schemas and I/O

### 8.1. Schemas

```lx
@version(2)
schema UserRecord {
  id: String
  email: String?
  name: String
  created_at: String  // ISO8601
}
```

Rules:

* `schema` describes *external* shapes:

  * JSON documents,
  * DB rows,
  * HTTP payloads, etc.
* Fields are required unless marked with `?`.
* `@version(n)` is mandatory; versions are monotonically increasing per schema name.

From a schema the compiler derives:

* `type UserRecord@2` – a generated internal type (for migrations).
* `codec UserRecord@2 <-> json` and optionally DB mappings.

### 8.2. Schema ↔ type mapping

You typically define an internal domain type and map from schema:

```lx
type User {
  id: UserId
  email: String?
  name: String
  created_at: Instant
}

fn from_user_record(rec: UserRecord@2) -> Result<User, MappingError> { ... }
```

Tools can generate boilerplate mapping, but it remains explicitly visible and overridable.

### 8.3. Typed I/O

```lx
fn fetch_user(id: UserId) -> [Http, Log] Result<User, HttpError> {
  let req: http.Request<Unit> = {
    method: "GET",
    path: "/users/" + to_string(id),
    query: {},
    body: ()
  }

  let res: Result<http.Response<UserRecord@2>, HttpError> = Http.send(req)
  match res {
    case Ok { value: response } => {
      Log.debug("fetched_user", { id: id })
      let user = from_user_record(response.body)?
      return Ok { value: user }
    }
    case Err { error: err } => {
      Log.error("fetch_user_failed", { id: id, error: err })
      return Err { error: err }
    }
  }
}
```

Key point: **no untyped JSON**. All I/O uses `schema` or derived types.

---

## 9. Logging, tracing, and explain

### 9.1. Logging

Logging is just one more effect:

```lx
effect Log

fn map_record_to_user(rec: UserRecord@2) -> [Log] User {
  Log.trace("map_record_to_user", { rec: rec })
  User {
    id: parse_user_id(rec.id),
    email: rec.email,
    name: rec.name,
    created_at: parse_instant(rec.created_at)
  }
}
```

Rules:

* All log calls take a **structured object** (record) as data.
* The standard library defines log levels: `trace`, `debug`, `info`, `warn`, `error`.
* The effect checker ensures only functions with `Log` in their effect set can log.

### 9.2. Tracing / explain

`explain` is not a keyword. It’s an analyzer/runtime feature:

* The tooling API can request:

  ```json
  {
    "command": "run_with_trace",
    "module": "app.stats",
    "fn": "median",
    "args": { "list": [2.0, 4.0, 6.0, 8.0] }
  }
  ```

* Runtime returns:

  ```json
  {
    "fn": "app.stats.median",
    "args": { "list": [2.0, 4.0, 6.0, 8.0] },
    "steps": [
      { "let": "sorted", "value": [2.0, 4.0, 6.0, 8.0] },
      { "let": "n", "value": 4 },
      { "let": "idx", "value": 1 },
      { "return": 4.0 }
    ]
  }
  ```

Granularity is configurable:

* Statement-level by default,
* Expression-level when compiled with a debug flag.

This keeps the language spec clean and pushes explainability into tooling, where the LLM can directly consume the trace.

---

## 10. Refactors and migrations

### 10.1. Refactors

Refactors are **programs over the symbol graph**, not ad-hoc search/replace.

Example:

```lx
refactor rename_type_email_to_user_email {
  rename type app.user.Email -> app.user.UserEmail
  update:
    type_annotations
    constructors
    pattern_matches
  ignore:
    string_literals
    comments
}
```

Supported primitives in v1:

* `rename type A -> B`
* `rename fn A -> B`
* `move type A from X to Y`
* `move fn A from X to Y`
* `update param_list` (e.g. add a new parameter with default value)
* `replace pattern` – restricted structural pattern rewrites.

Each primitive:

* Operates on fully resolved symbols (module-qualified),
* Is validated by the analyzer before application (no dangling references).

Tooling:

* `apply_refactor` returns:

  * modified files,
  * list of touched symbols,
  * structured summary of changes.

The LLM should **author or edit refactor blocks**, not edit dozens of call sites manually.

### 10.2. Migrations

Schema migrations operate on versions:

```lx
migration user_record_v2_to_v3 {
  from UserRecord@2
  to   UserRecord@3

  fn transform(rec: UserRecord@2) -> UserRecord@3 {
    UserRecord@3 {
      id: rec.id,
      email: rec.email,
      name: rec.name,
      created_at: now_iso8601()
    }
  }
}
```

Rules:

* Each `schema S` with versions `v1..vn` can have migrations `Si -> Sj`.
* The analyzer ensures:

  * Version graph is acyclic,
  * Coverage for upgrades/downgrades is as required by deployment config.

Deployment interaction (out of scope for core language) is handled by tools, but:

* Language guarantees that migration code is:

  * Typed (old and new versions are distinct types),
  * Effectful only in declared ways (`[Db, Log]` etc. if needed).

---

## 11. Tooling / LLM integration API

This is the “nerve system” between Lx, the analyzer, and the LLM.

### 11.1. Core operations

1. **Compile / typecheck**

   ```json
   {
     "command": "compile",
     "targets": ["app.user"],
     "mode": "check"
   }
   ```

   Returns:

   ```json
   {
     "status": "error",
     "errors": [
       {
         "kind": "TypeError",
         "module": "app.user",
         "range": { "file": "app/user.lx", "start": {...}, "end": {...} },
         "message": "Expected Int, found String",
         "context": { "expected": "Int", "found": "String", "expr": "user.id" }
       }
     ]
   }
   ```

2. **Symbol graph**

   ```json
   { "command": "symbol_graph", "module": "app.user" }
   ```

   Returns a graph of:

   * functions, types, schemas, actors, tests,
   * call edges, type usage edges, message edges.

3. **Impact analysis**

   ```json
   {
     "command": "impact",
     "change": {
       "kind": "signature_change",
       "symbol": "app.user.save_user",
       "from": { "type": "fn(User) -> [Db, Log] Result<UserId, SaveError>" },
       "to":   { "type": "fn(User) -> [Db, Log] Result<User, SaveError>" }
     }
   }
   ```

   Returns:

   * list of affected callsites,
   * affected contracts/tests,
   * affected schemas, actors, etc.

4. **Context slice**

   ```json
   {
     "command": "slice",
     "root_symbols": ["app.user.save_user"]
   }
   ```

   Returns a small bundle:

   * full source for the root symbol(s),
   * minimal set of dependent definitions (types, functions),
   * contracts and tests directly referencing them,
   * summaries for everything else.

5. **Queries**

   Examples:

   ```json
   { "command": "find_callsites", "symbol": "app.user.save_user" }

   { "command": "find_effectful", "effect": "Db" }

   { "command": "find_contracts_assuming",
     "predicate": "User.email != None" }
   ```

   All answers are structured, never big wads of unstructured source.

6. **Run tests / properties**

   ```json
   { "command": "run_tests", "modules": ["app.user", "app.stats"] }
   ```

   Returns:

   ```json
   {
     "status": "fail",
     "failures": [
       {
         "kind": "property_failure",
         "name": "median_in_range",
         "module": "app.stats",
         "input": { "list": [10.0, 0.0] },
         "trace": [...]
       }
     ]
   }
   ```

7. **Refactor application**

   ```json
   {
     "command": "apply_refactor",
     "module": "app.user",
     "refactor_name": "rename_type_email_to_user_email"
   }
   ```

   Returns changed files and a summary.

8. **Run with trace (explain)**
   As described in §9.2.

### 11.2. Guiding principles

* All tool responses are:

  * small enough to fit in context,
  * strongly structured (JSON),
  * refer to symbols by fully-qualified names.

The LLM’s job is to:

* Modify the slice,
* Possibly author refactor/migration blocks,
* Ask for more slices/summaries as needed.

---

## 12. Limitations and open questions

The design is intentionally conservative. Remaining questions:

1. **Effect polymorphism**
   Row variables are useful but easy to overcomplicate. v1 keeps them very limited. We may later:

   * add composition (`[Log | e]`),
   * add effect hierarchies (`Network ⊇ Http`),
     but that risks complexity.

2. **Cross-actor invariants**
   Actor state is encapsulated; global invariants spanning multiple actors (e.g. bank balances) are hard. We can:

   * express them as higher-level tests/properties,
   * or consider some form of “protocol contracts” later.

3. **Spec verification strength**
   Full static verification is unrealistic. Lx’s stance:

   * make contracts machine-readable and checkable where feasible,
   * but rely heavily on runtime assertions/property tests + LLM triage.

4. **FFI**
   Interop with host languages (Rust, Go, etc.) is not specified here. To preserve analyzability:

   * any FFI function should be declared with explicit effects and types, and considered opaque.

5. **Meta-programming**
   No macros or compile-time code generation in v1. Tooling + LLM plus explicit refactors should cover most use cases. If meta-programming appears, it must not break the analyzer’s grip on the code graph.

6. **Performance and backend**
   The design is backend-agnostic:

   * could compile to a managed runtime, WASM, or native code.
     That choice will affect actor implementation and I/O layers but not the language itself.

---

That’s the cleaned-up Lx: small, analyzable, boring in all the ways that make static tools and LLMs happy, with contracts, schemas, actors, and refactors wired into the core rather than bolted on as library gimmicks.
