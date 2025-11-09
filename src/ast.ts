export type Identifier = string;

export type Module = {
  kind: "Module";
  name: string[];
  imports: ImportDecl[];
  decls: TopLevelDecl[];
};

export type ImportDecl = {
  kind: "ImportDecl";
  moduleName: string[];
  alias?: string;
};

export type TopLevelDecl =
  | EffectDecl
  | TypeDecl
  | FnDecl
  | FnContractDecl
  | TestDecl;

export type EffectDecl = {
  kind: "EffectDecl";
  name: string;
};

export type TypeDecl = AliasTypeDecl | RecordTypeDecl | SumTypeDecl;

export type AliasTypeDecl = {
  kind: "AliasTypeDecl";
  name: string;
  typeParams: string[];
  target: TypeExpr;
};

export type RecordTypeDecl = {
  kind: "RecordTypeDecl";
  name: string;
  typeParams: string[];
  fields: Field[];
};

export type SumTypeDecl = {
  kind: "SumTypeDecl";
  name: string;
  typeParams: string[];
  variants: Variant[];
};

export type Field = {
  name: string;
  type: TypeExpr;
};

export type Variant = {
  name: string;
  fields: Field[];
};

export type TypeExpr =
  | { kind: "TypeName"; name: string; typeArgs: TypeExpr[] }
  | { kind: "OptionalType"; inner: TypeExpr };

export type FnDecl = {
  kind: "FnDecl";
  name: string;
  typeParams: string[];
  params: Param[];
  returnType: TypeExpr;
  effects: string[];
  body: Block;
};

export type Param = {
  name: string;
  type: TypeExpr;
};

export type Block = {
  kind: "Block";
  stmts: Stmt[];
};

export type Stmt = LetStmt | ReturnStmt | ExprStmt | MatchStmt;

export type LetStmt = {
  kind: "LetStmt";
  name: string;
  expr: Expr;
};

export type ReturnStmt = {
  kind: "ReturnStmt";
  expr: Expr;
};

export type ExprStmt = {
  kind: "ExprStmt";
  expr: Expr;
};

export type MatchStmt = {
  kind: "MatchStmt";
  scrutinee: Expr;
  cases: MatchCase[];
};

export type MatchCase = {
  pattern: Pattern;
  body: Block;
};

export type Pattern =
  | { kind: "WildcardPattern" }
  | { kind: "VarPattern"; name: string }
  | { kind: "CtorPattern"; ctorName: string; fields: PatternField[] };

export type PatternField = {
  name: string;
  pattern: Pattern;
};

export type Expr =
  | IntLiteral
  | BoolLiteral
  | StringLiteral
  | VarRef
  | ListLiteral
  | BinaryExpr
  | CallExpr
  | RecordExpr
  | FieldAccessExpr
  | IndexExpr
  | IfExpr;

export type IntLiteral = {
  kind: "IntLiteral";
  value: number;
};

export type BoolLiteral = {
  kind: "BoolLiteral";
  value: boolean;
};

export type StringLiteral = {
  kind: "StringLiteral";
  value: string;
};

export type VarRef = {
  kind: "VarRef";
  name: string;
};

export type ListLiteral = {
  kind: "ListLiteral";
  elements: Expr[];
};

export type BinaryExpr = {
  kind: "BinaryExpr";
  op: string;
  left: Expr;
  right: Expr;
};

export type CallExpr = {
  kind: "CallExpr";
  callee: string;
  args: Expr[];
};

export type RecordExpr = {
  kind: "RecordExpr";
  typeName: string;
  fields: { name: string; expr: Expr }[];
};

export type FieldAccessExpr = {
  kind: "FieldAccessExpr";
  target: Expr;
  field: string;
};

export type IndexExpr = {
  kind: "IndexExpr";
  target: Expr;
  index: Expr;
};

export type IfExpr = {
  kind: "IfExpr";
  cond: Expr;
  thenBranch: Block;
  elseBranch?: Block;
};

export type TestDecl = {
  kind: "TestDecl";
  name: string;
  body: Block;
};

export type FnContractDecl = {
  kind: "FnContractDecl";
  name: string;
  params: Param[];
  returnType: TypeExpr | null;
  requires: Expr[];
  ensures: Expr[];
};
