/**
 * Canonical formatter for Lx code.
 * Converts AST back to formatted source code with consistent style.
 * 
 * Design principles (per THOUGHTS.md §1.2, §6.1):
 * - Deterministic: same AST always produces same output
 * - Regular: consistent indentation and spacing
 * - LLM-friendly: predictable structure for generation and parsing
 */

import * as AST from "./ast.js";

const INDENT = "  "; // 2 spaces

export function formatModule(mod: AST.Module): string {
  const lines: string[] = [];
  
  // Module declaration
  lines.push(`module ${mod.name.join(".")}`);
  lines.push("");
  
  // Imports
  for (const imp of mod.imports) {
    lines.push(formatImport(imp));
  }
  if (mod.imports.length > 0) {
    lines.push("");
  }
  
  // Declarations
  for (let i = 0; i < mod.decls.length; i++) {
    const decl = mod.decls[i];
    if (decl) {
      lines.push(formatDeclaration(decl, 0));
      
      // Add blank line between declarations (except last)
      if (i < mod.decls.length - 1) {
        lines.push("");
      }
    }
  }
  
  return lines.join("\n") + "\n";
}

function formatImport(imp: AST.ImportDecl): string {
  return `import ${imp.moduleName.join(".")}`;
}

function formatDeclaration(decl: AST.TopLevelDecl, indent: number): string {
  switch (decl.kind) {
    case "FnDecl":
      return formatFnDecl(decl, indent);
    case "AliasTypeDecl":
    case "RecordTypeDecl":
    case "SumTypeDecl":
      return formatTypeDecl(decl, indent);
    case "EffectDecl":
      return formatEffectDecl(decl, indent);
    case "SchemaDecl":
      return formatSchemaDecl(decl, indent);
    case "FnContractDecl":
      return formatContractDecl(decl, indent);
    case "TestDecl":
      return formatTestDecl(decl, indent);
    case "PropertyDecl":
      return formatPropertyDecl(decl, indent);
    default:
      const _exhaustive: never = decl;
      throw new Error(`Unknown declaration kind: ${(decl as any).kind}`);
  }
}

function formatFnDecl(fn: AST.FnDecl, indent: number): string {
  const prefix = INDENT.repeat(indent);
  const lines: string[] = [];
  
  // Function signature
  const params = fn.params.map(p => `${p.name}: ${formatTypeExpr(p.type)}`).join(", ");
  const effects = fn.effects.length > 0 ? ` [${fn.effects.join(", ")}]` : "";
  lines.push(`${prefix}fn ${fn.name}(${params})${effects} -> ${formatTypeExpr(fn.returnType)} {`);
  
  // Body
  lines.push(formatBlock(fn.body, indent + 1));
  lines.push(`${prefix}}`);
  
  return lines.join("\n");
}

function formatTypeDecl(type: AST.TypeDecl, indent: number): string {
  const prefix = INDENT.repeat(indent);
  
  if (type.kind === "AliasTypeDecl") {
    return `${prefix}type ${type.name} = ${formatTypeExpr(type.target)}`;
  } else if (type.kind === "RecordTypeDecl") {
    const fields = type.fields
      .map((f: AST.Field) => `${prefix}${INDENT}${f.name}: ${formatTypeExpr(f.type)}`)
      .join("\n");
    return `${prefix}type ${type.name} {\n${fields}\n${prefix}}`;
  } else if (type.kind === "SumTypeDecl") {
    const variants = type.variants
      .map((v: AST.Variant) => formatVariant(v))
      .join(" | ");
    return `${prefix}type ${type.name} = ${variants}`;
  }
  
  const _exhaustive: never = type;
  throw new Error(`Unknown type declaration kind: ${(type as any).kind}`);
}

function formatVariant(variant: AST.Variant): string {
  if (variant.fields.length === 0) {
    return variant.name;
  }
  const fields = variant.fields
    .map(f => `${f.name}: ${formatTypeExpr(f.type)}`)
    .join(", ");
  return `${variant.name} { ${fields} }`;
}

function formatEffectDecl(effect: AST.EffectDecl, indent: number): string {
  const prefix = INDENT.repeat(indent);
  return `${prefix}effect ${effect.name}`;
}

function formatSchemaDecl(schema: AST.SchemaDecl, indent: number): string {
  const prefix = INDENT.repeat(indent);
  const lines: string[] = [];
  
  lines.push(`${prefix}@version(${schema.version})`);
  lines.push(`${prefix}schema ${schema.name} {`);
  
  for (const field of schema.fields) {
    lines.push(`${prefix}${INDENT}${field.name}: ${formatTypeExpr(field.type)}`);
  }
  
  lines.push(`${prefix}}`);
  return lines.join("\n");
}

function formatContractDecl(contract: AST.FnContractDecl, indent: number): string {
  const prefix = INDENT.repeat(indent);
  const lines: string[] = [];
  
  const params = contract.params.map((p: AST.Param) => `${p.name}: ${formatTypeExpr(p.type)}`).join(", ");
  const returnType = contract.returnType ? formatTypeExpr(contract.returnType) : "Unit";
  lines.push(`${prefix}contract ${contract.name}(${params}) -> ${returnType} {`);
  
  if (contract.requires.length > 0) {
    lines.push(`${prefix}${INDENT}requires`);
    for (const req of contract.requires) {
      lines.push(`${prefix}${INDENT}${INDENT}${formatExpr(req, 0)}`);
    }
  }
  
  if (contract.ensures.length > 0) {
    lines.push(`${prefix}${INDENT}ensures`);
    for (const ens of contract.ensures) {
      lines.push(`${prefix}${INDENT}${INDENT}${formatExpr(ens, 0)}`);
    }
  }
  
  lines.push(`${prefix}}`);
  return lines.join("\n");
}

function formatTestDecl(test: AST.TestDecl, indent: number): string {
  const prefix = INDENT.repeat(indent);
  const lines: string[] = [];
  
  lines.push(`${prefix}test ${test.name} {`);
  lines.push(formatBlock(test.body, indent + 1));
  lines.push(`${prefix}}`);
  
  return lines.join("\n");
}

function formatPropertyDecl(prop: AST.PropertyDecl, indent: number): string {
  const prefix = INDENT.repeat(indent);
  const lines: string[] = [];
  
  const params = prop.params.map((p: AST.PropertyParam) => {
    let result = `${p.name}: ${formatTypeExpr(p.type)}`;
    if (p.predicate) {
      result += ` where ${formatExpr(p.predicate, 0)}`;
    }
    return result;
  }).join(", ");
  lines.push(`${prefix}property ${prop.name}(${params}) {`);
  
  lines.push(formatBlock(prop.body, indent + 1));
  lines.push(`${prefix}}`);
  
  return lines.join("\n");
}

function formatBlock(block: AST.Block, indent: number): string {
  return block.stmts.map((stmt: AST.Stmt) => formatStatement(stmt, indent)).join("\n");
}

function formatStatement(stmt: AST.Stmt, indent: number): string {
  const prefix = INDENT.repeat(indent);
  
  switch (stmt.kind) {
    case "LetStmt":
      return `${prefix}let ${stmt.name} = ${formatExpr(stmt.expr, 0)}`;
    case "ReturnStmt":
      return `${prefix}return ${formatExpr(stmt.expr, 0)}`;
    case "ExprStmt":
      return `${prefix}${formatExpr(stmt.expr, 0)}`;
    case "MatchStmt":
      return formatMatchStmt(stmt, indent);
    default:
      const _exhaustive: never = stmt;
      throw new Error(`Unknown statement kind: ${(stmt as any).kind}`);
  }
}

function formatMatchStmt(stmt: AST.MatchStmt, indent: number): string {
  const prefix = INDENT.repeat(indent);
  const lines: string[] = [];
  
  lines.push(`${prefix}match ${formatExpr(stmt.scrutinee, 0)} {`);
  for (const c of stmt.cases) {
    lines.push(`${prefix}${INDENT}case ${formatPattern(c.pattern)} => {`);
    lines.push(formatBlock(c.body, indent + 2));
    lines.push(`${prefix}${INDENT}}`);
  }
  lines.push(`${prefix}}`);
  
  return lines.join("\n");
}

function formatExpr(expr: AST.Expr, indent: number): string {
  switch (expr.kind) {
    case "IntLiteral":
      return expr.value.toString();
    case "StringLiteral":
      return `"${expr.value}"`;
    case "BoolLiteral":
      return expr.value ? "true" : "false";
    case "VarRef":
      return expr.name;
    case "BinaryExpr":
      return `${formatExpr(expr.left, indent)} ${expr.op} ${formatExpr(expr.right, indent)}`;
    case "CallExpr":
      const args = expr.args.map((arg) => {
        if (arg.kind === "NamedArg") {
          return `${arg.name} = ${formatExpr(arg.expr, indent)}`;
        }
        return formatExpr(arg.expr, indent);
      }).join(", ");
      return `${expr.callee}(${args})`;
    case "IfExpr":
      return formatIfExpr(expr, indent);
    case "ListLiteral":
      const elements = expr.elements.map((e: AST.Expr) => formatExpr(e, indent)).join(", ");
      return `[${elements}]`;
    case "IndexExpr":
      return `${formatExpr(expr.target, indent)}[${formatExpr(expr.index, indent)}]`;
    case "RecordExpr":
      return formatRecordExpr(expr, indent);
    case "FieldAccessExpr":
      return `${formatExpr(expr.target, indent)}.${expr.field}`;
    case "HoleExpr":
      if (expr.label !== undefined) {
        return `hole(${JSON.stringify(expr.label)})`;
      }
      return "hole()";
    default:
      const _exhaustive: never = expr;
      throw new Error(`Unknown expression kind: ${(expr as any).kind}`);
  }
}

function formatIfExpr(expr: AST.IfExpr, indent: number): string {
  const prefix = INDENT.repeat(indent);
  const lines: string[] = [];
  
  lines.push(`if ${formatExpr(expr.cond, 0)} {`);
  lines.push(formatBlock(expr.thenBranch, indent + 1));
  if (expr.elseBranch) {
    lines.push(`${prefix}} else {`);
    lines.push(formatBlock(expr.elseBranch, indent + 1));
  }
  lines.push(`${prefix}}`);
  
  return lines.join("\n" + prefix);
}

function formatRecordExpr(expr: AST.RecordExpr, indent: number): string {
  const fields = expr.fields.map(f => `${f.name}: ${formatExpr(f.expr, indent)}`).join(", ");
  return `${expr.typeName} { ${fields} }`;
}

function formatPattern(pattern: AST.Pattern): string {
  switch (pattern.kind) {
    case "WildcardPattern":
      return "_";
    case "VarPattern":
      return pattern.name;
    case "CtorPattern":
      if (pattern.fields.length === 0) {
        return pattern.ctorName;
      }
      const fields = pattern.fields.map(f => `${f.name}: ${formatPatternNested(f.pattern)}`).join(", ");
      return `${pattern.ctorName} { ${fields} }`;
    default:
      const _exhaustive: never = pattern;
      throw new Error(`Unknown pattern kind: ${(pattern as any).kind}`);
  }
}

function formatPatternNested(pattern: AST.Pattern): string {
  switch (pattern.kind) {
    case "WildcardPattern":
      return "_";
    case "VarPattern":
      return pattern.name;
    case "CtorPattern":
      return formatPattern(pattern);
    default:
      const _exhaustive: never = pattern;
      return "_";
  }
}

function formatTypeExpr(type: AST.TypeExpr): string {
  switch (type.kind) {
    case "TypeName":
      if (type.typeArgs.length === 0) {
        return type.name;
      }
      const args = type.typeArgs.map(formatTypeExpr).join(", ");
      return `${type.name}<${args}>`;
    case "OptionalType":
      return `${formatTypeExpr(type.inner)}?`;
    default:
      const _exhaustive: never = type;
      throw new Error(`Unknown type expression kind: ${(type as any).kind}`);
  }
}
