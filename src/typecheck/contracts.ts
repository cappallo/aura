import * as ast from "../ast";
import { alignCallArguments } from "../callargs";
import { resolveIdentifier } from "../loader";
import { BUILTIN_FUNCTIONS } from "./builtins";
import { TypeCheckError, TypecheckContext } from "./context";
import { reportCallArgIssues } from "./infer";

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
