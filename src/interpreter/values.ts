import * as ast from "../ast";
import { Runtime, Value } from "./types";

const RANDOM_STRING_CHARS = "abcdefghijklmnopqrstuvwxyz";

/** Construct an Int value (identity if already a Value) */
export function makeInt(value: number | Value): Value {
  if (typeof value === "number") {
    return { kind: "Int", value };
  }
  return value;
}

/** Construct a Bool value */
export function makeBool(value: boolean): Value {
  return { kind: "Bool", value };
}

/** Construct a constructor value (record or variant) with named fields */
export function makeCtor(name: string, entries?: [string, Value][]): Value {
  const fields = new Map<string, Value>();
  if (entries) {
    for (const [fieldName, fieldValue] of entries) {
      fields.set(fieldName, fieldValue);
    }
  }
  return { kind: "Ctor", name, fields };
}

/** Construct an ActorRef value */
export function makeActorRefValue(id: number): Value {
  return { kind: "ActorRef", id };
}

/** Structural equality comparison for values */
export function valueEquals(a: Value, b: Value): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "Int":
    case "Bool":
    case "String":
      return a.value === (b as typeof a).value;
    case "Unit":
      return true;
    case "List": {
      const bb = b as typeof a;
      if (a.elements.length !== bb.elements.length) {
        return false;
      }
      for (let i = 0; i < a.elements.length; i += 1) {
        const left = a.elements[i];
        const right = bb.elements[i];
        if (left === undefined || right === undefined || !valueEquals(left, right)) {
          return false;
        }
      }
      return true;
    }
    case "Ctor": {
      const bb = b as typeof a;
      if (a.name !== bb.name || a.fields.size !== bb.fields.size) {
        return false;
      }
      for (const [key, val] of a.fields.entries()) {
        const other = bb.fields.get(key);
        if (!other || !valueEquals(val, other)) {
          return false;
        }
      }
      return true;
    }
    case "ActorRef": {
      const bb = b as typeof a;
      return a.id === bb.id;
    }
    default:
      return false;
  }
}

/** Convert value to JSON-serializable representation for display */
export function prettyValue(value: Value): unknown {
  switch (value.kind) {
    case "Int":
    case "Bool":
    case "String":
      return value.value;
    case "Unit":
      return null;
    case "List":
      return value.elements.map((element) => prettyValue(element));
    case "Ctor": {
      const obj: Record<string, unknown> = {};
      for (const [key, fieldValue] of value.fields.entries()) {
        obj[key] = prettyValue(fieldValue);
      }
      return { [value.name]: obj };
    }
    case "ActorRef":
      return { ActorRef: value.id };
    default:
      return null;
  }
}

/** Convert Lx value to JavaScript value (for JSON encoding) */
export function valueToJsValue(value: Value): unknown {
  switch (value.kind) {
    case "Int":
    case "Bool":
    case "String":
      return value.value;
    case "Unit":
      return null;
    case "List":
      return value.elements.map(valueToJsValue);
    case "Ctor": {
      const obj: Record<string, unknown> = { _constructor: value.name };
      for (const [fieldName, fieldValue] of value.fields.entries()) {
        obj[fieldName] = valueToJsValue(fieldValue);
      }
      return obj;
    }
    default:
      return null;
  }
}

/** Convert JavaScript value to Lx value (for JSON decoding) */
export function jsValueToValue(jsValue: unknown): Value {
  if (jsValue === null || jsValue === undefined) {
    return { kind: "Unit" };
  }
  if (typeof jsValue === "number") {
    return { kind: "Int", value: Math.floor(jsValue) };
  }
  if (typeof jsValue === "boolean") {
    return { kind: "Bool", value: jsValue };
  }
  if (typeof jsValue === "string") {
    return { kind: "String", value: jsValue };
  }
  if (Array.isArray(jsValue)) {
    return { kind: "List", elements: jsValue.map(jsValueToValue) };
  }
  if (typeof jsValue === "object") {
    const obj = jsValue as Record<string, unknown>;
    const constructor = obj._constructor;
    if (typeof constructor === "string") {
      const fields = new Map<string, Value>();
      for (const [key, val] of Object.entries(obj)) {
        if (key !== "_constructor") {
          fields.set(key, jsValueToValue(val));
        }
      }
      return { kind: "Ctor", name: constructor, fields };
    }
    const fields = new Map<string, Value>();
    for (const [key, val] of Object.entries(obj)) {
      fields.set(key, jsValueToValue(val));
    }
    return { kind: "Ctor", name: "Object", fields };
  }
  return { kind: "Unit" };
}

/** Generate default value for a type (used for actor state initialization) */
export function defaultValueForType(typeExpr: ast.TypeExpr, runtime: Runtime): Value {
  if (typeExpr.kind === "OptionalType") {
    return makeCtor("None");
  }

  if (typeExpr.kind === "TypeName") {
    switch (typeExpr.name) {
      case "Int":
        return { kind: "Int", value: 0 };
      case "Bool":
        return { kind: "Bool", value: false };
      case "String":
        return { kind: "String", value: "" };
      case "Unit":
        return { kind: "Unit" };
      case "ActorRef":
        return makeActorRefValue(-1);
      case "List":
        return { kind: "List", elements: [] };
      default:
        break;
    }

    const decl = findTypeDecl(runtime, typeExpr.name);
    if (!decl) {
      return { kind: "Unit" };
    }

    if (decl.kind === "AliasTypeDecl") {
      const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
      const target = substituteTypeExpr(decl.target, substitutions);
      return defaultValueForType(target, runtime);
    }

    if (decl.kind === "RecordTypeDecl") {
      const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
      const fields = new Map<string, Value>();
      for (const field of decl.fields) {
        const fieldType = substituteTypeExpr(field.type, substitutions);
        fields.set(field.name, defaultValueForType(fieldType, runtime));
      }
      return { kind: "Ctor", name: decl.name, fields };
    }

    if (decl.kind === "SumTypeDecl") {
      const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
      const variant = decl.variants.find((candidate) => candidate.fields.length === 0) ?? decl.variants[0];
      if (!variant) {
        return { kind: "Unit" };
      }
      const fields = new Map<string, Value>();
      for (const field of variant.fields) {
        const fieldType = substituteTypeExpr(field.type, substitutions);
        fields.set(field.name, defaultValueForType(fieldType, runtime));
      }
      return { kind: "Ctor", name: variant.name, fields };
    }
  }

  return { kind: "Unit" };
}

export function findTypeDecl(runtime: Runtime, name: string): ast.TypeDecl | undefined {
  if (runtime.typeDecls.has(name)) {
    return runtime.typeDecls.get(name);
  }
  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("../loader");
    const qualified = resolveIdentifier(name, runtime.module, runtime.symbolTable);
    return runtime.typeDecls.get(qualified);
  }
  return undefined;
}

export function buildTypeArgMap(params: string[], args: ast.TypeExpr[]): Map<string, ast.TypeExpr> {
  const map = new Map<string, ast.TypeExpr>();
  for (let i = 0; i < params.length; i += 1) {
    const paramName = params[i]!;
    const arg = args[i] ?? { kind: "TypeName", name: "Int", typeArgs: [] };
    map.set(paramName, arg);
  }
  return map;
}

export function substituteTypeExpr(
  typeExpr: ast.TypeExpr,
  substitutions: Map<string, ast.TypeExpr>,
  depth = 0,
): ast.TypeExpr {
  if (depth > 10) {
    return typeExpr;
  }

  if (typeExpr.kind === "TypeName") {
    if (typeExpr.typeArgs.length > 0) {
      return {
        kind: "TypeName",
        name: typeExpr.name,
        typeArgs: typeExpr.typeArgs.map((arg) => substituteTypeExpr(arg, substitutions, depth + 1)),
      };
    }
    const replacement = substitutions.get(typeExpr.name);
    if (replacement) {
      return substituteTypeExpr(replacement, substitutions, depth + 1);
    }
    return typeExpr;
  }

  if (typeExpr.kind === "OptionalType") {
    return {
      kind: "OptionalType",
      inner: substituteTypeExpr(typeExpr.inner, substitutions, depth + 1),
    };
  }

  return typeExpr;
}

/** Generate random integer in range [-20, 20] for property testing */
export function randomInt(rng: () => number): number {
  return Math.floor(rng() * 41) - 20;
}

/** Generate random boolean for property testing */
export function randomBool(rng: () => number): boolean {
  return rng() < 0.5;
}

/** Generate random string (0-5 chars) for property testing */
export function randomString(rng: () => number): string {
  const length = Math.floor(rng() * 6);
  let result = "";
  for (let i = 0; i < length; i += 1) {
    const index = Math.floor(rng() * RANDOM_STRING_CHARS.length);
    result += RANDOM_STRING_CHARS[index] ?? "a";
  }
  return result;
}
