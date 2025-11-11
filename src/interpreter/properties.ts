import * as ast from "../ast";
import { Env, EvalResult, Runtime, RuntimeError, TestOutcome } from "./context";
import { Value, makeActorRefValue, makeCtor, prettyValue } from "./values";

export const DEFAULT_PROPERTY_RUNS = 50;
const MAX_SHRINK_ATTEMPTS = 100;
const MAX_GENERATION_ATTEMPTS = 100;
const MAX_GENERATION_DEPTH = 4;
const RANDOM_STRING_CHARS = "abcdefghijklmnopqrstuvwxyz";

export type PropertyEvaluationHelpers = {
  evalBlock: (block: ast.Block, env: Env, runtime: Runtime) => EvalResult;
  evalExpr: (expr: ast.Expr, env: Env, runtime: Runtime) => Value;
};

type ParameterGenerationResult =
  | { success: true }
  | { success: false; paramName: string; message: string; cause?: unknown };

export function runProperty(
  property: ast.PropertyDecl,
  runtime: Runtime,
  helpers: PropertyEvaluationHelpers,
): TestOutcome {
  const iterations = property.iterations ?? DEFAULT_PROPERTY_RUNS;
  const rng = runtime.rng ? () => runtime.rng!.next() : () => Math.random();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const env: Env = new Map();
    const generation = generateParametersForProperty(property, env, runtime, rng, helpers);
    if (!generation.success) {
      const snapshot = snapshotEnv(env);
      const parts: string[] = [
        `Property '${property.name}' could not generate value for parameter '${generation.paramName}': ${generation.message}`,
      ];
      if (generation.cause) {
        const causeMessage = generation.cause instanceof Error ? generation.cause.message : String(generation.cause);
        parts.push(`Cause: ${causeMessage}`);
      }
      if (Object.keys(snapshot).length > 0) {
        parts.push(`Bound inputs: ${JSON.stringify(snapshot)}`);
      }
      return {
        kind: "property",
        name: property.name,
        success: false,
        error: new RuntimeError(parts.join(" ")),
      };
    }

    try {
      const result = helpers.evalBlock(property.body, new Map(env), runtime);
      if (result.type === "return" && result.value.kind !== "Unit") {
        const shrunkEnv = shrinkCounterexample(property, env, runtime, helpers);
        return {
          kind: "property",
          name: property.name,
          success: false,
          error: propertyFailureError(
            property.name,
            iteration,
            shrunkEnv,
            "Properties must not return non-unit values",
          ),
        };
      }
    } catch (error) {
      const shrunkEnv = shrinkCounterexample(property, env, runtime, helpers);
      return {
        kind: "property",
        name: property.name,
        success: false,
        error: propertyFailureError(property.name, iteration, shrunkEnv, error),
      };
    }
  }

  return { kind: "property", name: property.name, success: true };
}

function generateParametersForProperty(
  property: ast.PropertyDecl,
  env: Env,
  runtime: Runtime,
  rng: () => number,
  helpers: PropertyEvaluationHelpers,
): ParameterGenerationResult {
  for (const param of property.params) {
    const result = tryGenerateParameter(param, env, runtime, rng, helpers);
    if (!result.success) {
      return result;
    }
  }
  return { success: true };
}

function tryGenerateParameter(
  param: ast.PropertyParam,
  env: Env,
  runtime: Runtime,
  rng: () => number,
  helpers: PropertyEvaluationHelpers,
): ParameterGenerationResult {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const candidate = generateValueForTypeExpr(param.type, runtime, 0, rng);
    env.set(param.name, candidate);

    if (!param.predicate) {
      return { success: true };
    }

    let predicateValue: Value;
    try {
      predicateValue = helpers.evalExpr(param.predicate, env, runtime);
    } catch (error) {
      return {
        success: false,
        paramName: param.name,
        message: "error evaluating predicate",
        cause: error,
      };
    }

    if (predicateValue.kind !== "Bool") {
      return {
        success: false,
        paramName: param.name,
        message: "predicate must evaluate to a boolean value",
      };
    }

    if (predicateValue.value) {
      return { success: true };
    }

    env.delete(param.name);
  }

  return {
    success: false,
    paramName: param.name,
    message: `predicate remained unsatisfied after ${MAX_GENERATION_ATTEMPTS} attempts`,
  };
}

function propertyFailureError(
  propertyName: string,
  iteration: number,
  env: Env,
  cause: unknown,
): RuntimeError {
  const snapshot = snapshotEnv(env);
  const serializedInputs = JSON.stringify(snapshot);
  const causeMessage =
    cause instanceof RuntimeError || cause instanceof Error ? cause.message : String(cause);
  return new RuntimeError(
    `Property '${propertyName}' failed on iteration ${iteration + 1} with input ${serializedInputs}: ${causeMessage}`,
  );
}

function snapshotEnv(env: Env): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [name, value] of env.entries()) {
    obj[name] = prettyValue(value);
  }
  return obj;
}

function generateValueForTypeExpr(
  typeExpr: ast.TypeExpr,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  if (depth > MAX_GENERATION_DEPTH) {
    return defaultValueForType(typeExpr, runtime);
  }

  if (typeExpr.kind === "OptionalType") {
    return generateOptionalValue(typeExpr, runtime, depth, rng);
  }

  if (typeExpr.kind === "TypeName") {
    return generateFromTypeName(typeExpr, runtime, depth, rng);
  }

  return { kind: "Unit" };
}

function generateFromTypeName(
  typeExpr: Extract<ast.TypeExpr, { kind: "TypeName" }>,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  if (typeExpr.typeArgs.length === 0) {
    switch (typeExpr.name) {
      case "Int":
        return { kind: "Int", value: randomInt(rng) };
      case "Bool":
        return { kind: "Bool", value: randomBool(rng) };
      case "String":
        return { kind: "String", value: randomString(rng) };
      case "Unit":
        return { kind: "Unit" };
      case "ActorRef":
        return makeActorRefValue(-1);
      default:
        break;
    }
  }

  if (typeExpr.name === "List") {
    const elementType = typeExpr.typeArgs[0] ?? { kind: "TypeName", name: "Int", typeArgs: [] };
    return generateListValue(elementType, runtime, depth, rng);
  }

  if (typeExpr.name === "Option" && typeExpr.typeArgs.length === 1) {
    const inner = typeExpr.typeArgs[0]!;
    return generateOptionalValue({ kind: "OptionalType", inner }, runtime, depth, rng);
  }

  const decl = findTypeDecl(runtime, typeExpr.name);
  if (!decl) {
    return { kind: "Unit" };
  }

  switch (decl.kind) {
    case "AliasTypeDecl": {
      const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
      const target = substituteTypeExpr(decl.target, substitutions);
      return generateValueForTypeExpr(target, runtime, depth + 1, rng);
    }
    case "RecordTypeDecl":
      return generateRecordValue(decl, typeExpr, runtime, depth, rng);
    case "SumTypeDecl":
      return generateSumValue(decl, typeExpr, runtime, depth, rng);
    default:
      return { kind: "Unit" };
  }
}

function generateRecordValue(
  decl: ast.RecordTypeDecl,
  typeExpr: Extract<ast.TypeExpr, { kind: "TypeName" }>,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
  const fields = new Map<string, Value>();
  for (const field of decl.fields) {
    const fieldType = substituteTypeExpr(field.type, substitutions);
    const value = generateValueForTypeExpr(fieldType, runtime, depth + 1, rng);
    fields.set(field.name, value);
  }
  return { kind: "Ctor", name: decl.name, fields };
}

function generateSumValue(
  decl: ast.SumTypeDecl,
  typeExpr: Extract<ast.TypeExpr, { kind: "TypeName" }>,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  if (decl.variants.length === 0) {
    return { kind: "Unit" };
  }

  const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
  let variant: ast.Variant;
  if (depth >= MAX_GENERATION_DEPTH) {
    variant = decl.variants.find((candidate) => candidate.fields.length === 0) ?? decl.variants[0]!;
  } else {
    const index = Math.floor(rng() * decl.variants.length);
    variant = decl.variants[index] ?? decl.variants[0]!;
  }

  const fields = new Map<string, Value>();
  for (const field of variant.fields) {
    const fieldType = substituteTypeExpr(field.type, substitutions);
    const value = generateValueForTypeExpr(fieldType, runtime, depth + 1, rng);
    fields.set(field.name, value);
  }

  return { kind: "Ctor", name: variant.name, fields };
}

function generateListValue(
  elementType: ast.TypeExpr,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  const maxLength = depth >= MAX_GENERATION_DEPTH ? 0 : 3;
  const length = maxLength === 0 ? 0 : Math.floor(rng() * (maxLength + 1));
  const elements: Value[] = [];
  for (let i = 0; i < length; i += 1) {
    elements.push(generateValueForTypeExpr(elementType, runtime, depth + 1, rng));
  }
  return { kind: "List", elements };
}

function generateOptionalValue(
  typeExpr: Extract<ast.TypeExpr, { kind: "OptionalType" }>,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  if (depth >= MAX_GENERATION_DEPTH || rng() < 0.3) {
    return makeCtor("None");
  }
  const value = generateValueForTypeExpr(typeExpr.inner, runtime, depth + 1, rng);
  return makeCtor("Some", [["value", value]]);
}

function shrinkValue(value: Value): Value[] {
  switch (value.kind) {
    case "Int":
      return shrinkInt(value.value);
    case "String":
      return shrinkString(value.value);
    case "List":
      return shrinkList(value.elements);
    case "Bool":
      return value.value ? [{ kind: "Bool", value: false }] : [];
    case "Ctor":
      return shrinkCtor(value);
    case "ActorRef":
      return [];
    case "Unit":
      return [];
  }
}

function shrinkInt(n: number): Value[] {
  const candidates: Value[] = [];

  if (n !== 0) {
    candidates.push({ kind: "Int", value: 0 });
  }

  if (Math.abs(n) > 1) {
    const half = Math.floor(n / 2);
    candidates.push({ kind: "Int", value: half });
  }

  if (n > 0) {
    candidates.push({ kind: "Int", value: n - 1 });
  } else if (n < 0) {
    candidates.push({ kind: "Int", value: n + 1 });
  }

  return candidates;
}

function shrinkString(s: string): Value[] {
  const candidates: Value[] = [];

  if (s.length > 0) {
    candidates.push({ kind: "String", value: "" });
  }

  if (s.length > 1) {
    const half = s.slice(0, Math.floor(s.length / 2));
    candidates.push({ kind: "String", value: half });
  }

  for (let i = 0; i < s.length && candidates.length < 10; i += 1) {
    const withoutChar = s.slice(0, i) + s.slice(i + 1);
    candidates.push({ kind: "String", value: withoutChar });
  }

  return candidates;
}

function shrinkList(elements: Value[]): Value[] {
  const candidates: Value[] = [];

  if (elements.length > 0) {
    candidates.push({ kind: "List", elements: [] });
  }

  if (elements.length > 2) {
    const mid = Math.floor(elements.length / 2);
    candidates.push({ kind: "List", elements: elements.slice(0, mid) });
  }

  for (let i = 0; i < elements.length && candidates.length < 10; i += 1) {
    const shrunk = shrinkValue(elements[i]!);
    for (const smaller of shrunk) {
      const newElements = [...elements];
      newElements[i] = smaller;
      candidates.push({ kind: "List", elements: newElements });
    }
  }

  return candidates;
}

function shrinkCtor(value: Value & { kind: "Ctor" }): Value[] {
  const candidates: Value[] = [];

  if (value.name === "Some") {
    candidates.push(makeCtor("None"));
    const wrappedValue = value.fields.get("value");
    if (wrappedValue) {
      const shrunk = shrinkValue(wrappedValue);
      for (const smaller of shrunk) {
        candidates.push(makeCtor("Some", [["value", smaller]]));
      }
    }
  }

  const fieldEntries = Array.from(value.fields.entries());
  for (let i = 0; i < fieldEntries.length && candidates.length < 10; i += 1) {
    const [fieldName, fieldValue] = fieldEntries[i]!;
    const shrunk = shrinkValue(fieldValue);
    for (const smaller of shrunk) {
      const newFields = new Map(value.fields);
      newFields.set(fieldName, smaller);
      candidates.push({ kind: "Ctor", name: value.name, fields: newFields });
    }
  }

  return candidates;
}

function shrinkCounterexample(
  property: ast.PropertyDecl,
  failingEnv: Env,
  runtime: Runtime,
  helpers: PropertyEvaluationHelpers,
): Env {
  let currentEnv = new Map(failingEnv);
  let improved = true;
  let attempts = 0;

  while (improved && attempts < MAX_SHRINK_ATTEMPTS) {
    improved = false;
    attempts += 1;

    for (const param of property.params) {
      const currentValue = currentEnv.get(param.name);
      if (!currentValue) continue;

      const candidates = shrinkValue(currentValue);

      for (const candidate of candidates) {
        const testEnv = new Map(currentEnv);
        testEnv.set(param.name, candidate);

        if (param.predicate) {
          try {
            const predicateValue = helpers.evalExpr(param.predicate, testEnv, runtime);
            if (predicateValue.kind !== "Bool" || !predicateValue.value) {
              continue;
            }
          } catch {
            continue;
          }
        }

        try {
          const result = helpers.evalBlock(property.body, new Map(testEnv), runtime);
          if (result.type === "return" && result.value.kind !== "Unit") {
            currentEnv = testEnv;
            improved = true;
            break;
          }
        } catch {
          currentEnv = testEnv;
          improved = true;
          break;
        }
      }

      if (improved) break;
    }
  }

  return currentEnv;
}

function randomInt(rng: () => number): number {
  return Math.floor(rng() * 41) - 20;
}

function randomBool(rng: () => number): boolean {
  return rng() < 0.5;
}

function randomString(rng: () => number): string {
  const length = Math.floor(rng() * 6);
  let result = "";
  for (let i = 0; i < length; i += 1) {
    const index = Math.floor(rng() * RANDOM_STRING_CHARS.length);
    result += RANDOM_STRING_CHARS[index] ?? "a";
  }
  return result;
}

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

function findTypeDecl(runtime: Runtime, name: string): ast.TypeDecl | undefined {
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

function buildTypeArgMap(params: string[], args: ast.TypeExpr[]): Map<string, ast.TypeExpr> {
  const map = new Map<string, ast.TypeExpr>();
  for (let i = 0; i < params.length; i += 1) {
    const paramName = params[i]!;
    const arg = args[i] ?? { kind: "TypeName", name: "Int", typeArgs: [] };
    map.set(paramName, arg);
  }
  return map;
}

function substituteTypeExpr(
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
