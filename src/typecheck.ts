import * as ast from "./ast";

export type TypeCheckError = {
  message: string;
};

type FnSignature = {
  name: string;
  paramCount: number;
  paramNames: string[];
  effects: Set<string>;
};

type SumTypeInfo = {
  name: string;
  variants: Set<string>;
};

type TypecheckContext = {
  functions: Map<string, FnSignature>;
  declaredEffects: Set<string>;
  sumTypes: Map<string, SumTypeInfo>;
};

const BUILTIN_FUNCTIONS: Record<string, { arity: number | null; effects: Set<string> }> = {
  "list.len": { arity: 1, effects: new Set() },
  "test.assert_equal": { arity: 2, effects: new Set() },
  "str.concat": { arity: 2, effects: new Set() },
  __negate: { arity: 1, effects: new Set() },
  __not: { arity: 1, effects: new Set() },
  "Log.debug": { arity: 2, effects: new Set(["Log"]) },
  "Log.trace": { arity: 2, effects: new Set(["Log"]) },
};

export function typecheckModule(module: ast.Module): TypeCheckError[] {
  const ctx: TypecheckContext = {
    functions: collectFunctions(module.decls),
    declaredEffects: collectEffects(module.decls),
    sumTypes: collectSumTypes(module.decls),
  };

  const errors: TypeCheckError[] = [];

  for (const decl of module.decls) {
    if (decl.kind === "FnDecl") {
      checkFunction(decl, ctx, errors);
    }
  }

  for (const decl of module.decls) {
    if (decl.kind === "FnContractDecl") {
      checkContract(decl, ctx, errors);
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
        paramNames: decl.params.map((param) => param.name),
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

function collectSumTypes(decls: ast.TopLevelDecl[]): Map<string, SumTypeInfo> {
  const types = new Map<string, SumTypeInfo>();
  for (const decl of decls) {
    if (decl.kind === "SumTypeDecl") {
      const variants = new Set<string>();
      for (const variant of decl.variants) {
        variants.add(variant.name);
      }
      types.set(decl.name, {
        name: decl.name,
        variants,
      });
    }
  }
  return types;
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
      checkMatchExhaustiveness(stmt, ctx, errors);
      for (const matchCase of stmt.cases) {
        for (const caseStmt of matchCase.body.stmts) {
          checkStmt(caseStmt, fn, ctx, errors);
        }
      }
      return;
  }
}

function checkMatchExhaustiveness(stmt: ast.MatchStmt, ctx: TypecheckContext, errors: TypeCheckError[]) {
  // Collect all constructor patterns in the match
  const coveredCtors = new Set<string>();
  let hasWildcard = false;

  for (const matchCase of stmt.cases) {
    if (matchCase.pattern.kind === "WildcardPattern") {
      hasWildcard = true;
    } else if (matchCase.pattern.kind === "CtorPattern") {
      coveredCtors.add(matchCase.pattern.ctorName);
    } else if (matchCase.pattern.kind === "VarPattern") {
      // Variable patterns are catch-all like wildcards
      hasWildcard = true;
    }
  }

  // If there's a wildcard or var pattern, the match is exhaustive
  if (hasWildcard) {
    return;
  }

  // Try to determine which sum type is being matched
  // We look for the first constructor pattern and find its type
  for (const matchCase of stmt.cases) {
    if (matchCase.pattern.kind === "CtorPattern") {
      const ctorName = matchCase.pattern.ctorName;
      
      // Find which sum type this constructor belongs to
      for (const [typeName, typeInfo] of ctx.sumTypes.entries()) {
        if (typeInfo.variants.has(ctorName)) {
          // Check if all variants are covered
          const uncoveredVariants: string[] = [];
          for (const variant of typeInfo.variants) {
            if (!coveredCtors.has(variant)) {
              uncoveredVariants.push(variant);
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

function checkContract(contract: ast.FnContractDecl, ctx: TypecheckContext, errors: TypeCheckError[]) {
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
) {
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
        checkContractExpr(arg, ctx, errors, contractName);
      }
      return;
    }
    case "RecordExpr": {
      // Validate that the constructor exists in a sum type
      let foundCtor = false;
      for (const [typeName, typeInfo] of ctx.sumTypes.entries()) {
        if (typeInfo.variants.has(expr.typeName)) {
          foundCtor = true;
          break;
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
  }
}

function checkContractStmt(
  stmt: ast.Stmt,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  contractName: string,
) {
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
      // Validate that the constructor exists in a sum type
      let foundCtor = false;
      for (const [typeName, typeInfo] of ctx.sumTypes.entries()) {
        if (typeInfo.variants.has(expr.typeName)) {
          foundCtor = true;
          break;
        }
      }
      
      if (!foundCtor) {
        errors.push({
          message: `Unknown constructor '${expr.typeName}'. Not found in any sum type.`,
        });
      }
      
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

function checkContractCall(
  expr: ast.CallExpr,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  contractName: string,
) {
  const builtin = BUILTIN_FUNCTIONS[expr.callee];
  if (builtin) {
    if (builtin.arity !== null && builtin.arity !== expr.args.length) {
      errors.push({
        message: `Builtin '${expr.callee}' expects ${builtin.arity} arguments but got ${expr.args.length}`,
      });
    }
    if (builtin.effects.size > 0) {
      errors.push({
        message: `Contract for '${contractName}' cannot call effectful builtin '${expr.callee}'`,
      });
    }
    return;
  }

  const signature = ctx.functions.get(expr.callee);
  if (!signature) {
    errors.push({ message: `Contract for '${contractName}' references unknown function '${expr.callee}'` });
    return;
  }

  if (signature.paramCount !== expr.args.length) {
    errors.push({
      message: `Function '${expr.callee}' expects ${signature.paramCount} arguments but got ${expr.args.length}`,
    });
  }

  if (signature.effects.size > 0) {
    errors.push({
      message: `Contract for '${contractName}' cannot call effectful function '${expr.callee}'`,
    });
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
