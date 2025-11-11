import * as ast from "../ast";
import { resolveIdentifier } from "../loader";
import {
  InferState,
  RecordTypeInfo,
  Type,
  TypeDeclInfo,
  TypeVar,
  TypecheckContext,
  VariantInfo,
  makeError,
  makeListType,
  makeOptionType,
  freshTypeVar,
  TypeCheckError,
} from "./types";
import { BUILTIN_SCALAR_TYPES } from "./builtins";

/**
 * Find type declaration by name, resolving across module boundaries.
 * Searches local types first, then cross-module via symbol table.
 */
export function findTypeDecl(
  name: string,
  ctx: TypecheckContext,
  module: ast.Module | undefined,
): TypeDeclInfo | undefined {
  if (ctx.typeDecls.has(name)) {
    return ctx.typeDecls.get(name);
  }

  const local = ctx.localTypeDecls.get(name);
  if (local) {
    return local;
  }

  if (module && ctx.symbolTable) {
    const resolved = resolveIdentifier(name, module, ctx.symbolTable);
    return ctx.typeDecls.get(resolved);
  }

  return undefined;
}

/**
 * Resolve record type by name, handling cross-module references.
 */
export function resolveRecordType(name: string, state: InferState): RecordTypeInfo | undefined {
  const direct = state.ctx.recordTypes.get(name);
  if (direct) {
    return direct;
  }

  if (state.ctx.currentModule && state.ctx.symbolTable) {
    const resolved = resolveIdentifier(name, state.ctx.currentModule, state.ctx.symbolTable);
    return state.ctx.recordTypes.get(resolved);
  }

  return undefined;
}

/**
 * Resolve variant constructor by name, handling cross-module references.
 * Reports error if multiple variants with the same name exist (ambiguous).
 */
export function resolveVariant(name: string, state: InferState): VariantInfo | undefined {
  const direct = state.ctx.variantConstructors.get(name);
  if (direct && direct.length === 1) {
    return direct[0];
  }

  if (direct && direct.length > 1) {
    state.errors.push({ message: `Ambiguous constructor '${name}'` });
    return direct[0];
  }

  if (state.ctx.currentModule && state.ctx.symbolTable) {
    const resolved = resolveIdentifier(name, state.ctx.currentModule, state.ctx.symbolTable);
    const resolvedMatch = state.ctx.variantConstructors.get(resolved);
    if (resolvedMatch && resolvedMatch.length > 0) {
      return resolvedMatch[0];
    }
  }

  return undefined;
}

/**
 * Convert AST type expression to internal type representation.
 * Handles type parameters from scope, built-in types, type aliases, and user-defined types.
 * Resolves type constructors and instantiates type parameters.
 */
export function convertTypeExpr(
  typeExpr: ast.TypeExpr,
  scope: Map<string, Type>,
  state: InferState,
  module: ast.Module | undefined,
): Type {
  switch (typeExpr.kind) {
    case "TypeName": {
      const scoped = scope.get(typeExpr.name);
      if (scoped) {
        return scoped;
      }

      const builtinScalar = BUILTIN_SCALAR_TYPES.get(typeExpr.name);
      if (builtinScalar && typeExpr.typeArgs.length === 0) {
        return builtinScalar;
      }

      if (typeExpr.name === "List") {
        if (typeExpr.typeArgs.length !== 1) {
          state.errors.push({ message: "List expects exactly one type argument" });
          return makeListType(freshTypeVar("ListElem", false, state));
        }
        const inner = convertTypeExpr(typeExpr.typeArgs[0]!, scope, state, module);
        return makeListType(inner);
      }

      if (typeExpr.name === "Option") {
        if (typeExpr.typeArgs.length !== 1) {
          state.errors.push({ message: "Option expects exactly one type argument" });
          return makeOptionType(freshTypeVar("OptionElem", false, state));
        }
        const inner = convertTypeExpr(typeExpr.typeArgs[0]!, scope, state, module);
        return makeOptionType(inner);
      }

      const declInfo = findTypeDecl(typeExpr.name, state.ctx, module);
      if (!declInfo) {
        state.errors.push({
          message: `Unknown type '${typeExpr.name}' in function '${state.currentFunction.name}'`,
        });
        return freshTypeVar(typeExpr.name, false, state);
      }

      if (declInfo.decl.kind === "AliasTypeDecl") {
        const aliasDecl = declInfo.decl;
        if (aliasDecl.typeParams.length !== typeExpr.typeArgs.length) {
          state.errors.push({
            message: `Type alias '${aliasDecl.name}' expects ${aliasDecl.typeParams.length} type arguments`,
          });
        }
        const aliasScope = new Map(scope);
        aliasDecl.typeParams.forEach((paramName, index) => {
          const argExpr = typeExpr.typeArgs[index];
          const argType = argExpr
            ? convertTypeExpr(argExpr, scope, state, declInfo.module)
            : freshTypeVar(paramName, false, state);
          aliasScope.set(paramName, argType);
        });
        return convertTypeExpr(aliasDecl.target, aliasScope, state, declInfo.module);
      }

      if (declInfo.decl.kind === "RecordTypeDecl" || declInfo.decl.kind === "SumTypeDecl") {
        const expectedArgs = declInfo.typeParams.length;
        if (expectedArgs !== typeExpr.typeArgs.length) {
          state.errors.push({
            message: `Type '${declInfo.name}' expects ${expectedArgs} type arguments`,
          });
        }
        const args = declInfo.typeParams.map((paramName, index) => {
          const argExpr = typeExpr.typeArgs[index];
          return argExpr
            ? convertTypeExpr(argExpr, scope, state, declInfo.module)
            : freshTypeVar(paramName, false, state);
        });
        return { kind: "Constructor", name: declInfo.qualifiedName, args };
      }

      return freshTypeVar(typeExpr.name, false, state);
    }
    case "OptionalType": {
      const inner = convertTypeExpr(typeExpr.inner, scope, state, module);
      return makeOptionType(inner);
    }
    default: {
      const exhaustive: never = typeExpr;
      throw new Error(`Unsupported type expression kind: ${(exhaustive as ast.TypeExpr).kind}`);
    }
  }
}

/**
 * Follow substitution chains to find the concrete type for a type variable.
 * Path compression optimization: updates substitution map with shortened paths.
 */
export function prune(type: Type, state: InferState): Type {
  if (type.kind === "Var") {
    const replacement = state.substitutions.get(type.id);
    if (replacement) {
      const pruned = prune(replacement, state);
      state.substitutions.set(type.id, pruned);
      return pruned;
    }
  }
  return type;
}

/**
 * Apply accumulated substitutions throughout a type, recursively.
 * Returns a type with all type variables replaced by their concrete types.
 */
export function applySubstitution(type: Type, state: InferState): Type {
  const pruned = prune(type, state);
  if (pruned.kind === "Constructor") {
    return {
      kind: "Constructor",
      name: pruned.name,
      args: pruned.args.map((arg) => applySubstitution(arg, state)),
    };
  }
  if (pruned.kind === "Function") {
    return {
      kind: "Function",
      params: pruned.params.map((param) => applySubstitution(param, state)),
      returnType: applySubstitution(pruned.returnType, state),
    };
  }
  return pruned;
}

/**
 * Check if a type variable occurs within a type (occurs check).
 * Prevents infinite types like t = List<t>.
 */
function occursInType(typeVar: TypeVar, type: Type, state: InferState): boolean {
  const target = prune(type, state);
  if (target.kind === "Var") {
    return target.id === typeVar.id;
  }
  if (target.kind === "Constructor") {
    return target.args.some((arg) => occursInType(typeVar, arg, state));
  }
  if (target.kind === "Function") {
    return (
      target.params.some((param) => occursInType(typeVar, param, state)) ||
      occursInType(typeVar, target.returnType, state)
    );
  }
  return false;
}

/**
 * Unify two types using Hindley-Milner algorithm.
 * Mutates state.substitutions to record type variable bindings.
 * Reports errors for type mismatches, occurs check violations, and rigid type variable conflicts.
 */
export function unify(
  left: Type,
  right: Type,
  state: InferState,
  context?: string,
  loc?: ast.SourceLocation,
): void {
  const a = prune(left, state);
  const b = prune(right, state);

  if (a === b) {
    return;
  }

  if (a.kind === "Var") {
    if (b.kind === "Var" && a.id === b.id) {
      return;
    }
    if (a.rigid) {
      reportUnificationError(a, b, state, context ?? "Cannot unify rigid type variable", loc);
      return;
    }
    if (occursInType(a, b, state)) {
      reportUnificationError(a, b, state, context ?? "Occurs check failed", loc);
      return;
    }
    state.substitutions.set(a.id, b);
    return;
  }

  if (b.kind === "Var") {
    unify(b, a, state, context, loc);
    return;
  }

  if (a.kind === "Constructor" && b.kind === "Constructor") {
    if (a.name !== b.name || a.args.length !== b.args.length) {
      reportUnificationError(a, b, state, context ?? "Type constructor mismatch", loc);
      return;
    }
    for (let i = 0; i < a.args.length; i += 1) {
      unify(a.args[i]!, b.args[i]!, state, context, loc);
    }
    return;
  }

  if (a.kind === "Function" && b.kind === "Function") {
    if (a.params.length !== b.params.length) {
      reportUnificationError(a, b, state, context ?? "Function arity mismatch", loc);
      return;
    }
    for (let i = 0; i < a.params.length; i += 1) {
      unify(a.params[i]!, b.params[i]!, state, context, loc);
    }
    unify(a.returnType, b.returnType, state, context, loc);
    return;
  }

  reportUnificationError(a, b, state, context ?? "Type mismatch", loc);
}

/** Convert type to human-readable string for error messages */
function typeToString(type: Type): string {
  switch (type.kind) {
    case "Var":
      return type.name ?? `t${type.id}`;
    case "Constructor":
      if (type.args.length === 0) {
        return type.name;
      }
      return `${type.name}<${type.args.map((arg) => typeToString(arg)).join(", ")}>`;
    case "Function":
      return `(${type.params.map((param) => typeToString(param)).join(", ")}) -> ${typeToString(type.returnType)}`;
    default: {
      const exhaustive: never = type;
      return (exhaustive as Type).kind;
    }
  }
}

/** Report a unification failure with formatted type strings */
function reportUnificationError(
  left: Type,
  right: Type,
  state: InferState,
  context: string,
  loc?: ast.SourceLocation,
): void {
  const leftStr = typeToString(applySubstitution(left, state));
  const rightStr = typeToString(applySubstitution(right, state));
  state.errors.push(makeError(`${context}: ${leftStr} vs ${rightStr}`, loc, state.currentFilePath));
}

/**
 * Check that a match expression covers all variants of a sum type.
 * Reports error if non-exhaustive (missing variants without a wildcard catch-all).
 */
export function checkMatchExhaustiveness(
  stmt: ast.MatchStmt,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
): void {
  const coveredCtors = new Set<string>();
  let hasWildcard = false;

  for (const matchCase of stmt.cases) {
    if (matchCase.pattern.kind === "WildcardPattern") {
      hasWildcard = true;
    } else if (matchCase.pattern.kind === "CtorPattern") {
      coveredCtors.add(matchCase.pattern.ctorName);
    } else if (matchCase.pattern.kind === "VarPattern") {
      hasWildcard = true;
    }
  }

  if (hasWildcard) {
    return;
  }

  for (const matchCase of stmt.cases) {
    if (matchCase.pattern.kind === "CtorPattern") {
      const ctorName = matchCase.pattern.ctorName;

      for (const [typeName, typeInfo] of ctx.sumTypes.entries()) {
        if (typeInfo.variants.has(ctorName)) {
          const uncoveredVariants: string[] = [];
          for (const variantName of typeInfo.variants.keys()) {
            if (!coveredCtors.has(variantName)) {
              uncoveredVariants.push(variantName);
            }
          }

          if (uncoveredVariants.length > 0) {
            errors.push({
              message: `Non-exhaustive match on type '${typeName}': missing cases for ${uncoveredVariants.join(", ")}`,
            });
          }
          return;
        }
      }
    }
  }
}
