import fs from "fs";
import path from "path";
import * as ast from "./ast";

export class AstJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AstJsonError";
  }
}

type ParseContext = {
  filePath: string;
  path: string;
};

type JsonObject = Record<string, any>;

export function parseModuleFromAstFile(filePath: string): ast.Module {
  const absolute = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(absolute, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new AstJsonError(`Invalid AST JSON in '${absolute}': ${(error as Error).message}`);
  }
  return parseModuleFromJson(data, { filePath: absolute, path: "module" });
}

export function parseModuleFromJson(value: unknown, ctx: ParseContext): ast.Module {
  const obj = expectObject(value, ctx);
  assertKind(obj.kind, "Module", ctx);
  const name = expectStringArray(obj.name, child(ctx, "name"));
  const imports = (obj.imports ?? []).map((item: unknown, index: number) =>
    parseImportDecl(item, indexPath(child(ctx, "imports"), index))
  );
  const declsArray = expectArray(obj.decls, child(ctx, "decls"));
  const decls = declsArray.map((decl: unknown, index: number) =>
    parseTopLevelDecl(decl, indexPath(child(ctx, "decls"), index))
  );
  return {
    kind: "Module",
    name,
    imports,
    decls,
  };
}

function parseImportDecl(value: unknown, ctx: ParseContext): ast.ImportDecl {
  const obj = expectObject(value, ctx);
  assertKind(obj.kind, "ImportDecl", ctx);
  const decl: ast.ImportDecl = {
    kind: "ImportDecl",
    moduleName: expectStringArray(obj.moduleName, child(ctx, "moduleName")),
  };
  setIfDefined(decl, "alias", parseOptionalString(obj.alias, child(ctx, "alias")));
  return decl;
}

function parseTopLevelDecl(value: unknown, ctx: ParseContext): ast.TopLevelDecl {
  const obj = expectObject(value, ctx);
  const kind = expectString(obj.kind, child(ctx, "kind"));
  switch (kind) {
    case "EffectDecl": {
      const decl: ast.EffectDecl = {
        kind,
        name: expectString(obj.name, child(ctx, "name")),
      };
      setIfDefined(decl, "docComment", parseOptionalString(obj.docComment, child(ctx, "docComment")));
      return decl;
    }
    case "SchemaDecl":
      return parseSchemaDecl(obj, ctx);
    case "AliasTypeDecl":
    case "RecordTypeDecl":
    case "SumTypeDecl":
      return parseTypeDecl(obj, ctx);
    case "FnDecl":
      return parseFnDecl(obj, ctx);
    case "FnContractDecl":
      return parseContractDecl(obj, ctx);
    case "TestDecl": {
      const decl: ast.TestDecl = {
        kind,
        name: expectString(obj.name, child(ctx, "name")),
        body: parseBlock(obj.body, child(ctx, "body")),
      };
      setIfDefined(decl, "docComment", parseOptionalString(obj.docComment, child(ctx, "docComment")));
      return decl;
    }
    case "PropertyDecl":
      return parsePropertyDecl(obj, ctx);
    default:
      throw fail(ctx, `Unknown declaration kind '${kind}'`);
  }
}

function parseSchemaDecl(obj: JsonObject, ctx: ParseContext): ast.SchemaDecl {
  const decl: ast.SchemaDecl = {
    kind: "SchemaDecl",
    name: expectString(obj.name, child(ctx, "name")),
    version: expectNumber(obj.version, child(ctx, "version")),
    fields: expectArray(obj.fields, child(ctx, "fields")).map((field: unknown, index: number) =>
      parseSchemaField(field, indexPath(child(ctx, "fields"), index)),
    ),
  };
  setIfDefined(decl, "docComment", parseOptionalString(obj.docComment, child(ctx, "docComment")));
  return decl;
}

function parseSchemaField(value: unknown, ctx: ParseContext): ast.SchemaField {
  const obj = expectObject(value, ctx);
  return {
    name: expectString(obj.name, child(ctx, "name")),
    type: parseTypeExpr(obj.type, child(ctx, "type")),
    optional: parseOptionalBoolean(obj.optional, child(ctx, "optional")) ?? false,
  };
}

function parseTypeDecl(obj: JsonObject, ctx: ParseContext): ast.TypeDecl {
  const kind = expectString(obj.kind, child(ctx, "kind"));
  switch (kind) {
    case "AliasTypeDecl": {
      const decl: ast.AliasTypeDecl = {
        kind,
        name: expectString(obj.name, child(ctx, "name")),
        typeParams: expectStringArray(obj.typeParams ?? [], child(ctx, "typeParams")),
        target: parseTypeExpr(obj.target, child(ctx, "target")),
      };
      setIfDefined(decl, "docComment", parseOptionalString(obj.docComment, child(ctx, "docComment")));
      return decl;
    }
    case "RecordTypeDecl": {
      const decl: ast.RecordTypeDecl = {
        kind,
        name: expectString(obj.name, child(ctx, "name")),
        typeParams: expectStringArray(obj.typeParams ?? [], child(ctx, "typeParams")),
        fields: expectArray(obj.fields ?? [], child(ctx, "fields")).map((field: unknown, index: number) =>
          parseField(field, indexPath(child(ctx, "fields"), index)),
        ),
      };
      setIfDefined(decl, "docComment", parseOptionalString(obj.docComment, child(ctx, "docComment")));
      return decl;
    }
    case "SumTypeDecl": {
      const decl: ast.SumTypeDecl = {
        kind,
        name: expectString(obj.name, child(ctx, "name")),
        typeParams: expectStringArray(obj.typeParams ?? [], child(ctx, "typeParams")),
        variants: expectArray(obj.variants ?? [], child(ctx, "variants")).map((variant: unknown, index: number) =>
          parseVariant(variant, indexPath(child(ctx, "variants"), index)),
        ),
      };
      setIfDefined(decl, "docComment", parseOptionalString(obj.docComment, child(ctx, "docComment")));
      return decl;
    }
    default:
      throw fail(ctx, `Unknown type declaration kind '${kind}'`);
  }
}

function parseField(value: unknown, ctx: ParseContext): ast.Field {
  const obj = expectObject(value, ctx);
  return {
    name: expectString(obj.name, child(ctx, "name")),
    type: parseTypeExpr(obj.type, child(ctx, "type")),
  };
}

function parseVariant(value: unknown, ctx: ParseContext): ast.Variant {
  const obj = expectObject(value, ctx);
  return {
    name: expectString(obj.name, child(ctx, "name")),
    fields: expectArray(obj.fields ?? [], child(ctx, "fields")).map((field: unknown, index: number) =>
      parseField(field, indexPath(child(ctx, "fields"), index)),
    ),
  };
}

function parseFnDecl(obj: JsonObject, ctx: ParseContext): ast.FnDecl {
  const decl: ast.FnDecl = {
    kind: "FnDecl",
    name: expectString(obj.name, child(ctx, "name")),
    typeParams: expectStringArray(obj.typeParams ?? [], child(ctx, "typeParams")),
    params: expectArray(obj.params ?? [], child(ctx, "params")).map((param: unknown, index: number) =>
      parseParam(param, indexPath(child(ctx, "params"), index)),
    ),
    returnType: parseTypeExpr(obj.returnType, child(ctx, "returnType")),
    effects: expectStringArray(obj.effects ?? [], child(ctx, "effects")),
    body: parseBlock(obj.body, child(ctx, "body")),
  };
  setIfDefined(decl, "docComment", parseOptionalString(obj.docComment, child(ctx, "docComment")));
  return decl;
}

function parseParam(value: unknown, ctx: ParseContext): ast.Param {
  const obj = expectObject(value, ctx);
  return {
    name: expectString(obj.name, child(ctx, "name")),
    type: parseTypeExpr(obj.type, child(ctx, "type")),
  };
}

function parsePropertyDecl(obj: JsonObject, ctx: ParseContext): ast.PropertyDecl {
  const decl: ast.PropertyDecl = {
    kind: "PropertyDecl",
    name: expectString(obj.name, child(ctx, "name")),
    params: expectArray(obj.params ?? [], child(ctx, "params")).map((param: unknown, index: number) =>
      parsePropertyParam(param, indexPath(child(ctx, "params"), index)),
    ),
    body: parseBlock(obj.body, child(ctx, "body")),
  };
  setIfDefined(decl, "iterations", parseOptionalNumber(obj.iterations, child(ctx, "iterations")));
  setIfDefined(decl, "docComment", parseOptionalString(obj.docComment, child(ctx, "docComment")));
  return decl;
}

function parsePropertyParam(value: unknown, ctx: ParseContext): ast.PropertyParam {
  const obj = expectObject(value, ctx);
  const param: ast.PropertyParam = {
    name: expectString(obj.name, child(ctx, "name")),
    type: parseTypeExpr(obj.type, child(ctx, "type")),
  };
  if (obj.predicate !== undefined) {
    param.predicate = parseExpr(obj.predicate, child(ctx, "predicate"));
  }
  return param;
}

function parseContractDecl(obj: JsonObject, ctx: ParseContext): ast.FnContractDecl {
  const decl: ast.FnContractDecl = {
    kind: "FnContractDecl",
    name: expectString(obj.name, child(ctx, "name")),
    params: expectArray(obj.params ?? [], child(ctx, "params")).map((param: unknown, index: number) =>
      parseParam(param, indexPath(child(ctx, "params"), index)),
    ),
    returnType: obj.returnType ? parseTypeExpr(obj.returnType, child(ctx, "returnType")) : null,
    requires: expectArray(obj.requires ?? [], child(ctx, "requires")).map((expr: unknown, index: number) =>
      parseExpr(expr, indexPath(child(ctx, "requires"), index)),
    ),
    ensures: expectArray(obj.ensures ?? [], child(ctx, "ensures")).map((expr: unknown, index: number) =>
      parseExpr(expr, indexPath(child(ctx, "ensures"), index)),
    ),
  };
  setIfDefined(decl, "docComment", parseOptionalString(obj.docComment, child(ctx, "docComment")));
  return decl;
}

function parseBlock(value: unknown, ctx: ParseContext): ast.Block {
  const obj = expectObject(value, ctx);
  assertKind(obj.kind, "Block", ctx);
  const stmts = expectArray(obj.stmts ?? [], child(ctx, "stmts")).map((stmt: unknown, index: number) =>
    parseStmt(stmt, indexPath(child(ctx, "stmts"), index)),
  );
  return { kind: "Block", stmts };
}

function parseStmt(value: unknown, ctx: ParseContext): ast.Stmt {
  const obj = expectObject(value, ctx);
  const kind = expectString(obj.kind, child(ctx, "kind"));
  const loc = parseOptionalLocation(obj.loc, child(ctx, "loc"));
  switch (kind) {
    case "LetStmt": {
      const stmt: ast.LetStmt = {
        kind,
        name: expectString(obj.name, child(ctx, "name")),
        expr: parseExpr(obj.expr, child(ctx, "expr")),
      };
      if (obj.typeAnnotation !== undefined) {
        stmt.typeAnnotation = parseTypeExpr(obj.typeAnnotation, child(ctx, "typeAnnotation"));
      }
      setIfDefined(stmt, "loc", loc);
      return stmt;
    }
    case "ReturnStmt": {
      const stmt: ast.ReturnStmt = {
        kind,
        expr: parseExpr(obj.expr, child(ctx, "expr")),
      };
      setIfDefined(stmt, "loc", loc);
      return stmt;
    }
    case "ExprStmt": {
      const stmt: ast.ExprStmt = {
        kind,
        expr: parseExpr(obj.expr, child(ctx, "expr")),
      };
      setIfDefined(stmt, "loc", loc);
      return stmt;
    }
    case "MatchStmt":
      return {
        kind,
        scrutinee: parseExpr(obj.scrutinee, child(ctx, "scrutinee")),
        cases: expectArray(obj.cases ?? [], child(ctx, "cases")).map((matchCase: unknown, index: number) =>
          parseMatchCase(matchCase, indexPath(child(ctx, "cases"), index)),
        ),
      };
    case "AsyncGroupStmt": {
      const stmt: ast.AsyncGroupStmt = {
        kind,
        body: parseBlock(obj.body, child(ctx, "body")),
      };
      setIfDefined(stmt, "loc", loc);
      return stmt;
    }
    case "AsyncStmt": {
      const stmt: ast.AsyncStmt = {
        kind,
        body: parseBlock(obj.body, child(ctx, "body")),
      };
      setIfDefined(stmt, "loc", loc);
      return stmt;
    }
    default:
      throw fail(ctx, `Unknown statement kind '${kind}'`);
  }
}

function parseMatchCase(value: unknown, ctx: ParseContext): ast.MatchCase {
  const obj = expectObject(value, ctx);
  return {
    pattern: parsePattern(obj.pattern, child(ctx, "pattern")),
    body: parseBlock(obj.body, child(ctx, "body")),
  };
}

function parsePattern(value: unknown, ctx: ParseContext): ast.Pattern {
  const obj = expectObject(value, ctx);
  const kind = expectString(obj.kind, child(ctx, "kind"));
  switch (kind) {
    case "WildcardPattern":
      return { kind };
    case "VarPattern":
      return { kind, name: expectString(obj.name, child(ctx, "name")) };
    case "CtorPattern":
      return {
        kind,
        ctorName: expectString(obj.ctorName, child(ctx, "ctorName")),
        fields: expectArray(obj.fields ?? [], child(ctx, "fields")).map((field: unknown, index: number) =>
          parsePatternField(field, indexPath(child(ctx, "fields"), index)),
        ),
      };
    default:
      throw fail(ctx, `Unknown pattern kind '${kind}'`);
  }
}

function parsePatternField(value: unknown, ctx: ParseContext): ast.PatternField {
  const obj = expectObject(value, ctx);
  return {
    name: expectString(obj.name, child(ctx, "name")),
    pattern: parsePattern(obj.pattern, child(ctx, "pattern")),
  };
}

function parseExpr(value: unknown, ctx: ParseContext): ast.Expr {
  const obj = expectObject(value, ctx);
  const kind = expectString(obj.kind, child(ctx, "kind"));
  const loc = parseOptionalLocation(obj.loc, child(ctx, "loc"));
  switch (kind) {
    case "IntLiteral": {
      const expr: ast.IntLiteral = { kind: "IntLiteral", value: expectNumber(obj.value, child(ctx, "value")) };
      return attachLoc(expr, loc);
    }
    case "BoolLiteral": {
      const expr: ast.BoolLiteral = { kind: "BoolLiteral", value: expectBoolean(obj.value, child(ctx, "value")) };
      return attachLoc(expr, loc);
    }
    case "StringLiteral": {
      const expr: ast.StringLiteral = { kind: "StringLiteral", value: expectString(obj.value, child(ctx, "value")) };
      return attachLoc(expr, loc);
    }
    case "VarRef": {
      const expr: ast.VarRef = { kind: "VarRef", name: expectString(obj.name, child(ctx, "name")) };
      return attachLoc(expr, loc);
    }
    case "ListLiteral": {
      const expr: ast.ListLiteral = {
        kind: "ListLiteral",
        elements: expectArray(obj.elements ?? [], child(ctx, "elements")).map((element: unknown, index: number) =>
          parseExpr(element, indexPath(child(ctx, "elements"), index)),
        ),
      };
      return attachLoc(expr, loc);
    }
    case "BinaryExpr": {
      const expr: ast.BinaryExpr = {
        kind: "BinaryExpr",
        op: expectString(obj.op, child(ctx, "op")),
        left: parseExpr(obj.left, child(ctx, "left")),
        right: parseExpr(obj.right, child(ctx, "right")),
      };
      return attachLoc(expr, loc);
    }
    case "CallExpr": {
      const expr: ast.CallExpr = {
        kind: "CallExpr",
        callee: expectString(obj.callee, child(ctx, "callee")),
        args: expectArray(obj.args ?? [], child(ctx, "args")).map((arg: unknown, index: number) =>
          parseCallArg(arg, indexPath(child(ctx, "args"), index)),
        ),
      };
      return attachLoc(expr, loc);
    }
    case "MatchExpr": {
      const expr: ast.MatchExpr = {
        kind: "MatchExpr",
        scrutinee: parseExpr(obj.scrutinee, child(ctx, "scrutinee")),
        cases: expectArray(obj.cases ?? [], child(ctx, "cases")).map((matchCase: unknown, index: number) =>
          parseMatchCase(matchCase, indexPath(child(ctx, "cases"), index)),
        ),
      };
      return attachLoc(expr, loc);
    }
    case "RecordExpr": {
      const expr: ast.RecordExpr = {
        kind: "RecordExpr",
        typeName: expectString(obj.typeName, child(ctx, "typeName")),
        fields: expectArray(obj.fields ?? [], child(ctx, "fields")).map((field: unknown, index: number) =>
          parseRecordField(field, indexPath(child(ctx, "fields"), index)),
        ),
      };
      return attachLoc(expr, loc);
    }
    case "FieldAccessExpr": {
      const expr: ast.FieldAccessExpr = {
        kind: "FieldAccessExpr",
        target: parseExpr(obj.target, child(ctx, "target")),
        field: expectString(obj.field, child(ctx, "field")),
      };
      return attachLoc(expr, loc);
    }
    case "IndexExpr": {
      const expr: ast.IndexExpr = {
        kind: "IndexExpr",
        target: parseExpr(obj.target, child(ctx, "target")),
        index: parseExpr(obj.index, child(ctx, "index")),
      };
      return attachLoc(expr, loc);
    }
    case "IfExpr": {
      const expr: ast.IfExpr = {
        kind: "IfExpr",
        cond: parseExpr(obj.cond, child(ctx, "cond")),
        thenBranch: parseBlock(obj.thenBranch, child(ctx, "thenBranch")),
      };
      if (obj.elseBranch !== undefined) {
        expr.elseBranch = parseBlock(obj.elseBranch, child(ctx, "elseBranch"));
      }
      return attachLoc(expr, loc);
    }
    default:
      throw fail(ctx, `Unknown expression kind '${kind}'`);
  }
}

function parseCallArg(value: unknown, ctx: ParseContext): ast.CallArg {
  const obj = expectObject(value, ctx);
  const kind = expectString(obj.kind, child(ctx, "kind"));
  switch (kind) {
    case "NamedArg":
      return {
        kind,
        name: expectString(obj.name, child(ctx, "name")),
        expr: parseExpr(obj.expr, child(ctx, "expr")),
      };
    case "PositionalArg":
      return {
        kind,
        expr: parseExpr(obj.expr, child(ctx, "expr")),
      };
    default:
      throw fail(ctx, `Unknown call argument kind '${kind}'`);
  }
}

function parseRecordField(value: unknown, ctx: ParseContext): { name: string; expr: ast.Expr } {
  const obj = expectObject(value, ctx);
  return {
    name: expectString(obj.name, child(ctx, "name")),
    expr: parseExpr(obj.expr, child(ctx, "expr")),
  };
}

function parseTypeExpr(value: unknown, ctx: ParseContext): ast.TypeExpr {
  const obj = expectObject(value, ctx);
  const kind = expectString(obj.kind, child(ctx, "kind"));
  switch (kind) {
    case "TypeName":
      return {
        kind,
        name: expectString(obj.name, child(ctx, "name")),
        typeArgs: expectArray(obj.typeArgs ?? [], child(ctx, "typeArgs")).map((typeArg: unknown, index: number) =>
          parseTypeExpr(typeArg, indexPath(child(ctx, "typeArgs"), index)),
        ),
      };
    case "OptionalType":
      return {
        kind,
        inner: parseTypeExpr(obj.inner, child(ctx, "inner")),
      };
    default:
      throw fail(ctx, `Unknown type expression kind '${kind}'`);
  }
}

function parseOptionalLocation(value: unknown, ctx: ParseContext): ast.SourceLocation | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const obj = expectObject(value, ctx);
  return {
    start: parsePoint(obj.start, child(ctx, "start")),
    end: parsePoint(obj.end, child(ctx, "end")),
  };
}

function parsePoint(value: unknown, ctx: ParseContext): { line: number; column: number; offset: number } {
  const obj = expectObject(value, ctx);
  return {
    line: expectNumber(obj.line, child(ctx, "line")),
    column: expectNumber(obj.column, child(ctx, "column")),
    offset: expectNumber(obj.offset, child(ctx, "offset")),
  };
}

function setIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function attachLoc<T extends { loc?: ast.SourceLocation }>(node: T, loc?: ast.SourceLocation): T {
  setIfDefined(node, "loc", loc);
  return node;
}

function expectObject(value: unknown, ctx: ParseContext): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail(ctx, "Expected object");
  }
  return value as JsonObject;
}

function expectString(value: unknown, ctx: ParseContext): string {
  if (typeof value !== "string") {
    throw fail(ctx, "Expected string");
  }
  return value;
}

function expectNumber(value: unknown, ctx: ParseContext): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw fail(ctx, "Expected number");
  }
  return value;
}

function expectBoolean(value: unknown, ctx: ParseContext): boolean {
  if (typeof value !== "boolean") {
    throw fail(ctx, "Expected boolean");
  }
  return value;
}

function expectArray(value: unknown, ctx: ParseContext): unknown[] {
  if (!Array.isArray(value)) {
    throw fail(ctx, "Expected array");
  }
  return value;
}

function expectStringArray(value: unknown, ctx: ParseContext): string[] {
  return expectArray(value, ctx).map((element, index) => expectString(element, indexPath(ctx, index)));
}

function parseOptionalString(value: unknown, ctx: ParseContext): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return expectString(value, ctx);
}

function parseOptionalNumber(value: unknown, ctx: ParseContext): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return expectNumber(value, ctx);
}

function parseOptionalBoolean(value: unknown, ctx: ParseContext): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return expectBoolean(value, ctx);
}

function assertKind(actual: unknown, expected: string, ctx: ParseContext): void {
  if (actual !== expected) {
    throw fail(ctx, `Expected kind '${expected}' but got '${String(actual)}'`);
  }
}

function child(ctx: ParseContext, segment: string): ParseContext {
  return { filePath: ctx.filePath, path: `${ctx.path}.${segment}` };
}

function indexPath(ctx: ParseContext, index: number): ParseContext {
  return { filePath: ctx.filePath, path: `${ctx.path}[${index}]` };
}

function fail(ctx: ParseContext, message: string): AstJsonError {
  return new AstJsonError(`${ctx.filePath} ${ctx.path}: ${message}`);
}
