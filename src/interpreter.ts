/**
 * Interpreter module for Lx language.
 * 
 * Tree-walking interpreter with support for:
 * - Pure functions with contracts (preconditions/postconditions)
 * - Pattern matching and sum types
 * - Actors with mutable state and message passing
 * - Structured concurrency (async groups)
 * - Property-based testing with shrinking
 * - Deterministic execution modes for testing
 */

export type {
  SchedulerMode,
  Value,
  ActorMessage,
  Runtime,
  RuntimeOptions,
} from "./interpreter/types";
export { ActorInstance } from "./interpreter/actors";
export { buildRuntime, buildMultiModuleRuntime, callFunction, runTests } from "./interpreter/runtime";
export { prettyValue } from "./interpreter/values";
export { RuntimeError } from "./interpreter/errors";
