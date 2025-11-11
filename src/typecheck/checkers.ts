import * as ast from "../ast";
import { alignCallArguments } from "../callargs";
import { resolveIdentifier } from "../loader";
import { BUILTIN_FUNCTIONS } from "./builtins";
import { reportCallArgIssues } from "./call-utils";
import {
  BOOL_TYPE,
  InferState,
  Type,
  TypeCheckError,
  TypeEnv,
  TypecheckContext,
  UNIT_TYPE,
  freshTypeVar,
  makeError,
} from "./types";
import { inferBlock, inferExpr, typeCheckFunctionBody } from "./inference";
import { convertTypeExpr, resolveVariant, unify } from "./type-ops";

export function verifyDeclaredEffects(
  fn: ast.FnDecl,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  filePath?: string,
): void {
  if (fn.effects.length === 0) {
    return;
  }
  for (const effect of fn.effects) {
    if (!ctx.declaredEffects.has(effect)) {
      errors.push(makeError(`Function '${fn.name}' declares unknown effect '${effect}'`, undefined, filePath));
    }
  }
}

export function checkFunction(
  fn: ast.FnDecl,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  filePath?: string,
): void {
  verifyDeclaredEffects(fn, ctx, errors, filePath);
  typeCheckFunctionBody(fn, ctx, errors, filePath);
}

export function checkProperty(
  property: ast.PropertyDecl,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  filePath?: string,
): void {
  const syntheticFn: ast.FnDecl = {
    kind: "FnDecl",
    name: `__property_${property.name}`,
    typeParams: [],
    params: property.params.map((param) => ({ name: param.name, type: param.type })),
    returnType: { kind: "TypeName", name: "Unit", typeArgs: [] },
    effects: [],
    body: property.body,
  };

  const state: InferState = {
    nextTypeVarId: 0,
    substitutions: new Map(),
    errors,
    ctx,
    currentFunction: syntheticFn,
    expectedReturnType: UNIT_TYPE,
  };

  if (filePath !== undefined) {
    state.currentFilePath = filePath;
  }

  const env: TypeEnv = new Map();
  const typeParamScope = new Map<string, Type>();
  const resolutionModule = ctx.currentModule;

  for (const param of syntheticFn.params) {
    const paramType = convertTypeExpr(param.type, typeParamScope, state, resolutionModule);
    env.set(param.name, paramType);
  }

  for (const param of property.params) {
    if (!param.predicate) {
      continue;
    }
    const predicateType = inferExpr(param.predicate, env, state);
    unify(
      predicateType,
      BOOL_TYPE,
      state,
      `Predicate for parameter '${param.name}' must evaluate to Bool`,
      param.predicate.loc,
    );
  }

  inferBlock(property.body, env, state, {
    expectedReturnType: UNIT_TYPE,
    treatAsExpression: false,
    cloneEnv: false,
  });
}

export function checkSchema(
  schema: ast.SchemaDecl,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  filePath?: string,
): void {
  if (schema.version <= 0) {
    errors.push(makeError(
      `Schema '${schema.name}' version must be positive, got ${schema.version}`,
      undefined,
      filePath,
    ));
  }

  const placeholderFn = syntheticFnForSchemas();
  const state: InferState = {
    nextTypeVarId: 0,
    substitutions: new Map(),
    errors,
    ctx,
    currentFunction: placeholderFn,
    expectedReturnType: UNIT_TYPE,
  };

  if (filePath !== undefined) {
    state.currentFilePath = filePath;
  }

  const typeParamScope = new Map<string, Type>();
  const resolutionModule = ctx.currentModule;

  for (const field of schema.fields) {
    try {
      convertTypeExpr(field.type, typeParamScope, state, resolutionModule);
    } catch (err) {
      errors.push(makeError(
        `Schema '${schema.name}' field '${field.name}' has invalid type`,
        undefined,
        filePath,
      ));
    }
  }
}

function syntheticFnForSchemas(): ast.FnDecl {
  return {
    kind: "FnDecl",
    name: "__schema_check__",
    typeParams: [],
    params: [],
    returnType: { kind: "TypeName", name: "Unit", typeArgs: [] },
    effects: [],
    body: { kind: "Block", stmts: [] },
  };
}

export function checkActor(
  actor: ast.ActorDecl,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  filePath?: string,
): void {
  const placeholderFn = syntheticFnForSchemas();
  const state: InferState = {
    nextTypeVarId: 0,
    substitutions: new Map(),
    errors,
    ctx,
    currentFunction: placeholderFn,
    expectedReturnType: UNIT_TYPE,
  };

  if (filePath !== undefined) {
    state.currentFilePath = filePath;
  }

  const typeParamScope = new Map<string, Type>();
  const resolutionModule = ctx.currentModule;

  for (const param of actor.params) {
    try {
      convertTypeExpr(param.type, typeParamScope, state, resolutionModule);
    } catch (err) {
      errors.push(makeError(
        `Actor '${actor.name}' parameter '${param.name}' has invalid type`,
        undefined,
        filePath,
      ));
    }
  }

  for (const field of actor.stateFields) {
    try {
      convertTypeExpr(field.type, typeParamScope, state, resolutionModule);
    } catch (err) {
      errors.push(makeError(
        `Actor '${actor.name}' state field '${field.name}' has invalid type`,
        undefined,
        filePath,
      ));
    }
  }

  for (const handler of actor.handlers) {
    try {
      convertTypeExpr(handler.returnType, typeParamScope, state, resolutionModule);
    } catch (err) {
      errors.push(makeError(
        `Actor '${actor.name}' handler 'on ${handler.msgTypeName}' has invalid return type`,
        undefined,
        filePath,
      ));
    }

    validateActorHandlerMessage(actor, handler, state, errors, filePath);

    const tempFn: ast.FnDecl = {
      kind: "FnDecl",
      name: `${actor.name}.on_${handler.msgTypeName}`,
      typeParams: [],
      params: [
        ...actor.params,
        ...actor.stateFields.map((field): ast.Param => ({
          name: field.name,
          type: field.type,
        })),
        ...handler.msgParams,
      ],
      returnType: handler.returnType,
      effects: [...handler.effects],
      body: handler.body,
    };

    typeCheckFunctionBody(tempFn, ctx, errors, filePath);
  }
}

function actorHandlerBindsWholeMessage(handler: ast.ActorHandler): boolean {
  if (handler.msgParams.length !== 1) {
    return false;
  }
  const param = handler.msgParams[0]!;
  return (
    param.type.kind === "TypeName" &&
    param.type.name === handler.msgTypeName &&
    param.type.typeArgs.length === 0
  );
}

function validateActorHandlerMessage(
  actor: ast.ActorDecl,
  handler: ast.ActorHandler,
  state: InferState,
  errors: TypeCheckError[],
  filePath?: string,
): void {
  const variantInfo = resolveVariant(handler.msgTypeName, state);
  if (!variantInfo) {
    errors.push(makeError(
      `Actor '${actor.name}' handler 'on ${handler.msgTypeName}' references unknown message constructor '${handler.msgTypeName}'`,
      undefined,
      filePath,
    ));
    return;
  }

  const typeParamScope = new Map<string, Type>();
  for (const paramName of variantInfo.typeParams) {
    typeParamScope.set(paramName, freshTypeVar(paramName, false, state));
  }

  if (actorHandlerBindsWholeMessage(handler)) {
    const paramType = convertTypeExpr(
      handler.msgParams[0]!.type,
      typeParamScope,
      state,
      state.ctx.currentModule,
    );
    const variantType: Type = {
      kind: "Constructor",
      name: variantInfo.parentQualifiedName,
      args: variantInfo.typeParams.map((paramName) => typeParamScope.get(paramName)!),
    };
    unify(
      paramType,
      variantType,
      state,
      `Actor '${actor.name}' handler '${handler.msgTypeName}' parameter '${handler.msgParams[0]!.name}' must have type '${handler.msgTypeName}'`,
    );
    return;
  }

  const variantFieldTypes = new Map<string, Type>();
  for (const field of variantInfo.fields) {
    variantFieldTypes.set(
      field.name,
      convertTypeExpr(field.type, typeParamScope, state, variantInfo.module),
    );
  }

  const matchedFields = new Set<string>();
  for (const param of handler.msgParams) {
    const fieldType = variantFieldTypes.get(param.name);
    if (!fieldType) {
      errors.push(makeError(
        `Actor '${actor.name}' handler 'on ${handler.msgTypeName}' has parameter '${param.name}' which does not exist on message '${handler.msgTypeName}'`,
        undefined,
        filePath,
      ));
      continue;
    }
    matchedFields.add(param.name);
    const paramType = convertTypeExpr(param.type, typeParamScope, state, state.ctx.currentModule);
    unify(
      paramType,
      fieldType,
      state,
      `Actor '${actor.name}' handler 'on ${handler.msgTypeName}' parameter '${param.name}' has incompatible type`,
    );
  }

  for (const field of variantInfo.fields) {
    if (!matchedFields.has(field.name)) {
      errors.push(makeError(
        `Actor '${actor.name}' handler 'on ${handler.msgTypeName}' is missing parameter for message field '${field.name}'`,
        undefined,
        filePath,
      ));
    }
  }
}

export function checkContract(
  contract: ast.FnContractDecl,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
): void {
  const signature = ctx.functions.get(contract.name);
  if (!signature) {
    errors.push({ message: `Contract declared for unknown function '${contract.name}'` });
    return;
  }

  if (contract.params.length !== signature.paramCount) {
    errors.push({
      message: `Contract for '${contract.name}' has ${contract.params.length} parameters but function expects ${signature.paramCount}`,
    });
  } else {
    for (let i = 0; i < contract.params.length; i += 1) {
      const contractParam = contract.params[i]!;
      const expectedName = signature.paramNames[i]!;
      if (contractParam.name !== expectedName) {
        errors.push({
          message: `Contract for '${contract.name}' parameter '${contractParam.name}' does not match function parameter '${expectedName}'`,
        });
      }
    }
  }

  for (const expr of contract.requires) {
    checkContractExpr(expr, ctx, errors, contract.name);
  }

  for (const expr of contract.ensures) {
    checkContractExpr(expr, ctx, errors, contract.name);
  }
}

function checkContractExpr(
  expr: ast.Expr,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  contractName: string,
): void {
  switch (expr.kind) {
    case "IntLiteral":
    case "BoolLiteral":
    case "StringLiteral":
    case "VarRef":
      return;
    case "ListLiteral": {
      for (const element of expr.elements) {
        checkContractExpr(element, ctx, errors, contractName);
      }
      return;
    }
    case "BinaryExpr": {
      checkContractExpr(expr.left, ctx, errors, contractName);
      checkContractExpr(expr.right, ctx, errors, contractName);
      return;
    }
    case "CallExpr": {
      checkContractCall(expr, ctx, errors, contractName);
      for (const arg of expr.args) {
        checkContractExpr(arg.expr, ctx, errors, contractName);
      }
      return;
    }
    case "RecordExpr": {
      let foundCtor = false;

      for (const [typeName, typeInfo] of ctx.sumTypes.entries()) {
        if (typeInfo.variants.has(expr.typeName)) {
          foundCtor = true;
          break;
        }
      }

      if (!foundCtor && ctx.recordTypes.has(expr.typeName)) {
        foundCtor = true;
      }

      if (!foundCtor && ctx.symbolTable && ctx.currentModule) {
        let qualifiedName = expr.typeName;
        if (!expr.typeName.includes(".")) {
          qualifiedName = resolveIdentifier(expr.typeName, ctx.currentModule, ctx.symbolTable);
        }

        const typeDecl = ctx.symbolTable.types.get(qualifiedName);
        if (typeDecl && typeDecl.kind === "RecordTypeDecl") {
          foundCtor = true;
        }
      }

      if (!foundCtor) {
        errors.push({
          message: `Contract for '${contractName}' uses unknown constructor '${expr.typeName}'`,
        });
      }

      for (const field of expr.fields) {
        checkContractExpr(field.expr, ctx, errors, contractName);
      }
      return;
    }
    case "FieldAccessExpr": {
      checkContractExpr(expr.target, ctx, errors, contractName);
      return;
    }
    case "IndexExpr": {
      checkContractExpr(expr.target, ctx, errors, contractName);
      checkContractExpr(expr.index, ctx, errors, contractName);
      return;
    }
    case "IfExpr": {
      checkContractExpr(expr.cond, ctx, errors, contractName);
      for (const stmt of expr.thenBranch.stmts) {
        checkContractStmt(stmt, ctx, errors, contractName);
      }
      if (expr.elseBranch) {
        for (const stmt of expr.elseBranch.stmts) {
          checkContractStmt(stmt, ctx, errors, contractName);
        }
      }
      return;
    }
    case "HoleExpr": {
      errors.push({
        message: `Contract for '${contractName}' contains unfilled hole${expr.label ? ` '${expr.label}'` : ""}`,
      });
      return;
    }
  }
}

function checkContractStmt(
  stmt: ast.Stmt,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  contractName: string,
): void {
  switch (stmt.kind) {
    case "LetStmt":
      checkContractExpr(stmt.expr, ctx, errors, contractName);
      return;
    case "ReturnStmt":
      checkContractExpr(stmt.expr, ctx, errors, contractName);
      return;
    case "ExprStmt":
      checkContractExpr(stmt.expr, ctx, errors, contractName);
      return;
    case "MatchStmt":
      checkContractExpr(stmt.scrutinee, ctx, errors, contractName);
      for (const matchCase of stmt.cases) {
        for (const caseStmt of matchCase.body.stmts) {
          checkContractStmt(caseStmt, ctx, errors, contractName);
        }
      }
      return;
  }
}

function checkContractCall(
  expr: ast.CallExpr,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  contractName: string,
): void {
  const builtin = BUILTIN_FUNCTIONS[expr.callee];
  if (builtin) {
    const alignment = alignCallArguments(expr, builtin.paramNames);
    reportCallArgIssues(expr, expr.callee, alignment.issues, errors);
    if (builtin.effects.size > 0) {
      errors.push({
        message: `Contract for '${contractName}' cannot call effectful builtin '${expr.callee}'`,
      });
    }
    return;
  }

  let qualifiedName = expr.callee;
  if (ctx.currentModule && ctx.symbolTable) {
    qualifiedName = resolveIdentifier(expr.callee, ctx.currentModule, ctx.symbolTable);
  }

  const signature = ctx.functions.get(qualifiedName);
  if (!signature) {
    errors.push({ message: `Contract for '${contractName}' references unknown function '${expr.callee}'` });
    return;
  }

  const alignment = alignCallArguments(expr, signature.paramNames);
  reportCallArgIssues(expr, expr.callee, alignment.issues, errors);

  if (signature.effects.size > 0) {
    errors.push({
      message: `Contract for '${contractName}' cannot call effectful function '${expr.callee}'`,
    });
  }
}
