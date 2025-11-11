import * as ast from "../ast";
import { alignCallArguments, CallArgIssue } from "../callargs";
import { resolveIdentifier } from "../loader";
import { BUILTIN_FUNCTIONS, PURE_BUILTIN_FUNCTION_PARAMS } from "./builtins";
import {
  ACTOR_REF_TYPE,
  BOOL_TYPE,
  INT_TYPE,
  STRING_TYPE,
  UNIT_TYPE,
  BUILTIN_SCALAR_TYPES,
  FnSignature,
  RecordTypeInfo,
  Type,
  TypeCheckError,
  TypeEnv,
  TypeFunction,
  TypeVar,
  VariantInfo,
  freshTypeVar,
  makeError,
  makeFunctionType,
  makeListType,
  makeOptionType,
  type InferState,
  type TypecheckContext,
} from "./types";

type BlockResult = {
  valueType: Type;
  returned: boolean;
};

type StatementResult = {
  valueType: Type;
  returned: boolean;
};

type BlockOptions = {
  expectedReturnType: Type;
  treatAsExpression: boolean;
  cloneEnv?: boolean;
};

export function typeCheckFunctionBody(
  fn: ast.FnDecl,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  filePath?: string,
): void {
  const state: InferState = {
    nextTypeVarId: 0,
    substitutions: new Map(),
    errors,
    ctx,
    currentFunction: fn,
    expectedReturnType: UNIT_TYPE,
  };
  if (filePath !== undefined) {
    state.currentFilePath = filePath;
  }

  const typeParamScope = new Map<string, Type>();
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

function instantiateFunctionSignature(
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

export function inferBlock(
  block: ast.Block,
  env: TypeEnv,
  state: InferState,
  options: BlockOptions,
): BlockResult {
  const workingEnv = options.cloneEnv ? new Map(env) : env;
  let returned = false;
  let lastValue: Type = UNIT_TYPE;
  const expectedReturnType = options.expectedReturnType ?? state.expectedReturnType;

  for (const stmt of block.stmts) {
    const result = inferStmt(stmt, workingEnv, state, expectedReturnType);
    lastValue = result.valueType;
    if (result.returned) {
      returned = true;
    }
  }

  if (!options.treatAsExpression && !returned) {
    return { valueType: UNIT_TYPE, returned };
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
      env.set(stmt.name, exprType);
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
      `Function '${state.currentFunction.name}' must declare [Concurrent] effect to use async_group`,
      stmt.loc,
      state.currentFilePath,
    ));
  }

  const previousDepth = state.asyncGroupDepth ?? 0;
  state.asyncGroupDepth = previousDepth + 1;
  const groupEnv = new Map(env);
  let accumulatedType: Type | null = null;
  let allReturn = true;

  for (const childStmt of stmt.body.stmts) {
    const childResult = inferBlock(
      { kind: "Block", stmts: [childStmt] },
      groupEnv,
      state,
      {
        expectedReturnType,
        treatAsExpression: true,
        cloneEnv: true,
      },
    );

    if (!childResult.returned) {
      allReturn = false;
      if (accumulatedType === null) {
        accumulatedType = childResult.valueType;
      } else {
        unify(
          childResult.valueType,
          accumulatedType,
          state,
          `async_group child result mismatch in function '${state.currentFunction.name}'`,
        );
        accumulatedType = applySubstitution(accumulatedType, state);
      }
    }
  }

  state.asyncGroupDepth = previousDepth;

  if (allReturn) {
    return { valueType: expectedReturnType, returned: true };
  }

  return {
    valueType: accumulatedType ? applySubstitution(accumulatedType, state) : UNIT_TYPE,
    returned: false,
  };
}

function inferAsyncStmt(
  stmt: ast.AsyncStmt,
  env: TypeEnv,
  state: InferState,
): StatementResult {
  const effects = state.currentFunction.effects || [];
  if (!effects.includes("Concurrent")) {
    state.errors.push(makeError(
      `Function '${state.currentFunction.name}' must declare [Concurrent] effect to use async`,
      stmt.loc,
      state.currentFilePath,
    ));
  }

  if (!state.asyncGroupDepth || state.asyncGroupDepth === 0) {
    state.errors.push(makeError(
      "async can only be used inside async_group",
      stmt.loc,
      state.currentFilePath,
    ));
  }

  const prevInsideAsyncTask = state.insideAsyncTask;
  state.insideAsyncTask = true;
  const result = inferBlock(stmt.body, env, state, {
    expectedReturnType: state.expectedReturnType,
    treatAsExpression: false,
    cloneEnv: false,
  });
  if (prevInsideAsyncTask === undefined) {
    delete state.insideAsyncTask;
  } else {
    state.insideAsyncTask = prevInsideAsyncTask;
  }
  return { valueType: result.valueType, returned: false };
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
      treatAsExpression: false,
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
          state.currentFilePath
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

  const actorSendType = inferActorSendCall(expr, env, state);
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

function inferActorSendCall(expr: ast.CallExpr, env: TypeEnv, state: InferState): Type | null {
  const targetName = extractActorSendTarget(expr.callee);
  if (!targetName) {
    return null;
  }

  const targetType = env.get(targetName);
  if (!targetType) {
    state.errors.push(makeError(
      `Unknown actor variable '${targetName}' in function '${state.currentFunction.name}'`,
      expr.loc,
      state.currentFilePath,
    ));
    return freshTypeVar("UnknownActor", false, state);
  }

  const resolvedTarget = applySubstitution(targetType, state);
  if (resolvedTarget.kind !== "Constructor" || resolvedTarget.name !== ACTOR_REF_TYPE.name) {
    state.errors.push(makeError(
      `Variable '${targetName}' is not an actor reference`,
      expr.loc,
      state.currentFilePath,
    ));
    return freshTypeVar("UnknownActor", false, state);
  }

  verifyEffectSubset(new Set(["Concurrent"]), state.currentFunction.effects, expr.callee, state.currentFunction.name, state.errors);

  const messageCtorName = extractActorSendConstructor(expr.callee);
  if (!messageCtorName) {
    state.errors.push(makeError(
      `Invalid actor send syntax '${expr.callee}'`,
      expr.loc,
      state.currentFilePath,
    ));
    return freshTypeVar("UnknownActor", false, state);
  }

  const variantInfo = resolveVariant(messageCtorName, state);
  if (!variantInfo) {
    state.errors.push(makeError(
      `Unknown message constructor '${messageCtorName}'`,
      expr.loc,
      state.currentFilePath,
    ));
    return freshTypeVar("UnknownActor", false, state);
  }

  const typeParamScope = new Map<string, Type>();
  for (const paramName of variantInfo.typeParams) {
    typeParamScope.set(paramName, freshTypeVar(paramName, false, state));
  }

  const paramTypes = expr.args.map((arg) => inferExpr(arg.expr, env, state));
  const alignment = alignCallArguments(expr, variantInfo.fields.map((field) => field.name));
  reportCallArgIssues(expr, messageCtorName, alignment.issues, state.errors, state.currentFilePath);

  alignment.ordered.forEach((arg, index) => {
    if (!arg) {
      return;
    }
    const field = variantInfo.fields[index];
    if (!field) {
      state.errors.push(makeError(
        `Constructor '${messageCtorName}' has no field for argument #${index + 1}`,
        arg.expr.loc,
        state.currentFilePath,
      ));
      return;
    }
    const expectedType = convertTypeExpr(field.type, typeParamScope, state, variantInfo.module);
    const argType = paramTypes[index] ?? freshTypeVar("ActorSendArg", false, state);
    unify(
      argType,
      expectedType,
      state,
      `Argument '${field.name}' of message constructor '${messageCtorName}' has incompatible type`,
      arg.expr.loc,
    );
  });

  return UNIT_TYPE;
}

function extractActorSendTarget(callee: string): string | null {
  const parts = callee.split(".");
  if (parts.length < 2) {
    return null;
  }
  return parts.slice(0, parts.length - 1).join(".");
}

function extractActorSendConstructor(callee: string): string | null {
  const parts = callee.split(".");
  if (parts.length < 2) {
    return null;
  }
  return parts[parts.length - 1] ?? null;
}

function inferRecordExpr(expr: ast.RecordExpr, env: TypeEnv, state: InferState): Type {
  const variantInfos = state.ctx.variantConstructors.get(expr.typeName);
  if (variantInfos && variantInfos.length > 0) {
    const variantInfo = variantInfos[0]!;
    const typeParamScope = new Map<string, Type>();
    for (const paramName of variantInfo.typeParams) {
      typeParamScope.set(paramName, freshTypeVar(paramName, false, state));
    }

    const providedFields = new Set<string>();
    const resultType: Type = {
      kind: "Constructor",
      name: variantInfo.parentQualifiedName,
      args: variantInfo.typeParams.map((paramName) => typeParamScope.get(paramName)!),
    };

    for (const fieldExpr of expr.fields) {
      const field = variantInfo.fields.find((f) => f.name === fieldExpr.name);
      if (!field) {
        state.errors.push({
          message: `Constructor '${expr.typeName}' has no field named '${fieldExpr.name}'`,
        });
        continue;
      }
      const expectedType = convertTypeExpr(field.type, typeParamScope, state, variantInfo.module);
      const actualType = inferExpr(fieldExpr.expr, env, state);
      unify(
        actualType,
        expectedType,
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
      actualType,
      expectedType,
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

export function reportCallArgIssues(
  expr: ast.CallExpr,
  callee: string,
  issues: CallArgIssue[],
  errors: TypeCheckError[],
  filePath?: string,
): void {
  for (const issue of issues) {
    switch (issue.kind) {
      case "TooManyArguments":
        errors.push(makeError(`Call to '${callee}' has too many arguments`, issue.arg.expr.loc, filePath));
        break;
      case "UnknownParameter":
        errors.push(makeError(
          `Call to '${callee}' has no parameter named '${issue.name}'`,
          issue.arg.expr.loc,
          filePath,
        ));
        break;
      case "DuplicateParameter":
        errors.push(makeError(
          `Parameter '${issue.name}' is provided multiple times in call to '${callee}'`,
          issue.arg.expr.loc,
          filePath,
        ));
        break;
      case "MissingParameter":
        errors.push(makeError(
          `Call to '${callee}' is missing an argument for parameter '${issue.name}'`,
          expr.loc,
          filePath,
        ));
        break;
      case "PositionalAfterNamed":
        errors.push(makeError(
          `Positional arguments must appear before named arguments when calling '${callee}'`,
          issue.arg.expr.loc,
          filePath,
        ));
        break;
      default:
        break;
    }
  }
}

function getAlignedArgument(
  alignment: ReturnType<typeof alignCallArguments>,
  paramNames: string[],
  name: string,
): ast.CallArg | null {
  const index = paramNames.indexOf(name);
  if (index === -1) {
    return null;
  }
  return alignment.ordered[index] ?? null;
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

function verifyEffectSubset(
  calleeEffects: Set<string>,
  callerEffects: string[],
  calleeName: string,
  callerName: string,
  errors: TypeCheckError[],
) {
  if (calleeEffects.size === 0) {
    return;
  }
  const callerEffectSet = new Set(callerEffects);
  for (const effect of calleeEffects) {
    if (!callerEffectSet.has(effect)) {
      errors.push({
        message: `Function '${callerName}' cannot call '${calleeName}' because it is missing effect '${effect}'`,
      });
    }
  }
}

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

function findTypeDecl(
  name: string,
  ctx: TypecheckContext,
  module: ast.Module | undefined,
): ReturnType<TypecheckContext["typeDecls"]["get"]> {
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

function resolveRecordType(name: string, state: InferState): RecordTypeInfo | undefined {
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

function prune(type: Type, state: InferState): Type {
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
