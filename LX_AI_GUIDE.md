# Lx Programming Language Guide for AI Agents

## Overview

Lx is an **LLM-first programming language** designed for clarity, safety, and static analyzability. Code is pure by default, effects are explicit, and all language constructs prioritize machine-readability over clever syntax.

**Core Philosophy:**
- Regular, unambiguous syntax (no precedence tricks, no implicit conversions)
- Pure functions by default; explicit effect tracking
- Strong static types with local error reporting
- Contracts, schemas, and tests as first-class constructs
- Actors for safe concurrency (no shared mutable state)

---

## Syntax Fundamentals

### Module Declaration
Every file starts with a module declaration:
```lx
module examples.my_feature
```

### Comments

**Line comments:**
```lx
// Single-line comment
```

**Block comments:**
```lx
/* Multi-line
   comment block */
```

**Documentation comments (structured):**
```lx
/// spec:
///   description: "Calculate the Manhattan distance between two points."
///   inputs:
///     - p1: "First point"
///     - p2: "Second point"
///   outputs:
///     - "The Manhattan distance (sum of absolute differences)"
///   laws:
///     - "distance(p1, p2) == distance(p2, p1)"
///     - "distance(p, p) == 0"
fn manhattan_distance(p1: Point, p2: Point) -> Int {
  return math.abs(p1.x - p2.x) + math.abs(p1.y - p2.y)
}
```

Documentation comments use the `/// spec:` format and are:
- **Parsed into structured data** (description, inputs, outputs, laws, fields)
- **Validated against declarations** (parameter names, field names must match)
- **Preserved in the AST** for tooling and IDE integration
- **Machine-readable** for automated documentation generation

### Types

**Primitive Types:**
- `Int` - integers
- `Bool` - true/false
- `String` - text
- `Unit` - void/empty value (written as `Unit` in types, `{}` in expressions)

**Compound Types:**
```lx
// List
type Numbers = List<Int>

// Record (product type)
type Point {
  x: Int
  y: Int
}

// Sum type (tagged union)
type Option = Some { value: Int } | None

// Generic type
type Result<T, E> = Ok { value: T } | Error { error: E }
```

**Type aliases:**
```lx
type UserId = String
```

### Functions

**Basic function:**
```lx
fn add(x: Int, y: Int) -> Int {
  return x + y
}
```

**With effects (for I/O, concurrency, etc.):**
```lx
fn save_user(user: User) -> [Io] Result<UserId, SaveError> {
  // Function can perform I/O operations
  return Ok { value: "user-123" }
}
```

**Effect types:**
- `[Io]` - I/O operations
- `[Concurrent]` - concurrency (actors, async)
- `[Log]` - logging
- Effects can be combined: `[Io, Log]`

### Variables

**Immutable by default:**
```lx
let x = 42
let name: String = "Alice"  // Type annotation optional but encouraged
```

**Mutable (inside functions only):**
```lx
let x: Int = 0
x = x + 1  // Reassignment
```

Inline annotations are supported: `let total: Int = ...`. The checker enforces that annotated bindings have expressions of the declared type.

> **Parser diagnostics:** When the PEG parser cannot build an AST—for example, if you use the unsupported `let value: Int = ...` syntax or the planned `for`/`while` loops—it falls back to raw messages such as `Expected "/*" ... but ":" found`. The richer Lx tracebacks only run after parsing succeeds, so treat these errors as a hint that the syntax doesn’t exist yet.

### Control Flow

**If-else (must be exhaustive):**
```lx
let result = if x > 0 {
  "positive"
} else {
  "non-positive"
}
```

**Match (pattern matching, must be exhaustive):**
```lx
match option {
  case Some { value: v } => {
    return v
  }
  case None => {
    return 0
  }
}
```

> **Note:** The current parser build (Nov 2025) does not yet support `for` or `while` loops even though they are part of the planned syntax. Use recursion (tail-recursive helpers or higher-order list functions) to express iteration for now.

**For loops (planned):**
```lx
for item in list {
  // Planned syntax – not yet available
}
```

**While loops (planned):**
```lx
while condition {
  // Planned syntax – not yet available
}
```

### Lists

**Creation:**
```lx
let numbers = [1, 2, 3]
let empty: List<Int> = []
```

**Operations (via builtins):**
```lx
list.len(numbers)              // Length
list.append(numbers, 4)        // Add element
list.concat(list1, list2)      // Concatenate
list.map(numbers, double)      // Map function over list
list.filter(numbers, is_pos)   // Filter with predicate
list.fold(numbers, 0, add)     // Fold/reduce
```

### Records and Variants

**Creating records:**
```lx
let point = Point { x: 10, y: 20 }
```

**Accessing fields:**
```lx
let x_coord = point.x
```

**Creating variants:**
```lx
let some_value = Some { value: 42 }
let none_value = None {}
```

**Pattern matching:**
```lx
match result {
  case Ok { value: v } => {
    return v
  }
  case Error { error: e } => {
    return -1
  }
}
```

---

## Contracts

Contracts specify preconditions and postconditions for functions. Use `result` to refer to the return value.

```lx
contract fn clamp(value: Int, min: Int, max: Int) -> Int {
  requires min <= max
  ensures result >= min
  ensures result <= max
}

fn clamp(value: Int, min: Int, max: Int) -> Int {
  let lower = if value < min { min } else { value }
  let bounded = if lower > max { max } else { lower }
  return bounded
}
```

**Contracts are checked at runtime.** If a `requires` clause fails, it's a caller error. If an `ensures` clause fails, it's an implementation error.

---

## Tests

**Test blocks:**
```lx
test my_feature_tests {
  test.assert_equal(add(2, 3), 5)
  test.assert_equal(clamp(15, 0, 10), 10)
}
```

**Property-based tests:**
```lx
property test_addition_commutative {
  forall x: Int, y: Int {
    check x + y == y + x
  }
}
```

**Running the CLI:** There is a convenience script 'lx' that you can use:

```bash
lx run examples.demo.lx examples.demo.main
lx test examples.demo.lx
```

The wrapper forwards all arguments to `node dist/cli.js`, giving you a concise entry point for every command.


---

## Debugging & Tracing

Lx provides powerful built-in tools to understand code execution, designed specifically for LLM analysis.

### Execution Tracing (`lx explain`)

Use `lx explain` to run a function and get a detailed, step-by-step trace of its execution. This is invaluable for debugging complex logic or understanding control flow.

```bash
lx explain examples/my_file.lx my_module.my_function
```

**Output includes:**
- Function calls and returns (with values)
- Variable bindings (`let`)
- Control flow decisions (`if`, `match`)
- Recursive depth

### Structured Errors

For tool-based analysis, always use the `--format=json` flag. This provides machine-readable error objects with precise source locations, eliminating the need to parse console output.

```bash
lx check --format=json examples/my_file.lx
```

### Best Practice

**When in doubt, trace it out.** If you are unsure why a function returns a specific value, run it with `lx explain`. The trace provides the ground truth of execution.

---

## Tooling

Lx is built for tooling.

### Canonical Formatting (`lx format`)
Deterministic code formatting. Always run this before committing.
```bash
lx format my_file.lx
```

### Patch-Based Editing (`lx patch-body`)
Surgically replace a function body using its stable symbol ID. Ideal for LLM code generation.
```bash
lx patch-body my_file.lx my_module.my_function new_body.lx
```

### Type Checking (`lx check`)
Run the compiler's static analysis without executing.
```bash
lx check my_file.lx
```

---

## Refactors

Structured refactor blocks let you describe graph-wide changes declaratively. The analyzer validates them and the CLI applies them consistently.

```lx
refactor rename_email_entities {
  rename type app.user.Email -> app.user.UserEmail
  rename fn app.user.email_value -> app.user.extract_email_value
  update:
    type_annotations
    constructors
}
```

Run `lx apply-refactor <file.lx> <refactorName>` to apply the block. Supported operations:
- `rename type`, `rename fn`: Renames symbols across the dependency graph.
- `move type`, `move fn`: Moves symbols to another module (auto-updates imports).
- `update param_list`: Changes function parameters and updates call sites (supports defaults).
- `replace pattern`: Rewrites AST patterns (e.g., `foo(x)` -> `bar(x, 0)`).

---

## Actors (Concurrency)

Actors provide safe concurrent mutable state. Each actor processes messages sequentially (single-threaded internally).

**Actor definition:**
```lx
type CounterMsg = Increment | Add { amount: Int } | GetValue

actor Counter(initial: Int) {
  state {
    count: Int
  }

  on Increment() -> [Concurrent] Unit {
    let count = count + 1
  }

  on Add(amount: Int) -> [Concurrent] Unit {
    let count = count + amount
  }

  on GetValue() -> [Concurrent] Int {
    return count
  }
}
```

**Using actors:**
```lx
fn use_counter() -> [Concurrent] Int {
  let counter = Counter.spawn(0)          // Create instance
  counter.send(Increment { })              // Send message (async)
  counter.send(Add { amount: 5 })
  return Counter.GetValue(counter)         // Call and wait for result
}
```

**Key points:**
- `spawn` creates a new actor instance
- `send` sends a message without waiting
- `ActorName.MessageName(ref)` sends a message and waits for the response
- All actor operations require `[Concurrent]` effect

### Structured Async (`async_group`)
Run tasks in parallel within an actor handler. If one fails, all are cancelled.
```lx
async_group {
  async { ... }
  async { ... }
}
```

### Supervision Trees
Actors form a hierarchy. If a child actor fails, the supervisor receives a `ChildFailed` signal and can restart it.

### Deterministic Scheduling
For testing, use `--scheduler=deterministic`. This ensures message delivery order is reproducible (controlled by `--seed`).

---

## Schemas

Schemas define external data formats with versioning support. Use `@version` attribute.

```lx
@version(1)
schema UserRecord {
  id: String
  name: String
}

@version(2)
schema UserRecord {
  id: String
  name: String
  email: String
}
```

Schemas can be converted to/from types for internal domain models.

### JSON Codecs
Schemas automatically generate `json.encode` and `json.decode` functions.
```lx
let json_str = json.encode(user)
let decoded = json.decode(json_str) // Returns Result<UserRecord, String>
```

---

## Documentation Comments

Lx supports **structured documentation comments** that are machine-readable and validated. Use the `/// spec:` format.

### Format for Functions

```lx
/// spec:
///   description: "Human-readable description of what the function does."
///   inputs:
///     - param1: "Description of first parameter"
///     - param2: "Description of second parameter"
///   outputs:
///     - "Description of what the function returns"
///   laws:
///     - "Mathematical or logical property: result >= 0"
///     - "Invariant or relationship: foo(x, y) == foo(y, x)"
fn foo(param1: Int, param2: Int) -> Int {
  // ...
}
```

### Format for Types

```lx
/// spec:
///   description: "A 2D point with integer coordinates."
///   fields:
///     - x: "The X coordinate"
///     - y: "The Y coordinate"
type Point {
  x: Int
  y: Int
}
```

### Key Features

1. **Validation**: Parameter names in `inputs` must match actual function parameters
2. **Validation**: Field names in `fields` must match actual type fields
3. **Structured**: Parsed into a typed data structure (`DocSpec`)
4. **Preserved**: Available in the AST for tooling
5. **Optional**: All sections are optional; omit what you don't need

### Example with All Features

```lx
/// spec:
///   description: "Calculate the Manhattan distance between two points."
///   inputs:
///     - p1: "First point"
///     - p2: "Second point"
///   outputs:
///     - "The Manhattan distance (sum of absolute differences)"
///   laws:
///     - "distance(p1, p2) == distance(p2, p1)"
///     - "distance(p, p) == 0"
fn manhattan_distance(p1: Point, p2: Point) -> Int {
  let dx = math.abs(p1.x - p2.x)
  let dy = math.abs(p1.y - p2.y)
  return dx + dy
}
```

---

## Active Comments

Active comments (`/// keyword:`) allow you to give direct instructions to the LLM or tooling. They are preserved in the code and serve as a persistent "control plane".

### Directives

*   **`/// prompt: <instruction>`**
    *   Tells the LLM what to do next or how to modify the code.
    *   *Example:* `/// prompt: Refactor this to use a tail-recursive helper.`

*   **`/// context: <symbol>`**
    *   Explicitly links related code that the LLM should look at.
    *   *Example:* `/// context: app.types.User`

*   **`/// why: <reason>`**
    *   Explains a design decision to prevent accidental "fixes".
    *   *Example:* `/// why: Using a list instead of a set to preserve insertion order.`

### Example Usage

```lx
/// prompt: Optimize this for large lists.
/// why: This is called in the hot loop of the renderer.
/// context: app.renderer.RenderConfig
fn process_items(items: List<Item>) -> List<Item> {
  // ...
}
```


**String operations:**
- `str.len(text: String) -> Int`
- `str.slice(text: String, start: Int, end: Int) -> String`
- `str.concat(left: String, right: String) -> String`

**Math operations:**
- `math.abs(x: Int) -> Int`
- `math.min(left: Int, right: Int) -> Int`
- `math.max(left: Int, right: Int) -> Int`

**List operations:**
- `list.len(list: List<T>) -> Int`
- `list.append(list: List<T>, item: T) -> List<T>`
- `list.concat(left: List<T>, right: List<T>) -> List<T>`
- `list.map(list: List<T>, mapper: fn(T) -> U) -> List<U>`
- `list.filter(list: List<T>, predicate: fn(T) -> Bool) -> List<T>`
- `list.fold(list: List<T>, initial: U, folder: fn(U, T) -> U) -> U`

**Printing (requires `[Io]` effect):**
- `print(value: String) -> [Io] Unit`
- `println(value: String) -> [Io] Unit`

**Testing:**
- `test.assert_equal(expected: T, actual: T) -> Unit`
- `assert(condition: Bool) -> Unit`

**All builtin functions support named arguments:**
```lx
str.slice(text = "hello", start = 1, end = 4)  // "ell"
math.max(left = 3, right = 8)                   // 8
```

---

## Best Practices for AI Agents

### 1. **Always include type annotations at function boundaries**
Even when types can be inferred, explicit annotations make code self-documenting:
```lx
fn process(items: List<Int>) -> Int {  // Good
  // ...
}
```

### 2. **Use exhaustive pattern matching**
Always handle all cases in `match` expressions:
```lx
match option {
  case Some { value: v } => { /* handle */ }
  case None => { /* handle */ }  // Don't forget this!
}
```

### 3. **Track effects explicitly**
If a function calls another function with effects, it must declare those effects:
```lx
fn save_and_log(user: User) -> [Io, Log] Result<UserId, Error> {
  // Must declare both [Io] and [Log]
}
```

### 4. **Write contracts for critical functions**
Use contracts to document invariants:
```lx
contract fn divide(a: Int, b: Int) -> Int {
  requires b != 0
  ensures result * b <= a
  ensures result * b + b > a
}
```

### 5. **Use actors for mutable state**
Never try to share mutable state between functions. Use actors:
```lx
// Good: mutable state inside actor
actor Counter(initial: Int) {
  state { count: Int }
  on Increment() -> [Concurrent] Unit {
    let count = count + 1
  }
}

// Bad: Don't try global mutable variables (not supported)
```

### 6. **Name test blocks descriptively**
```lx
test string_slicing_edge_cases {
  test.assert_equal(str.slice("", 0, 0), "")
  test.assert_equal(str.slice("x", 0, 1), "x")
}
```

### 7. **Use named arguments for clarity**
Especially with multiple parameters of the same type:
```lx
str.slice(text = input, start = 0, end = 5)  // Clear
math.min(left = x, right = y)                // Clear which is which
```

### 8. **Keep functions small and pure when possible**
Pure functions are easier to test and reason about:
```lx
// Good: pure, testable
fn double(x: Int) -> Int {
  return x * 2
}

// Use effects only when necessary
fn save(x: Int) -> [Io] Unit {
  // I/O operation
}
```

### 9. **Document important functions with structured doc comments**
Use `/// spec:` format for machine-readable documentation:
```lx
/// spec:
///   description: "Clamp a value between min and max bounds."
///   inputs:
///     - value: "The value to clamp"
///     - min: "Minimum allowed value"
///     - max: "Maximum allowed value"
///   outputs:
///     - "Clamped value within [min, max]"
///   laws:
///     - "result >= min"
///     - "result <= max"
fn clamp(value: Int, min: Int, max: Int) -> Int {
  // Implementation
}
```

This documentation is parsed, validated, and available to tooling for:
- Automatic documentation generation
- IDE hover information
- Contract/property test generation
- LLM context for code understanding

> **Recommendation:** It is **strongly encouraged** to use `/// spec:` comments for all exported functions and types. This practice prevents documentation drift (enforced by the compiler) and will enable automatic test generation in the future.

---

## Common Pitfalls

### ❌ Missing return statement
```lx
fn add(x: Int, y: Int) -> Int {
  x + y  // ERROR: must use 'return'
}
```

### ❌ Non-exhaustive match
```lx
match option {
  case Some { value: v } => { return v }
  // ERROR: missing None case
}
```

### ❌ Effect mismatch
```lx
fn pure_function() -> Int {
  print("Hello")  // ERROR: print requires [Io] effect
  return 42
}
```

### ❌ Incorrect variant construction
```lx
let opt = Some { 42 }  // ERROR: must use field name
let opt = Some { value: 42 }  // Correct
```

### ❌ Missing Unit value for empty variants
```lx
let none = None  // ERROR
let none = None {}  // Correct
```

---

## Module System (Basic)

**Import declarations:**
```lx
module examples.main

import examples.math
import examples.utils

fn use_imported() -> Int {
  return math.add(1, 2)
}
```

Module resolution is still basic. Files are resolved by module path (e.g., `examples.math` → `examples/math.lx`).

---

## Error Handling Patterns

Use `Result` type for recoverable errors:

```lx
type Result<T, E> = Ok { value: T } | Error { error: E }

fn safe_divide(a: Int, b: Int) -> Result<Int, String> {
  if b == 0 {
    return Error { error: "Division by zero" }
  } else {
    return Ok { value: a / b }
  }
}

// Use with pattern matching
match safe_divide(10, 2) {
  case Ok { value: result } => {
    // Use result
  }
  case Error { error: msg } => {
    // Handle error
  }
}
```

---

## Quick Reference Card

| Construct | Syntax | Example |
|-----------|--------|---------|
| Module | `module path.name` | `module examples.demo` |
| Comment | `//` or `/* */` or `///` | `// line` or `/* block */` |
| Doc comment | `/// spec:` | `/// spec:\n///   description: "Adds two numbers"` |
| Function | `fn name(params) -> Type { }` | `fn add(x: Int, y: Int) -> Int { return x + y }` |
| Type alias | `type Name = Type` | `type UserId = String` |
| Record | `type Name { fields }` | `type Point { x: Int, y: Int }` |
| Variant | `type Name = V1 \| V2` | `type Option = Some { value: Int } \| None` |
| Variable | `let name = expr` | `let x = 42` |
| If | `if cond { } else { }` | `if x > 0 { "pos" } else { "neg" }` |
| Match | `match expr { case P => { } }` | `match opt { case Some { value: v } => { v } case None => { 0 } }` |
| For | `for item in list { }` | `for x in numbers { print(x) }` |
| Contract | `contract fn name { requires/ensures }` | `contract fn abs(x: Int) -> Int { ensures result >= 0 }` |
| Test | `test name { assertions }` | `test math { test.assert_equal(2 + 2, 4) }` |
| Actor | `actor Name(params) { state { } on Msg { } }` | `actor Counter(init: Int) { state { count: Int } on Inc() { let count = count + 1 } }` |
| Schema | `@version(n) schema Name { fields }` | `@version(1) schema User { id: String }` |

---

## Debugging Checklist

When code doesn't work:

1. **Check types match exactly** - Lx has no implicit conversions
2. **Verify all match cases are covered** - Missing cases cause type errors
3. **Check effect annotations** - Functions must declare all effects they use
4. **Look for missing return statements** - All code paths must return
5. **Verify variant construction** - Must include field names: `Some { value: x }`
6. **Check for missing Unit values** - Empty variants need `{}`: `None {}`
7. **Run typechecker** - Lx catches most errors statically

---

## Example: Complete Program

```lx
module examples.demo

// Type definitions
type Result<T> = Success { value: T } | Failure { message: String }

// Contract
contract fn positive(x: Int) -> Int {
  requires x > 0
  ensures result > 0
}

fn positive(x: Int) -> Int {
  return x
}

// Pure function
fn safe_positive(x: Int) -> Result<Int> {
  if x > 0 {
    return Success { value: x }
  } else {
    return Failure { message: "Not positive" }
  }
}

// Function with effects
fn process_numbers(nums: List<Int>) -> [Io] Unit {
  for n in nums {
    match safe_positive(n) {
      case Success { value: v } => {
        println(str.concat("Positive: ", str.concat(str.from_int(v), "")))
      }
      case Failure { message: msg } => {
        println(str.concat("Error: ", msg))
      }
    }
  }
}

// Tests
test demo_tests {
  test.assert_equal(positive(5), 5)
  
  match safe_positive(10) {
    case Success { value: v } => {
      test.assert_equal(v, 10)
    }
    case Failure { message: _ } => {
      assert(false)  // Should not reach here
    }
  }
}
```

---

## Summary

Lx is designed to be **easy to write correctly** and **hard to break**:
- Explicit over implicit (types, effects, field names)
- Pure by default, effects when needed
- Strong static checking catches errors early
- Regular syntax minimizes surprises
- Actors provide safe concurrency without shared mutable state

When in doubt, prefer **clarity and explicitness** over brevity. The compiler and type system are your allies—use them!
