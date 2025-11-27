import * as ast from "../ast";
import { alignCallArguments } from "../callargs";
import { resolveIdentifier } from "../loader";
import {
  BOOL_TYPE,
  INT_TYPE,
  STRING_TYPE,
  UNIT_TYPE,
  FnSignature,
  InferState,
  Type,
  TypeCheckError,
  TypeEnv,
  TypeFunction,
  TypecheckContext,
  makeActorRefType,
  makeError,
  makeFunctionType,
  makeListType,
  freshTypeVar,
} from "./types";
import { BUILTIN_FUNCTIONS, PURE_BUILTIN_FUNCTION_PARAMS } from "./builtins";
import {
  applySubstitution,
  checkMatchExhaustiveness,
  convertTypeExpr,
  resolveRecordType,
  resolveVariant,
  unify,
} from "./type-ops";
import { getAlignedArgument, reportCallArgIssues, verifyEffectSubset } from "./call-utils";

/** Result of type checking a block of statements */
export type BlockResult = {
  /** Type of the block's final value */
  valueType: Type;
  /** Whether block contains an early return */
  returned: boolean;
};

/** Result of type checking a single statement */
export type StatementResult = {
  /** Type produced by the statement */
  valueType: Type;
  /** Whether statement performed an early return */
  returned: boolean;
};

/** Options controlling block type checking behavior */
export type BlockOptions = {
  /** Expected type for return statements in this block */
  expectedReturnType: Type;
  /** Whether block is used as an expression (last value matters) */
  treatAsExpression: boolean;
  /** Whether to clone environment before checking (for scoping) */
  cloneEnv?: boolean;
};

/**
 * Type check a function body with parameter and return type constraints.
 * Sets up type parameter scope and environment, then infers block types.
 */
export function typeCheckFunctionBody(
  fn: ast.FnDecl,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  filePath?: string,
): void {
  const typeParamScope = new Map<string, Type>();
  const state: InferState = {
    nextTypeVarId: 0,
    substitutions: new Map(),
    errors,
    ctx,
    currentFunction: fn,
    expectedReturnType: UNIT_TYPE,
    typeParamScope,
  };
  if (filePath !== undefined) {
    state.currentFilePath = filePath;
  }

  for (const paramName of fn.typeParams) {
    typeParamScope.set(paramName, freshTypeVar(paramName, true, state));
  }

  const env: TypeEnv = new Map();
  const resolutionModule = ctx.currentModule;

  for (const param of fn.params) {
    const paramType = convertTypeExpr(param.type, typeParamScope, state, resolutionModule);
    env.set(param.name, paramType);
  }

  const declaredReturnType = convertTypeExpr(fn.returnType, typeParamScope, state, resolutionModule);
  state.expectedReturnType = declaredReturnType;

  inferBlock(fn.body, env, state, {
    expectedReturnType: declaredReturnType,
    treatAsExpression: false,
    cloneEnv: false,
  });
}

/**
 * Instantiate a polymorphic function signature with fresh type variables.
 * Returns null for builtin functions without AST declarations.
 * The rigid parameter controls whether type vars can be unified (false for call sites).
 */
export function instantiateFunctionSignature(
  signature: FnSignature,
  state: InferState,
  rigid: boolean,
): { params: Type[]; returnType: Type } | null {
  if (!signature.decl) {
    return null;
  }

  const typeParamScope = new Map<string, Type>();
  for (const paramName of signature.decl.typeParams) {
    typeParamScope.set(paramName, freshTypeVar(paramName, rigid, state));
  }

  const resolutionModule = signature.module ?? state.ctx.currentModule;

  const params = signature.decl.params.map((param) =>
    convertTypeExpr(param.type, typeParamScope, state, resolutionModule)
  );
  const returnType = convertTypeExpr(signature.decl.returnType, typeParamScope, state, resolutionModule);

  return { params, returnType };
}

/** Resolve function signature by name, handling cross-module references */
function resolveFunctionSignatureForVar(name: string, state: InferState): FnSignature | undefined {
  const ctx = state.ctx;
  const direct = ctx.functions.get(name);
  if (direct) {
    return direct;
  }
  if (ctx.currentModule && ctx.symbolTable) {
    const resolved = resolveIdentifier(name, ctx.currentModule, ctx.symbolTable);
    return ctx.functions.get(resolved);
  }
  return undefined;
}

/** Get function type as a first-class value (for treating functions as values) */
function resolveFunctionValueType(name: string, state: InferState): TypeFunction | null {
  const signature = resolveFunctionSignatureForVar(name, state);
  if (!signature) {
    return null;
  }
  const instantiated = instantiateFunctionSignature(signature, state, false);
  if (!instantiated) {
    return null;
  }
  return makeFunctionType(instantiated.params, instantiated.returnType);
}

/**
 * Infer types for a block of statements.
 * Returns the type of the last statement and whether block contains early return.
 * Handles let bindings, returns, and expression statements.
 */
export function inferBlock(
  block: ast.Block,
  env: TypeEnv,
  state: InferState,
  options: BlockOptions,
): BlockResult {
  const blockEnv = options.cloneEnv ? new Map(env) : env;
  let returned = false;
  let lastValue: Type = UNIT_TYPE;

  for (const stmt of block.stmts) {
    const result = inferStmt(stmt, blockEnv, state, options.expectedReturnType);
    lastValue = result.valueType;
    if (result.returned) {
      returned = true;
      if (!options.treatAsExpression) {
        break;
      }
    }
  }

  if (options.treatAsExpression && !returned) {
    return { valueType: applySubstitution(lastValue, state), returned: false };
  }

  return { valueType: applySubstitution(lastValue, state), returned };
}

function inferStmt(
  stmt: ast.Stmt,
  env: TypeEnv,
  state: InferState,
  expectedReturnType: Type,
): StatementResult {
  switch (stmt.kind) {
    case "LetStmt": {
      const exprType = inferExpr(stmt.expr, env, state);
      if (stmt.typeAnnotation) {
        const declaredType = convertTypeExpr(
          stmt.typeAnnotation,
          state.typeParamScope,
          state,
          state.ctx.currentModule,
        );
        unify(
          exprType,
          declaredType,
          state,
          `Type of '${stmt.name}' does not match declared annotation`,
          stmt.loc,
        );
        env.set(stmt.name, declaredType);
      } else {
        env.set(stmt.name, exprType);
      }
      return { valueType: UNIT_TYPE, returned: false };
    }
    case "ReturnStmt": {
      const exprType = inferExpr(stmt.expr, env, state);
      if (!state.insideAsyncTask) {
        unify(
          exprType,
          expectedReturnType,
          state,
          `Return type mismatch in function '${state.currentFunction.name}'`,
          stmt.loc,
        );
      }
      if (state.insideAsyncTask) {
        state.errors.push(makeError(
          "return is not allowed inside async tasks",
          stmt.loc,
          state.currentFilePath,
        ));
      }
      return { valueType: exprType, returned: true };
    }
    case "ExprStmt": {
      const exprType = inferExpr(stmt.expr, env, state);
      return { valueType: exprType, returned: false };
    }
    case "MatchStmt": {
      return inferMatchStmt(stmt, env, state, expectedReturnType);
    }
    case "AsyncGroupStmt":
      return inferAsyncGroupStmt(stmt, env, state, expectedReturnType);
    case "AsyncStmt":
      return inferAsyncStmt(stmt, env, state);
    default: {
      const exhaustive: never = stmt;
      throw new Error(`Unsupported statement kind: ${(exhaustive as ast.Stmt).kind}`);
    }
  }
}

function inferAsyncGroupStmt(
  stmt: ast.AsyncGroupStmt,
  env: TypeEnv,
  state: InferState,
  expectedReturnType: Type,
): StatementResult {
  const effects = state.currentFunction.effects || [];
  if (!effects.includes("Concurrent")) {
    state.errors.push(makeError(
      `async_group requires [Concurrent] effect in function '${state.currentFunction.name}'`,
      stmt.loc,
      state.currentFilePath,
    ));
  }

  const previousDepth = state.asyncGroupDepth ?? 0;
  state.asyncGroupDepth = previousDepth + 1;
  let returned = false;
  for (const inner of stmt.body.stmts) {
    const result = inferStmt(inner, env, state, expectedReturnType);
    if (result.returned) {
      returned = true;
    }
  }
  state.asyncGroupDepth = previousDepth;
  return { valueType: UNIT_TYPE, returned };
}

function inferAsyncStmt(stmt: ast.AsyncStmt, env: TypeEnv, state: InferState): StatementResult {
  const depth = state.asyncGroupDepth ?? 0;
  if (depth === 0) {
    state.errors.push(makeError(
      "async statements must be nested inside an async_group block",
      stmt.loc,
      state.currentFilePath,
    ));
  }

  const previousInside = state.insideAsyncTask ?? false;
  state.insideAsyncTask = true;
  const taskEnv = new Map(env);
  inferBlock(stmt.body, taskEnv, state, {
    expectedReturnType: UNIT_TYPE,
    treatAsExpression: false,
    cloneEnv: false,
  });
  state.insideAsyncTask = previousInside;

  return { valueType: UNIT_TYPE, returned: false };
}

function inferMatchStmt(
  stmt: ast.MatchStmt,
  env: TypeEnv,
  state: InferState,
  expectedReturnType: Type,
): StatementResult {
  const scrutineeType = inferExpr(stmt.scrutinee, env, state);
  checkMatchExhaustiveness(stmt, state.ctx, state.errors);

  let allReturn = true;
  let accumulatedType: Type | null = null;

  for (const matchCase of stmt.cases) {
    const caseEnv = new Map(env);
    bindPattern(matchCase.pattern, scrutineeType, caseEnv, state);
    const caseResult = inferBlock(matchCase.body, caseEnv, state, {
      expectedReturnType,
      treatAsExpression: true,
      cloneEnv: false,
    });

    if (!caseResult.returned) {
      allReturn = false;
      if (accumulatedType === null) {
        accumulatedType = caseResult.valueType;
      } else {
        unify(
          caseResult.valueType,
          accumulatedType,
          state,
          `Match case result mismatch in function '${state.currentFunction.name}'`,
        );
        accumulatedType = applySubstitution(accumulatedType, state);
      }
    }
  }

  if (allReturn) {
    return { valueType: expectedReturnType, returned: true };
  }

  return {
    valueType: accumulatedType ? applySubstitution(accumulatedType, state) : UNIT_TYPE,
    returned: false,
  };
}

function inferMatchExpr(expr: ast.MatchExpr, env: TypeEnv, state: InferState): Type {
  const scrutineeType = inferExpr(expr.scrutinee, env, state);
  checkMatchExhaustiveness(
    { kind: "MatchStmt", scrutinee: expr.scrutinee, cases: expr.cases },
    state.ctx,
    state.errors,
  );

  let allReturn = true;
  let accumulatedType: Type | null = null;

  for (const matchCase of expr.cases) {
    const caseEnv = new Map(env);
    bindPattern(matchCase.pattern, scrutineeType, caseEnv, state);
    const caseResult = inferBlock(matchCase.body, caseEnv, state, {
      expectedReturnType: state.expectedReturnType,
      treatAsExpression: true,
      cloneEnv: false,
    });

    if (!caseResult.returned) {
      allReturn = false;
      if (accumulatedType === null) {
        accumulatedType = caseResult.valueType;
      } else {
        unify(
          caseResult.valueType,
          accumulatedType,
          state,
          `Match case result mismatch in function '${state.currentFunction.name}'`,
        );
        accumulatedType = applySubstitution(accumulatedType, state);
      }
    }
  }

  if (allReturn) {
    return state.expectedReturnType;
  }

  return accumulatedType ? applySubstitution(accumulatedType, state) : UNIT_TYPE;
}

/**
 * Infer the type of an expression using Hindley-Milner algorithm.
 * Handles literals, variables, operations, function calls, pattern matching, records, etc.
 * Accumulates errors in state rather than throwing.
 */
export function inferExpr(expr: ast.Expr, env: TypeEnv, state: InferState): Type {
  switch (expr.kind) {
    case "IntLiteral":
      return INT_TYPE;
    case "BoolLiteral":
      return BOOL_TYPE;
    case "StringLiteral":
      return STRING_TYPE;
    case "VarRef": {
      const binding = env.get(expr.name);
      if (!binding) {
        const fnType = resolveFunctionValueType(expr.name, state);
        if (fnType) {
          return fnType;
        }
        state.errors.push(makeError(
          `Unknown variable '${expr.name}' in function '${state.currentFunction.name}'`,
          expr.loc,
          state.currentFilePath,
        ));
        return freshTypeVar(expr.name, false, state);
      }
      return applySubstitution(binding, state);
    }
    case "ListLiteral": {
      const elementType = freshTypeVar("ListElement", false, state);
      for (const element of expr.elements) {
        const elementExprType = inferExpr(element, env, state);
        unify(
          elementExprType,
          elementType,
          state,
          `List element type mismatch in function '${state.currentFunction.name}'`,
        );
      }
      return makeListType(applySubstitution(elementType, state));
    }
    case "BinaryExpr":
      return inferBinaryExpr(expr, env, state);
    case "CallExpr":
      return inferCallExpr(expr, env, state);
    case "MatchExpr":
      return inferMatchExpr(expr, env, state);
    case "RecordExpr":
      return inferRecordExpr(expr, env, state);
    case "FieldAccessExpr":
      return inferFieldAccess(expr, env, state);
    case "IndexExpr":
      return inferIndexExpr(expr, env, state);
    case "IfExpr":
      return inferIfExpr(expr, env, state);
    case "HoleExpr":
      state.errors.push(makeError(
        `Unfilled hole${expr.label ? ` '${expr.label}'` : ""} in function '${state.currentFunction.name}'`,
        expr.loc,
        state.currentFilePath,
      ));
      return freshTypeVar("Hole", false, state);
    default: {
      const exhaustive: never = expr;
      throw new Error(`Unsupported expression kind: ${(exhaustive as ast.Expr).kind}`);
    }
  }
}

function inferBinaryExpr(expr: ast.BinaryExpr, env: TypeEnv, state: InferState): Type {
  const leftType = inferExpr(expr.left, env, state);
  const rightType = inferExpr(expr.right, env, state);

  const numericOperators = new Set(["+", "-", "*", "/"]);
  const comparisonOperators = new Set([">", "<", ">=", "<="]);
  const logicalOperators = new Set(["&&", "||"]);

  if (numericOperators.has(expr.op)) {
    unify(leftType, INT_TYPE, state, `Left operand of '${expr.op}' must be Int`);
    unify(rightType, INT_TYPE, state, `Right operand of '${expr.op}' must be Int`);
    return INT_TYPE;
  }

  if (comparisonOperators.has(expr.op)) {
    unify(leftType, INT_TYPE, state, `Left operand of '${expr.op}' must be Int`);
    unify(rightType, INT_TYPE, state, `Right operand of '${expr.op}' must be Int`);
    return BOOL_TYPE;
  }

  if (logicalOperators.has(expr.op)) {
    unify(leftType, BOOL_TYPE, state, `Left operand of '${expr.op}' must be Bool`);
    unify(rightType, BOOL_TYPE, state, `Right operand of '${expr.op}' must be Bool`);
    return BOOL_TYPE;
  }

  if (expr.op === "==" || expr.op === "!=") {
    unify(
      leftType,
      rightType,
      state,
      `Operands of '${expr.op}' must have the same type in function '${state.currentFunction.name}'`,
    );
    return BOOL_TYPE;
  }

  state.errors.push({
    message: `Unsupported binary operator '${expr.op}' in function '${state.currentFunction.name}'`,
  });
  return freshTypeVar("UnknownBinaryResult", false, state);
}

function inferCallExpr(expr: ast.CallExpr, env: TypeEnv, state: InferState): Type {
  const argTypes = new Map<ast.CallArg, Type>();
  for (const callArg of expr.args) {
    argTypes.set(callArg, inferExpr(callArg.expr, env, state));
  }

  const actorSendType = inferActorSendCall(expr, env, state, argTypes);
  if (actorSendType) {
    return actorSendType;
  }

  const builtin = BUILTIN_FUNCTIONS[expr.callee];
  if (builtin) {
    const alignment = alignCallArguments(expr, builtin.paramNames);
    reportCallArgIssues(expr, expr.callee, alignment.issues, state.errors, state.currentFilePath);

    const instantiated = builtin.instantiateType(state);
    verifyEffectSubset(builtin.effects, state.currentFunction.effects, expr.callee, state.currentFunction.name, state.errors);
    enforcePureBuiltinArgs(expr, builtin.paramNames, alignment, state);

    alignment.ordered.forEach((arg, index) => {
      const expectedParam = instantiated.params[index] ?? freshTypeVar("BuiltinArg", false, state);
      if (!arg) {
        return;
      }
      const argType = argTypes.get(arg) ?? freshTypeVar("BuiltinArg", false, state);
      unify(
        argType,
        expectedParam,
        state,
        `Argument '${builtin.paramNames[index] ?? `#${index + 1}`}' of builtin '${expr.callee}' has incompatible type`,
        arg.expr.loc,
      );
    });
    return applySubstitution(instantiated.returnType, state);
  }

  const ctx = state.ctx;
  let resolvedName = expr.callee;
  if (ctx.currentModule && ctx.symbolTable) {
    resolvedName = resolveIdentifier(expr.callee, ctx.currentModule, ctx.symbolTable);
  }

  const signature = ctx.functions.get(resolvedName) ?? ctx.functions.get(expr.callee);
  if (!signature) {
    state.errors.push(makeError(`Unknown function '${expr.callee}'`, expr.loc, state.currentFilePath));
    return freshTypeVar("UnknownCall", false, state);
  }

  verifyEffectSubset(signature.effects, state.currentFunction.effects, expr.callee, state.currentFunction.name, state.errors);

  const alignment = alignCallArguments(expr, signature.paramNames);
  reportCallArgIssues(expr, expr.callee, alignment.issues, state.errors, state.currentFilePath);

  const instantiated = instantiateFunctionSignature(signature, state, false);
  if (!instantiated) {
    state.errors.push({ message: `Cannot instantiate function '${expr.callee}'` });
    return freshTypeVar("UnknownCall", false, state);
  }

  for (let i = 0; i < signature.paramCount; i += 1) {
    const alignedArg = alignment.ordered[i];
    if (!alignedArg) {
      continue;
    }
    const argType = argTypes.get(alignedArg) ?? freshTypeVar("Param", false, state);
    const expectedParam = instantiated.params[i] ?? freshTypeVar("Param", false, state);
    unify(
      argType,
      expectedParam,
      state,
      `Argument '${signature.paramNames[i] ?? `#${i + 1}`}' of function '${expr.callee}' has incompatible type`,
      alignedArg.expr.loc,
    );
  }

  return applySubstitution(instantiated.returnType, state);
}

function inferActorSendCall(
  expr: ast.CallExpr,
  env: TypeEnv,
  state: InferState,
  argTypes: Map<ast.CallArg, Type>,
): Type | null {
  const targetName = extractActorSendTarget(expr.callee);
  if (!targetName) {
    return null;
  }

  // Check if this is a builtin function (e.g., tcp.send is a builtin, not an actor send)
  if (BUILTIN_FUNCTIONS[expr.callee]) {
    return null;
  }

  if (state.ctx.functions.has(expr.callee)) {
    return null;
  }

  let resolvedName = expr.callee;
  if (state.ctx.currentModule && state.ctx.symbolTable) {
    resolvedName = resolveIdentifier(expr.callee, state.ctx.currentModule, state.ctx.symbolTable);
  }
  if (state.ctx.functions.has(resolvedName)) {
    return null;
  }

  const actorType = env.get(targetName);
  if (!actorType) {
    state.errors.push(makeError(
      `Unknown actor reference '${targetName}' in call to '${expr.callee}'`,
      expr.loc,
      state.currentFilePath,
    ));
    return UNIT_TYPE;
  }

  const messageType = freshTypeVar("ActorMessage", false, state);
  unify(actorType, makeActorRefType(messageType), state, `'.send' requires an ActorRef target`, expr.loc);

  const alignment = alignCallArguments(expr, ["message"]);
  reportCallArgIssues(expr, expr.callee, alignment.issues, state.errors, state.currentFilePath);

  verifyEffectSubset(new Set(["Concurrent"]), state.currentFunction.effects, expr.callee, state.currentFunction.name, state.errors);

  const messageArg = alignment.ordered[0];
  if (messageArg) {
    const argType = argTypes.get(messageArg) ?? freshTypeVar("ActorMessageArg", false, state);
    unify(
      argType,
      messageType,
      state,
      `Message argument to '${expr.callee}' has incompatible type`,
      messageArg.expr.loc,
    );
  }

  return UNIT_TYPE;
}

function extractActorSendTarget(callee: string): string | null {
  if (!callee.endsWith(".send")) {
    return null;
  }
  const prefix = callee.slice(0, -".send".length);
  if (!prefix || prefix.includes(".")) {
    return null;
  }
  return prefix;
}

function inferRecordExpr(expr: ast.RecordExpr, env: TypeEnv, state: InferState): Type {
  const variantInfo = resolveVariant(expr.typeName, state);
  if (variantInfo) {
    const typeParamScope = new Map<string, Type>();
    for (const paramName of variantInfo.typeParams) {
      typeParamScope.set(paramName, freshTypeVar(paramName, false, state));
    }

    const fieldTypes = new Map<string, Type>();
    for (const field of variantInfo.fields) {
      fieldTypes.set(
        field.name,
        convertTypeExpr(field.type, typeParamScope, state, variantInfo.module),
      );
    }

    const resultType: Type = {
      kind: "Constructor",
      name: variantInfo.parentQualifiedName,
      args: variantInfo.typeParams.map((paramName) => typeParamScope.get(paramName)!),
    };

    const providedFields = new Set<string>();

    for (const fieldExpr of expr.fields) {
      const expectedType = fieldTypes.get(fieldExpr.name);
      if (!expectedType) {
        state.errors.push({
          message: `Constructor '${expr.typeName}' has no field named '${fieldExpr.name}'`,
        });
        continue;
      }
      const actualType = inferExpr(fieldExpr.expr, env, state);
      unify(
        expectedType,
        actualType,
        state,
        `Field '${fieldExpr.name}' on constructor '${expr.typeName}' has incompatible type`,
      );
      providedFields.add(fieldExpr.name);
    }

    for (const field of variantInfo.fields) {
      if (!providedFields.has(field.name)) {
        state.errors.push({
          message: `Constructor '${expr.typeName}' is missing value for field '${field.name}'`,
        });
      }
    }

    return applySubstitution(resultType, state);
  }

  const recordInfo = resolveRecordType(expr.typeName, state);
  if (!recordInfo) {
    state.errors.push({ message: `Unknown constructor '${expr.typeName}'` });
    return freshTypeVar(expr.typeName, false, state);
  }

  const typeParamScope = new Map<string, Type>();
  for (const paramName of recordInfo.typeParams) {
    typeParamScope.set(paramName, freshTypeVar(paramName, false, state));
  }

  const expectedFields = new Map<string, Type>();
  for (const field of recordInfo.decl.fields) {
    expectedFields.set(
      field.name,
      convertTypeExpr(field.type, typeParamScope, state, recordInfo.module),
    );
  }

  const providedFields = new Set<string>();

  for (const fieldExpr of expr.fields) {
    const expectedType = expectedFields.get(fieldExpr.name);
    if (!expectedType) {
      state.errors.push({
        message: `Record '${expr.typeName}' has no field named '${fieldExpr.name}'`,
      });
      continue;
    }
    const actualType = inferExpr(fieldExpr.expr, env, state);
    unify(
      expectedType,
      actualType,
      state,
      `Field '${fieldExpr.name}' on record '${expr.typeName}' has incompatible type`,
    );
    providedFields.add(fieldExpr.name);
  }

  for (const fieldName of expectedFields.keys()) {
    if (!providedFields.has(fieldName)) {
      state.errors.push({
        message: `Record '${expr.typeName}' is missing value for field '${fieldName}'`,
      });
    }
  }

  const resultType: Type = {
    kind: "Constructor",
    name: recordInfo.qualifiedName,
    args: recordInfo.typeParams.map((paramName) => typeParamScope.get(paramName)!),
  };

  return applySubstitution(resultType, state);
}

function inferFieldAccess(expr: ast.FieldAccessExpr, env: TypeEnv, state: InferState): Type {
  const targetType = inferExpr(expr.target, env, state);
  const resolvedTarget = applySubstitution(targetType, state);

  if (resolvedTarget.kind !== "Constructor") {
    state.errors.push({
      message: `Cannot access field '${expr.field}' on non-record value`,
    });
    return freshTypeVar("FieldAccess", false, state);
  }

  const recordInfo = resolveRecordType(resolvedTarget.name, state);
  if (!recordInfo) {
    state.errors.push({
      message: `Cannot resolve record type for field access '${expr.field}'`,
    });
    return freshTypeVar("FieldAccess", false, state);
  }

  const fieldDecl = recordInfo.decl.fields.find((field) => field.name === expr.field);
  if (!fieldDecl) {
    state.errors.push({
      message: `Record '${recordInfo.name}' has no field named '${expr.field}'`,
    });
    return freshTypeVar("FieldAccess", false, state);
  }

  const typeParamScope = new Map<string, Type>();
  recordInfo.typeParams.forEach((paramName, index) => {
    const argType = resolvedTarget.args[index];
    typeParamScope.set(paramName, argType ?? freshTypeVar(paramName, false, state));
  });

  const fieldType = convertTypeExpr(fieldDecl.type, typeParamScope, state, recordInfo.module);
  return applySubstitution(fieldType, state);
}

function inferIfExpr(expr: ast.IfExpr, env: TypeEnv, state: InferState): Type {
  const condType = inferExpr(expr.cond, env, state);
  unify(condType, BOOL_TYPE, state, "If condition must be a Bool");

  const thenEnv = new Map(env);
  const thenResult = inferBlock(expr.thenBranch, thenEnv, state, {
    expectedReturnType: state.expectedReturnType,
    treatAsExpression: true,
    cloneEnv: false,
  });

  if (!expr.elseBranch) {
    return UNIT_TYPE;
  }

  const elseEnv = new Map(env);
  const elseResult = inferBlock(expr.elseBranch, elseEnv, state, {
    expectedReturnType: state.expectedReturnType,
    treatAsExpression: true,
    cloneEnv: false,
  });

  unify(
    thenResult.valueType,
    elseResult.valueType,
    state,
    "If expression branches must produce the same type",
  );

  return applySubstitution(thenResult.valueType, state);
}

function inferIndexExpr(expr: ast.IndexExpr, env: TypeEnv, state: InferState): Type {
  const targetType = inferExpr(expr.target, env, state);
  const indexType = inferExpr(expr.index, env, state);
  unify(indexType, INT_TYPE, state, "List index must be Int");

  const elementType = freshTypeVar("ListElement", false, state);
  unify(targetType, makeListType(elementType), state, "Indexing is only supported on lists");
  return applySubstitution(elementType, state);
}

function bindPattern(pattern: ast.Pattern, valueType: Type, env: TypeEnv, state: InferState): void {
  switch (pattern.kind) {
    case "WildcardPattern":
      return;
    case "VarPattern": {
      env.set(pattern.name, valueType);
      return;
    }
    case "CtorPattern": {
      const variantInfo = resolveVariant(pattern.ctorName, state);
      if (!variantInfo) {
        state.errors.push({ message: `Unknown constructor '${pattern.ctorName}'` });
        return;
      }

      const typeParamScope = new Map<string, Type>();
      for (const paramName of variantInfo.typeParams) {
        typeParamScope.set(paramName, freshTypeVar(paramName, false, state));
      }

      const variantType: Type = {
        kind: "Constructor",
        name: variantInfo.parentQualifiedName,
        args: variantInfo.typeParams.map((param) => typeParamScope.get(param)!),
      };

      unify(valueType, variantType, state, `Pattern constructor '${pattern.ctorName}' does not match scrutinee type`);

      const fieldTypes = new Map<string, Type>();
      for (const field of variantInfo.fields) {
        fieldTypes.set(
          field.name,
          convertTypeExpr(field.type, typeParamScope, state, variantInfo.module),
        );
      }

      for (const fieldPattern of pattern.fields) {
        const expectedType = fieldTypes.get(fieldPattern.name);
        if (!expectedType) {
          state.errors.push({
            message: `Constructor '${pattern.ctorName}' has no field named '${fieldPattern.name}'`,
          });
          continue;
        }
        bindPattern(fieldPattern.pattern, expectedType, env, state);
      }
      return;
    }
    default: {
      const exhaustive: never = pattern;
      throw new Error(`Unsupported pattern kind: ${(exhaustive as ast.Pattern).kind}`);
    }
  }
}

function enforcePureBuiltinArgs(
  expr: ast.CallExpr,
  paramNames: string[],
  alignment: ReturnType<typeof alignCallArguments>,
  state: InferState,
): void {
  const targets = PURE_BUILTIN_FUNCTION_PARAMS[expr.callee];
  if (!targets) {
    return;
  }
  for (const paramName of targets) {
    const arg = getAlignedArgument(alignment, paramNames, paramName);
    if (!arg) {
      continue;
    }
    if (arg.expr.kind !== "VarRef") {
      state.errors.push(makeError(
        `Argument '${paramName}' of '${expr.callee}' must reference a function name`,
        arg.expr.loc,
        state.currentFilePath,
      ));
      continue;
    }
    const signature = resolveFunctionSignatureForVar(arg.expr.name, state);
    if (!signature) {
      state.errors.push(makeError(
        `Unknown function '${arg.expr.name}' passed to '${expr.callee}'`,
        arg.expr.loc,
        state.currentFilePath,
      ));
      continue;
    }
    if (signature.effects.size > 0) {
      const effectList = Array.from(signature.effects).join(", ");
      state.errors.push(makeError(
        `Function '${signature.name}' passed to '${expr.callee}' must be pure but declares effects [${effectList}]`,
        arg.expr.loc,
        state.currentFilePath,
      ));
    }
  }
}
