# Autonomous Development Loop

**Goal:** Pick a task, implement it, verify it, and update status. Repeat.

## 1. PICK
- Read **`STATUS.md`** > "🚀 Next Priority Tasks".
- Select the first unchecked item (Priority 1 > 2 > ...).
- If blocked, move to next.

## 2. PLAN
- **Context:** Read `SPEC.md` (rules), `THOUGHTS.md` (philosophy).
- **Design:** Ensure alignment with "LLM-first" principles (explicit, structured, no UB).

## 3. EXECUTE
Implement in this order (The "Vertical Slice"):
1.  **AST**: `src/ast.ts` (define nodes).
2.  **Grammar**: `grammar/lx.pegjs` (update syntax).
3.  **Typecheck**: `src/typecheck/` (update `types.ts`, `checkers.ts`, `inference.ts`).
4.  **Interpreter**: `src/interpreter/` (update `evaluation.ts`, `runtime.ts`).
5.  **Tooling**: Update `src/formatter.ts` (if syntax changed).

## 4. VERIFY
- **Create Example**: Add `examples/feature_name.lx`.
- **Test**: Run `npm test` (runs all examples).
- **Build**: Run `npm run build` (verifies TS compilation).

## 5. RECORD
- **Update `STATUS.md`**:
    - Mark item as ✅.
    - Update "Overall Progress" %.
    - Add notes to "Recent Work".
    - Add any new "Known Issues".
- **Update `LX_AI_GUIDE.md`**: If a user-facing feature, document it.

## Critical Rules
- **Strict TS**: No `any`. Use `npm run build` to check.
- **No Regressions**: `npm test` must pass.
- **Keep Sync**: `STATUS.md` is the source of truth. Update it immediately after work.
