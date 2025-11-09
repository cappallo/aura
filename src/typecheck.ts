import * as ast from "./ast";

export type TypeCheckError = {
  message: string;
};

type FnSignature = {
  name: string;
  paramCount: number;
  effects: Set<string>;
};

type TypecheckContext = {
  functions: Map<string, FnSignature>;
  declaredEffects: Set<string>;
};

const BUILTIN_FUNCTIONS: Record<string, { arity: number | null; effects: Set<string> }> = {
  "list.len": { arity: 1, effects: new Set() },
  "test.assert_equal": { arity: 2, effects: new Set() },
  "str.concat": { arity: 2, effects: new Set() },
  __negate: { arity: 1, effects: new Set() },
  __not: { arity: 1, effects: new Set() },
  "Log.debug": { arity: 1, effects: new Set(["Log"]) },
};

export function typecheckModule(module: ast.Module): TypeCheckError[] {
  const ctx: TypecheckContext = {
    functions: collectFunctions(module.decls),
    declaredEffects: collectEffects(module.decls),
  };

  const errors: TypeCheckError[] = [];

  for (const decl of module.decls) {
    if (decl.kind === "FnDecl") {
      checkFunction(decl, ctx, errors);
    }
  }

  return errors;
}

function collectFunctions(decls: ast.TopLevelDecl[]): Map<string, FnSignature> {
  const map = new Map<string, FnSignature>();
  for (const decl of decls) {
    if (decl.kind === "FnDecl") {
      map.set(decl.name, {
        name: decl.name,
        paramCount: decl.params.length,
        effects: new Set(decl.effects),
      });
    }
  }
  return map;
}

function collectEffects(decls: ast.TopLevelDecl[]): Set<string> {
  const effects = new Set<string>();
  for (const decl of decls) {
    if (decl.kind === "EffectDecl") {
      effects.add(decl.name);
    }
  }
  return effects;
}

function checkFunction(fn: ast.FnDecl, ctx: TypecheckContext, errors: TypeCheckError[]) {
  verifyDeclaredEffects(fn, ctx, errors);
  for (const stmt of fn.body.stmts) {
    checkStmt(stmt, fn, ctx, errors);
  }
}

function verifyDeclaredEffects(fn: ast.FnDecl, ctx: TypecheckContext, errors: TypeCheckError[]) {
  if (fn.effects.length === 0) {
    return;
  }
  for (const effect of fn.effects) {
    if (!ctx.declaredEffects.has(effect)) {
      errors.push({ message: `Function '${fn.name}' declares unknown effect '${effect}'` });
    }
  }
}

function checkStmt(stmt: ast.Stmt, fn: ast.FnDecl, ctx: TypecheckContext, errors: TypeCheckError[]) {
  switch (stmt.kind) {
    case "LetStmt":
      checkExpr(stmt.expr, fn, ctx, errors);
      return;
    case "ReturnStmt":
      checkExpr(stmt.expr, fn, ctx, errors);
      return;
    case "ExprStmt":
      checkExpr(stmt.expr, fn, ctx, errors);
      return;
    case "MatchStmt":
      checkExpr(stmt.scrutinee, fn, ctx, errors);
      for (const matchCase of stmt.cases) {
        for (const caseStmt of matchCase.body.stmts) {
          checkStmt(caseStmt, fn, ctx, errors);
        }
      }
      return;
  }
}

function checkExpr(expr: ast.Expr, fn: ast.FnDecl, ctx: TypecheckContext, errors: TypeCheckError[]) {
  switch (expr.kind) {
    case "IntLiteral":
    case "BoolLiteral":
    case "StringLiteral":
    case "VarRef":
      return;
    case "ListLiteral": {
      for (const element of expr.elements) {
        checkExpr(element, fn, ctx, errors);
      }
      return;
    }
    case "BinaryExpr": {
      checkExpr(expr.left, fn, ctx, errors);
      checkExpr(expr.right, fn, ctx, errors);
      return;
    }
    case "CallExpr": {
      checkCall(expr, fn, ctx, errors);
      for (const arg of expr.args) {
        checkExpr(arg, fn, ctx, errors);
      }
      return;
    }
    case "RecordExpr": {
      for (const field of expr.fields) {
        checkExpr(field.expr, fn, ctx, errors);
      }
      return;
    }
    case "FieldAccessExpr": {
      checkExpr(expr.target, fn, ctx, errors);
      return;
    }
    case "IndexExpr": {
      checkExpr(expr.target, fn, ctx, errors);
      checkExpr(expr.index, fn, ctx, errors);
      return;
    }
    case "IfExpr": {
      checkExpr(expr.cond, fn, ctx, errors);
      for (const stmt of expr.thenBranch.stmts) {
        checkStmt(stmt, fn, ctx, errors);
      }
      if (expr.elseBranch) {
        for (const stmt of expr.elseBranch.stmts) {
          checkStmt(stmt, fn, ctx, errors);
        }
      }
      return;
    }
  }
}

function checkCall(expr: ast.CallExpr, fn: ast.FnDecl, ctx: TypecheckContext, errors: TypeCheckError[]) {
  const builtin = BUILTIN_FUNCTIONS[expr.callee];
  if (builtin) {
    if (builtin.arity !== null && builtin.arity !== expr.args.length) {
      errors.push({
        message: `Builtin '${expr.callee}' expects ${builtin.arity} arguments but got ${expr.args.length}`,
      });
    }
    verifyEffectSubset(builtin.effects, fn.effects, expr.callee, fn.name, errors);
    return;
  }

  const signature = ctx.functions.get(expr.callee);
  if (!signature) {
    errors.push({ message: `Unknown function '${expr.callee}'` });
    return;
  }

  if (signature.paramCount !== expr.args.length) {
    errors.push({
      message: `Function '${expr.callee}' expects ${signature.paramCount} arguments but got ${expr.args.length}`,
    });
  }

  verifyEffectSubset(signature.effects, fn.effects, expr.callee, fn.name, errors);
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
