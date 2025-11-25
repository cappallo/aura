# Why Lx?

You probably don't need another programming language. But your AI might.

Lx is an experimental language designed **for LLMs first, and humans second**.

Most languages (Python, TypeScript, Rust) are designed for human brains:
*   They have "clever" syntax shortcuts.
*   They rely on implicit context and complex scoping rules.
*   They allow "spooky action at a distance" (global mutable state).
*   Their tools output unstructured text logs that LLMs struggle to parse.

Lx flips this. It is designed to be the perfect interface between a human architect and an AI coder.

## 1. It's Hard to Hallucinate
Lx is strict.
*   **No Global State**: Everything is passed explicitly.
*   **No "Undefined Behavior"**: If it compiles, it runs.
*   **Explicit Effects**: You can see exactly which functions perform I/O or concurrency just by looking at the signature.

This constrains the search space for the LLM. It can't "guess" a global variable name because there are none. It can't "forget" to handle an error because the type system forces it.

## 2. The Tooling Speaks "Robot"
Every tool in the Lx chain emits structured JSON, not text.
*   **Compiler Errors**: JSON objects with precise locations and "fix-it" hints.
*   **Runtime Traces**: Full execution logs in JSON, allowing the LLM to "replay" a bug.
*   **AST Input**: You can feed the compiler a JSON AST directly, bypassing syntax errors entirely.

## 3. "DRY" Enforcement
LLMs love to copy-paste. This leads to code drift.
Lx includes a **structural clone detector** that screams if two functions have identical logic, even if the variable names are different. It forces the AI to refactor and abstract, keeping the codebase healthy.

## 4. Deterministic by Default
Debugging concurrency is a nightmare for humans. It's impossible for LLMs.
Lx uses a **deterministic actor model**.
*   You can run a concurrent test 100 times, and it will execute in the exact same order every time.
*   This means if an AI writes a test that fails, it fails *reliably*, allowing the AI to fix it.

## Summary
*   **If you are a human**: Lx feels like a verbose, strict version of Rust or Elm. It might feel tedious.
*   **If you are an AI**: Lx is heaven. Everything is explicit, errors are structured, and the rules never change.

Lx is the language you want your AI agent to write in, so you can trust the result.
