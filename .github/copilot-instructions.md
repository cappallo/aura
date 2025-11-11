# Copilot Instructions for Lx Development

## Core Workflow

When implementing features for the Lx programming language:

1. **Always consult these documents first:**
   - `STATUS.md` - Current implementation status and next priorities
   - `SPEC.md` - Full language specification (semi-authoritative design)
   - `THOUGHTS.md` - Design philosophy and LLM-first principles
   - `ROADMAP.md` - Implementation strategy and v0.1 scope
   - `CONCURRENCY.md` - Detailed concurrency model (actors, structured async, supervision)

2. **Select the next priority task from STATUS.md**
   - Look under "🚀 Next Priority Tasks"
   - Start with Priority 1 unless blocked
   - Check off subtasks as you complete them

3. **Implementation process:**
   - Update AST definitions in `src/ast.ts` if needed
   - Extend grammar in `grammar/lx.pegjs` for new syntax
   - Update typechecker for new validations:
     - Type definitions: `src/typecheck/types.ts`
     - Built-in functions: `src/typecheck/builtins.ts`
     - Checkers (function/contract/property/schema/actor): `src/typecheck/checkers.ts`
     - Collectors (module info gathering): `src/typecheck/collectors.ts`
     - Type inference: `src/typecheck/inference.ts`
     - Type operations: `src/typecheck/type-ops.ts`
     - Call argument utilities: `src/typecheck/call-utils.ts`
     - Main exports: `src/typecheck/index.ts` (barrel file)
   - Extend interpreter for runtime behavior:
     - Core evaluation logic: `src/interpreter/evaluation.ts`
     - Runtime setup: `src/interpreter/runtime.ts`
     - Type definitions: `src/interpreter/types.ts`
     - Value operations: `src/interpreter/values.ts`
     - Actor system: `src/interpreter/actors.ts`
     - Property testing: `src/interpreter/properties.ts`
     - Main exports: `src/interpreter.ts` (barrel file)
   - Add builtin functions if needed (both in typecheck and interpreter)

4. **Testing requirements:**
   - Create example file in `examples/` demonstrating the feature
   - Add both positive tests (feature works) and negative tests (errors caught)
   - Run `npm test` to verify all existing tests still pass
   - Run `npm run build` to check for compilation errors

5. **After implementation:**
   - Update `STATUS.md`:
     - Move completed items from ❌ to ✅
     - Update progress percentage
     - Check off completed subtasks
     - Add any new known issues discovered
   - Commit changes with descriptive message
   - Move to next priority task

## Key Design Principles (from THOUGHTS.md)

- **Regular, low-context syntax** - No clever tricks, explicit over implicit
- **Pure by default** - Side effects must be explicitly typed
- **Strong, local types** - Type errors point to small regions
- **Contracts as first-class** - Specs live with code
- **Structured errors** - All errors are machine-readable
- **No UB** - Every operation defined or statically rejected
- **LLM-friendly** - Easy to generate, hard to break

## Code Style Guidelines

- Use TypeScript strict mode
- Prefer exhaustive switch statements with explicit default cases
- Add descriptive error messages that include context
- Keep functions small and single-purpose
- Use Map/Set over plain objects for lookups
- Document non-obvious design decisions with comments

## Grammar Guidelines (lx.pegjs)

- Use helper functions (`foldList`, `foldBinary`) for repetitive patterns
- Keep AST node creation explicit (all fields named)
- Add whitespace handling (`__`, `_`, `WSAny`) consistently
- Use `Terminator+` for statement/declaration endings
- Test grammar changes with `npm run gen:parser`

## Typechecker Guidelines

The typechecker is organized into multiple focused modules:

### Module Structure
- **`src/typecheck/types.ts`** - Core type definitions (`TypeCheckError`, `FnSignature`, `TypecheckContext`, `Type`, `InferState`)
- **`src/typecheck/builtins.ts`** - Built-in function definitions and type signatures
- **`src/typecheck/checkers.ts`** - Top-level checkers (`checkFunction`, `checkContract`, `checkProperty`, `checkSchema`, `checkActor`)
- **`src/typecheck/collectors.ts`** - Module information collectors (`collectModuleFunctions`, `collectModuleTypeInfo`, `collectEffects`)
- **`src/typecheck/inference.ts`** - Type inference engine (`inferExpr`, `inferBlock`, `typeCheckFunctionBody`)
- **`src/typecheck/type-ops.ts`** - Type operations (`unify`, `convertTypeExpr`, `resolveVariant`)
- **`src/typecheck/call-utils.ts`** - Call argument validation utilities
- **`src/typecheck/index.ts`** - Barrel export for public API (`typecheckModule`, `typecheckModules`)

### Key Conventions
- Build context (functions, types, effects) in first pass using collectors
- Check bodies in second pass with full context using checkers
- Return structured errors with `{ message: string, loc?: SourceLocation, filePath?: string }`
- Verify effect subsets with `verifyEffectSubset`
- Check exhaustiveness for match statements
- Allow built-in functions via `BUILTIN_FUNCTIONS` map in `builtins.ts`
- Use `InferState` for type inference with unification
- Pass `TypecheckContext` through all checking functions

## Interpreter Guidelines

The interpreter is organized into multiple focused modules:

### Module Structure
- **`src/interpreter/types.ts`** - Core type definitions (`Value`, `Runtime`, `Env`, `EvalResult`)
- **`src/interpreter/values.ts`** - Value construction, comparison, conversion, and defaults
- **`src/interpreter/errors.ts`** - `RuntimeError` class
- **`src/interpreter/evaluation.ts`** - Expression and statement evaluation (`evalExpr`, `evalBlock`, `evalStmt`)
- **`src/interpreter/runtime.ts`** - Runtime setup (`buildRuntime`, `callFunction`, `runTests`)
- **`src/interpreter/actors.ts`** - Actor system (`ActorInstance`, message delivery, scheduling)
- **`src/interpreter/properties.ts`** - Property-based testing (`runProperty`, generation, shrinking)
- **`src/interpreter/rng.ts`** - Seeded RNG for deterministic testing
- **`src/interpreter.ts`** - Barrel export for public API

### Key Conventions
- Use `Value` union type for all runtime values (defined in `types.ts`)
- Return `EvalResult` (value or return) from blocks/statements
- Pass `Runtime` context through all eval functions
- Implement builtins in `evaluation.ts` with parameter metadata in `BUILTIN_PARAM_NAMES`
- Use `RuntimeError` for execution failures (defined in `errors.ts`)
- Support `result` binding in contract `ensures` clauses
- Actor instances receive `evalBlock` as a callback to avoid circular dependencies

## Example Structure

Every new feature should have an example file:

```lx
module examples.feature_name

// Type declarations

// Effect declarations (if needed)

// Function using the feature

// Tests demonstrating the feature
test feature_examples {
  test.assert_equal(...)
}
```

## Module Resolution (Priority 1 - Current Focus)

When implementing module resolution:

- Parse module names from `import` statements (already done)
- Build a dependency graph to detect cycles
- Resolve file paths (`.lx` extension)
- Load and parse imported modules recursively
- Build a global symbol table mapping qualified names to declarations
- Update parser/typechecker to resolve cross-module references
- Test with multi-file examples in `examples/multifile/`

## Common Pitfalls to Avoid

- Don't break existing examples when adding features
- Don't add syntax without updating all three layers (AST, grammar, interpreter)
- Don't forget to check effects when adding builtin functions
- Don't skip typechecker validation even if interpreter works
- Don't use `any` types - make TypeScript help catch bugs

## Questions to Ask Before Implementing

1. Does this match the SPEC.md / THOUGHTS.md / CONCURRENCY.md design?
2. Is this the next priority in STATUS.md?
3. Will this break any existing examples?
4. Can I test this feature in isolation?
5. What error cases need handling?

## After Each Session

Update STATUS.md with:
- What was completed
- What remains
- Any issues discovered
- Progress percentage adjustment
