export type Identifier = string;

export type SourceLocation = {
  start: { line: number; column: number; offset: number };
  end: { line: number; column: number; offset: number };
};

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
  | SchemaDecl
  | FnDecl
  | FnContractDecl
  | TestDecl
  | PropertyDecl
  | ActorDecl;

export type EffectDecl = {
  kind: "EffectDecl";
  name: string;
  docComment?: string;
};

export type SchemaDecl = {
  kind: "SchemaDecl";
  name: string;
  version: number;
  fields: SchemaField[];
  docComment?: string;
};

export type SchemaField = {
  name: string;
  type: TypeExpr;
  optional: boolean;
};

export type TypeDecl = AliasTypeDecl | RecordTypeDecl | SumTypeDecl;

export type AliasTypeDecl = {
  kind: "AliasTypeDecl";
  name: string;
  typeParams: string[];
  target: TypeExpr;
  docComment?: string;
};

export type RecordTypeDecl = {
  kind: "RecordTypeDecl";
  name: string;
  typeParams: string[];
  fields: Field[];
  docComment?: string;
};

export type SumTypeDecl = {
  kind: "SumTypeDecl";
  name: string;
  typeParams: string[];
  variants: Variant[];
  docComment?: string;
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
  docComment?: string;
};

export type Param = {
  name: string;
  type: TypeExpr;
};

export type PropertyParam = {
  name: string;
  type: TypeExpr;
  predicate?: Expr;
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
  loc?: SourceLocation;
};

export type ReturnStmt = {
  kind: "ReturnStmt";
  expr: Expr;
  loc?: SourceLocation;
};

export type ExprStmt = {
  kind: "ExprStmt";
  expr: Expr;
  loc?: SourceLocation;
};

export type MatchStmt = {
  kind: "MatchStmt";
  scrutinee: Expr;
  cases: MatchCase[];
};

export type MatchExpr = {
  kind: "MatchExpr";
  scrutinee: Expr;
  cases: MatchCase[];
  loc?: SourceLocation;
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
  | MatchExpr
  | RecordExpr
  | FieldAccessExpr
  | IndexExpr
  | IfExpr
  | HoleExpr;

export type IntLiteral = {
  kind: "IntLiteral";
  value: number;
  loc?: SourceLocation;
};

export type BoolLiteral = {
  kind: "BoolLiteral";
  value: boolean;
  loc?: SourceLocation;
};

export type StringLiteral = {
  kind: "StringLiteral";
  value: string;
  loc?: SourceLocation;
};

export type VarRef = {
  kind: "VarRef";
  name: string;
  loc?: SourceLocation;
};

export type ListLiteral = {
  kind: "ListLiteral";
  elements: Expr[];
  loc?: SourceLocation;
};

export type BinaryExpr = {
  kind: "BinaryExpr";
  op: string;
  left: Expr;
  right: Expr;
  loc?: SourceLocation;
};

export type CallArg =
  | { kind: "PositionalArg"; expr: Expr }
  | { kind: "NamedArg"; name: string; expr: Expr };

export type CallExpr = {
  kind: "CallExpr";
  callee: string;
  args: CallArg[];
  loc?: SourceLocation;
};

export type RecordExpr = {
  kind: "RecordExpr";
  typeName: string;
  fields: { name: string; expr: Expr }[];
  loc?: SourceLocation;
};

export type FieldAccessExpr = {
  kind: "FieldAccessExpr";
  target: Expr;
  field: string;
  loc?: SourceLocation;
};

export type IndexExpr = {
  kind: "IndexExpr";
  target: Expr;
  index: Expr;
  loc?: SourceLocation;
};

export type IfExpr = {
  kind: "IfExpr";
  cond: Expr;
  thenBranch: Block;
  elseBranch?: Block;
  loc?: SourceLocation;
};

export type HoleExpr = {
  kind: "HoleExpr";
  label?: string;
  loc?: SourceLocation;
};

export type TestDecl = {
  kind: "TestDecl";
  name: string;
  body: Block;
  docComment?: string;
};

export type PropertyDecl = {
  kind: "PropertyDecl";
  name: string;
  params: PropertyParam[];
  body: Block;
  iterations?: number;
  docComment?: string;
};

export type FnContractDecl = {
  kind: "FnContractDecl";
  name: string;
  params: Param[];
  returnType: TypeExpr | null;
  requires: Expr[];
  ensures: Expr[];
  docComment?: string;
};

export type ActorDecl = {
  kind: "ActorDecl";
  name: string;
  params: Param[];
  stateFields: Field[];
  handlers: ActorHandler[];
  docComment?: string;
};

export type ActorHandler = {
  kind: "ActorHandler";
  msgTypeName: string;
  msgParams: Param[];
  returnType: TypeExpr;
  effects: string[];
  body: Block;
};
