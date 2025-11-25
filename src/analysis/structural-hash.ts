import * as ast from "../ast";

/**
 * Computes a structural hash of an AST node.
 * 
 * Normalization Rules:
 * - Local Variables: Renamed to $var1, $var2, etc. based on order of appearance.
 * - Field Names: Renamed to $field1, $field2, etc. based on order of appearance.
 * - Literals: Preserved (distinct logic).
 * - Global/Type Names: Preserved (distinct semantics).
 * - Source Locations: Ignored.
 */
// Use a union type for all possible AST nodes if AST type is not exported
// Note: Param and Field don't have kind properties, so they're handled separately
type ASTNode = 
  | ast.Module 
  | ast.TopLevelDecl 
  | ast.Block 
  | ast.Stmt 
  | ast.Expr 
  | ast.TypeExpr 
  | ast.Pattern;

export function computeStructuralHash(node: ASTNode): string {
  const ctx = new HashContext();
  return visit(node, ctx);
}

class HashContext {
  private varMap = new Map<string, string>();
  private fieldMap = new Map<string, string>();
  private nextVarId = 1;
  private nextFieldId = 1;

  normalizeVar(name: string): string {
    if (!this.varMap.has(name)) {
      this.varMap.set(name, `$var${this.nextVarId++}`);
    }
    return this.varMap.get(name)!;
  }

  normalizeField(name: string): string {
    if (!this.fieldMap.has(name)) {
      this.fieldMap.set(name, `$field${this.nextFieldId++}`);
    }
    return this.fieldMap.get(name)!;
  }
}

function visit(node: ASTNode | null | undefined, ctx: HashContext): string {
  if (!node) return "null";

  switch (node.kind) {
    case "Module": {
      const n = node as ast.Module;
      return `Module(${n.name.join(".")},[${n.decls.map((d) => visit(d, ctx)).join(",")}])`;
    }

    case "FnDecl": {
      const n = node as ast.FnDecl;
      // Reset context for each function to ensure independence
      const fnCtx = new HashContext();
      // Pre-normalize parameters
      n.params.forEach((p) => fnCtx.normalizeVar(p.name));
      return `FnDecl(${n.name},[${n.params.map((p) => visitParam(p, fnCtx)).join(",")}],${visit(n.body, fnCtx)})`;
    }

    case "Block": {
      const n = node as ast.Block;
      return `Block([${n.stmts.map((s) => visit(s, ctx)).join(",")}])`;
    }

    case "LetStmt": {
      const n = node as ast.LetStmt;
      return `Let(${ctx.normalizeVar(n.name)},${n.typeAnnotation ? visit(n.typeAnnotation, ctx) : "null"},${visit(n.expr, ctx)})`;
    }

    case "ReturnStmt": {
      const n = node as ast.ReturnStmt;
      return `Return(${visit(n.expr, ctx)})`;
    }

    case "ExprStmt": {
      const n = node as ast.ExprStmt;
      return `Expr(${visit(n.expr, ctx)})`;
    }

    case "IfExpr": {
      const n = node as ast.IfExpr;
      return `If(${visit(n.cond, ctx)},${visit(n.thenBranch, ctx)},${n.elseBranch ? visit(n.elseBranch, ctx) : "null"})`;
    }

    case "MatchExpr": {
      const n = node as ast.MatchExpr;
      return `Match(${visit(n.scrutinee, ctx)},[${n.cases.map((c) => visitMatchCase(c, ctx)).join(",")}])`;
    }

    case "BinaryExpr": {
      const n = node as ast.BinaryExpr;
      return `Binary(${n.op},${visit(n.left, ctx)},${visit(n.right, ctx)})`;
    }

    case "CallExpr": {
      const n = node as ast.CallExpr;
      return `Call(${n.callee},[${n.args.map((a) => visitCallArg(a, ctx)).join(",")}])`;
    }

    case "VarRef": {
      const n = node as ast.VarRef;
      return `Var(${ctx.normalizeVar(n.name)})`;
    }

    case "IntLiteral": {
      const n = node as ast.IntLiteral;
      return `Int(${n.value})`;
    }
    
    case "BoolLiteral": {
      const n = node as ast.BoolLiteral;
      return `Bool(${n.value})`;
    }

    case "StringLiteral": {
      const n = node as ast.StringLiteral;
      return `Str(${JSON.stringify(n.value)})`;
    }

    case "RecordExpr": {
      const n = node as ast.RecordExpr;
      return `Record(${n.typeName},[${n.fields.map((f) => `Field(${ctx.normalizeField(f.name)},${visit(f.expr, ctx)})`).join(",")}])`;
    }

    case "FieldAccessExpr": {
      const n = node as ast.FieldAccessExpr;
      return `Access(${visit(n.target, ctx)},${ctx.normalizeField(n.field)})`;
    }

    case "TypeName": {
      const n = node as any;
      if (n.kind === "TypeName") {
         return `Type(${n.name},[${(n.typeArgs || []).map((t: any) => visit(t, ctx)).join(",")}])`;
      }
      return n.kind;
    }

    default:
      return (node as any).kind;
  }
}

function visitMatchCase(node: ast.MatchCase, ctx: HashContext): string {
  // MatchCase has no kind, so we handle it directly
  return `Case(${visit(node.pattern, ctx)},${visit(node.body, ctx)})`;
}

function visitParam(param: ast.Param, ctx: HashContext): string {
  // Param has no kind, so we handle it directly
  return `Param(${ctx.normalizeVar(param.name)},${visit(param.type, ctx)})`;
}

function visitCallArg(arg: ast.CallArg, ctx: HashContext): string {
  if (arg.kind === "PositionalArg") {
    return `Pos(${visit(arg.expr, ctx)})`;
  } else {
    return `Named(${ctx.normalizeVar(arg.name)},${visit(arg.expr, ctx)})`;
  }
}
