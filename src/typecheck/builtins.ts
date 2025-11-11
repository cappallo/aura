/**
 * Built-in function type signatures and scalar types.
 * Builtins are implemented in the interpreter but type-checked here.
 */

import {
  BOOL_TYPE,
  INT_TYPE,
  STRING_TYPE,
  UNIT_TYPE,
  ACTOR_REF_TYPE,
  InferState,
  TypeConstructor,
  TypeFunction,
  makeFunctionType,
  makeListType,
  makeOptionType,
  freshTypeVar,
} from "./types";

/** Metadata for a built-in function's type signature */
export type BuiltinFunctionInfo = {
  /** Number of parameters (null for variadic) */
  arity: number | null;
  /** Parameter names for named argument support */
  paramNames: string[];
  /** Effects this builtin may perform */
  effects: Set<string>;
  /** Function to instantiate polymorphic type with fresh type variables */
  instantiateType: (state: InferState) => TypeFunction;
};

/** Registry of all built-in functions with their type signatures */
export const BUILTIN_FUNCTIONS: Record<string, BuiltinFunctionInfo> = {
  "list.len": {
    arity: 1,
    paramNames: ["list"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      return makeFunctionType([makeListType(element)], INT_TYPE);
    },
  },
  "test.assert_equal": {
    arity: 2,
    paramNames: ["expected", "actual"],
    effects: new Set(),
    instantiateType: (state) => {
      const valueType = freshTypeVar("T", false, state);
      return makeFunctionType([valueType, valueType], UNIT_TYPE);
    },
  },
  assert: {
    arity: 1,
    paramNames: ["condition"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([BOOL_TYPE], UNIT_TYPE),
  },
  "str.concat": {
    arity: 2,
    paramNames: ["left", "right"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE, STRING_TYPE], STRING_TYPE),
  },
  __negate: {
    arity: 1,
    paramNames: ["value"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([INT_TYPE], INT_TYPE),
  },
  __not: {
    arity: 1,
    paramNames: ["value"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([BOOL_TYPE], BOOL_TYPE),
  },
  "Log.debug": {
    arity: 2,
    paramNames: ["label", "payload"],
    effects: new Set(["Log"]),
    instantiateType: (state) => {
      const payload = freshTypeVar("Payload", false, state);
      return makeFunctionType([STRING_TYPE, payload], UNIT_TYPE);
    },
  },
  "Log.trace": {
    arity: 2,
    paramNames: ["label", "payload"],
    effects: new Set(["Log"]),
    instantiateType: (state) => {
      const payload = freshTypeVar("Payload", false, state);
      return makeFunctionType([STRING_TYPE, payload], UNIT_TYPE);
    },
  },
  "Concurrent.flush": {
    arity: 0,
    paramNames: [],
    effects: new Set(["Concurrent"]),
    instantiateType: () => makeFunctionType([], INT_TYPE),
  },
  "Concurrent.step": {
    arity: 0,
    paramNames: [],
    effects: new Set(["Concurrent"]),
    instantiateType: () => makeFunctionType([], BOOL_TYPE),
  },
  "Concurrent.stop": {
    arity: 1,
    paramNames: ["actor"],
    effects: new Set(["Concurrent"]),
    instantiateType: () => makeFunctionType([ACTOR_REF_TYPE], BOOL_TYPE),
  },
  "str.len": {
    arity: 1,
    paramNames: ["text"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE], INT_TYPE),
  },
  "str.slice": {
    arity: 3,
    paramNames: ["text", "start", "end"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE, INT_TYPE, INT_TYPE], STRING_TYPE),
  },
  "str.at": {
    arity: 2,
    paramNames: ["text", "index"],
    effects: new Set(),
    instantiateType: (state) => {
      const optionType = makeOptionType(STRING_TYPE);
      return makeFunctionType([STRING_TYPE, INT_TYPE], optionType);
    },
  },
  "math.abs": {
    arity: 1,
    paramNames: ["value"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([INT_TYPE], INT_TYPE),
  },
  "math.min": {
    arity: 2,
    paramNames: ["left", "right"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([INT_TYPE, INT_TYPE], INT_TYPE),
  },
  "math.max": {
    arity: 2,
    paramNames: ["left", "right"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([INT_TYPE, INT_TYPE], INT_TYPE),
  },
  "list.map": {
    arity: 2,
    paramNames: ["list", "mapper"],
    effects: new Set(),
    instantiateType: (state) => {
      const inputElem = freshTypeVar("A", false, state);
      const outputElem = freshTypeVar("B", false, state);
      const fnType = makeFunctionType([inputElem], outputElem);
      return makeFunctionType([makeListType(inputElem), fnType], makeListType(outputElem));
    },
  },
  "list.filter": {
    arity: 2,
    paramNames: ["list", "predicate"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      const fnType = makeFunctionType([element], BOOL_TYPE);
      return makeFunctionType([makeListType(element), fnType], makeListType(element));
    },
  },
  "list.fold": {
    arity: 3,
    paramNames: ["list", "initial", "reducer"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      const accumulator = freshTypeVar("Acc", false, state);
      const fnType = makeFunctionType([accumulator, element], accumulator);
      return makeFunctionType([makeListType(element), accumulator, fnType], accumulator);
    },
  },
  parallel_map: {
    arity: 2,
    paramNames: ["list", "mapper"],
    effects: new Set(),
    instantiateType: (state) => {
      const inputElem = freshTypeVar("A", false, state);
      const outputElem = freshTypeVar("B", false, state);
      const fnType = makeFunctionType([inputElem], outputElem);
      return makeFunctionType([makeListType(inputElem), fnType], makeListType(outputElem));
    },
  },
  parallel_fold: {
    arity: 3,
    paramNames: ["list", "initial", "reducer"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      const accumulator = freshTypeVar("Acc", false, state);
      const fnType = makeFunctionType([accumulator, element], accumulator);
      return makeFunctionType([makeListType(element), accumulator, fnType], accumulator);
    },
  },
  parallel_for_each: {
    arity: 2,
    paramNames: ["list", "action"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      const fnType = makeFunctionType([element], UNIT_TYPE);
      return makeFunctionType([makeListType(element), fnType], UNIT_TYPE);
    },
  },
  "json.encode": {
    arity: 1,
    paramNames: ["value"],
    effects: new Set(),
    instantiateType: (state) => {
      const value = freshTypeVar("T", false, state);
      return makeFunctionType([value], STRING_TYPE);
    },
  },
  "json.decode": {
    arity: 1,
    paramNames: ["text"],
    effects: new Set(),
    instantiateType: (state) => {
      const resultType = freshTypeVar("T", false, state);
      return makeFunctionType([STRING_TYPE], resultType);
    },
  },
};

export const PURE_BUILTIN_FUNCTION_PARAMS: Record<string, string[]> = {
  parallel_map: ["mapper"],
  parallel_fold: ["reducer"],
  parallel_for_each: ["action"],
};

export const BUILTIN_SCALAR_TYPES = new Map<string, TypeConstructor>([
  ["Int", INT_TYPE],
  ["Bool", BOOL_TYPE],
  ["String", STRING_TYPE],
  ["Unit", UNIT_TYPE],
  ["ActorRef", ACTOR_REF_TYPE],
]);
