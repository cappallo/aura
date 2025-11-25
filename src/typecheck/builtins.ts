/**
 * Built-in function type signatures and scalar types.
 * Builtins are implemented in the interpreter but type-checked here.
 */

import {
  BOOL_TYPE,
  INT_TYPE,
  STRING_TYPE,
  UNIT_TYPE,
  InferState,
  TypeConstructor,
  TypeFunction,
  makeActorRefType,
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
  "list.append": {
    arity: 2,
    paramNames: ["list", "item"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      return makeFunctionType([makeListType(element), element], makeListType(element));
    },
  },
  "list.concat": {
    arity: 2,
    paramNames: ["left", "right"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      return makeFunctionType([makeListType(element), makeListType(element)], makeListType(element));
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
    instantiateType: (state) => {
      const messageType = freshTypeVar("ActorMessage", false, state);
      return makeFunctionType([makeActorRefType(messageType)], BOOL_TYPE);
    },
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
  "str.split": {
    arity: 2,
    paramNames: ["text", "delimiter"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE, STRING_TYPE], makeListType(STRING_TYPE)),
  },
  "str.join": {
    arity: 2,
    paramNames: ["list", "delimiter"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([makeListType(STRING_TYPE), STRING_TYPE], STRING_TYPE),
  },
  "str.contains": {
    arity: 2,
    paramNames: ["text", "substring"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE, STRING_TYPE], BOOL_TYPE),
  },
  "str.starts_with": {
    arity: 2,
    paramNames: ["text", "prefix"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE, STRING_TYPE], BOOL_TYPE),
  },
  "str.ends_with": {
    arity: 2,
    paramNames: ["text", "suffix"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE, STRING_TYPE], BOOL_TYPE),
  },
  "str.trim": {
    arity: 1,
    paramNames: ["text"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE], STRING_TYPE),
  },
  "str.to_upper": {
    arity: 1,
    paramNames: ["text"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE], STRING_TYPE),
  },
  "str.to_lower": {
    arity: 1,
    paramNames: ["text"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE], STRING_TYPE),
  },
  "str.replace": {
    arity: 3,
    paramNames: ["text", "pattern", "replacement"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE, STRING_TYPE, STRING_TYPE], STRING_TYPE),
  },
  "str.index_of": {
    arity: 2,
    paramNames: ["text", "substring"],
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE, STRING_TYPE], makeOptionType(INT_TYPE)),
  },
  "list.head": {
    arity: 1,
    paramNames: ["list"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      return makeFunctionType([makeListType(element)], makeOptionType(element));
    },
  },
  "list.tail": {
    arity: 1,
    paramNames: ["list"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      return makeFunctionType([makeListType(element)], makeListType(element));
    },
  },
  "list.take": {
    arity: 2,
    paramNames: ["list", "count"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      return makeFunctionType([makeListType(element), INT_TYPE], makeListType(element));
    },
  },
  "list.drop": {
    arity: 2,
    paramNames: ["list", "count"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      return makeFunctionType([makeListType(element), INT_TYPE], makeListType(element));
    },
  },
  "list.reverse": {
    arity: 1,
    paramNames: ["list"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      return makeFunctionType([makeListType(element)], makeListType(element));
    },
  },
  "list.contains": {
    arity: 2,
    paramNames: ["list", "item"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      return makeFunctionType([makeListType(element), element], BOOL_TYPE);
    },
  },
  "list.find": {
    arity: 2,
    paramNames: ["list", "predicate"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      const fnType = makeFunctionType([element], BOOL_TYPE);
      return makeFunctionType([makeListType(element), fnType], makeOptionType(element));
    },
  },
  "list.flat_map": {
    arity: 2,
    paramNames: ["list", "mapper"],
    effects: new Set(),
    instantiateType: (state) => {
      const inputElem = freshTypeVar("A", false, state);
      const outputElem = freshTypeVar("B", false, state);
      const fnType = makeFunctionType([inputElem], makeListType(outputElem));
      return makeFunctionType([makeListType(inputElem), fnType], makeListType(outputElem));
    },
  },
  "list.zip": {
    arity: 2,
    paramNames: ["left", "right"],
    effects: new Set(),
    instantiateType: (state) => {
      const a = freshTypeVar("A", false, state);
      const b = freshTypeVar("B", false, state);
      // Returns List<{first: A, second: B}> - we'll use a tuple-like record
      const pairType: TypeConstructor = {
        kind: "Constructor",
        name: "Pair",
        args: [a, b],
      };
      return makeFunctionType([makeListType(a), makeListType(b)], makeListType(pairType));
    },
  },
  "list.enumerate": {
    arity: 1,
    paramNames: ["list"],
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      // Returns List<{index: Int, value: T}>
      const indexedType: TypeConstructor = {
        kind: "Constructor",
        name: "Indexed",
        args: [element],
      };
      return makeFunctionType([makeListType(element)], makeListType(indexedType));
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
]);
