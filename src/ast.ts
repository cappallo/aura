/** Simple name identifier used throughout the AST */
export type Identifier = string;

/** Location in source file tracking line, column, and byte offset for error reporting */
export type SourceLocation = {
  start: { line: number; column: number; offset: number };
  end: { line: number; column: number; offset: number };
};

/** Top-level module containing imports and declarations */
export type Module = {
  kind: "Module";
  /** Qualified module name parts, e.g., ['examples', 'math'] */
  name: string[];
  imports: ImportDecl[];
  decls: TopLevelDecl[];
};

/** Import declaration referencing another module */
export type ImportDecl = {
  kind: "ImportDecl";
  /** Qualified name of the imported module */
  moduleName: string[];
  /** Optional local alias for the imported module */
  alias?: string;
};

/** Union of all top-level declaration kinds */
export type TopLevelDecl =
  | EffectDecl
  | TypeDecl
  | SchemaDecl
  | FnDecl
  | FnContractDecl
  | TestDecl
  | PropertyDecl
  | ActorDecl;

/** Effect declaration introducing a side effect name */
export type EffectDecl = {
  kind: "EffectDecl";
  name: string;
  docComment?: string;
};

/** Schema declaration for structured data with versioning (used for codecs) */
export type SchemaDecl = {
  kind: "SchemaDecl";
  name: string;
  version: number;
  fields: SchemaField[];
  docComment?: string;
};

/** Field within a schema, may be optional */
export type SchemaField = {
  name: string;
  type: TypeExpr;
  optional: boolean;
};

/** Union of type declaration forms: alias, record, or sum type */
export type TypeDecl = AliasTypeDecl | RecordTypeDecl | SumTypeDecl;

/** Type alias declaration creating a synonym for an existing type */
export type AliasTypeDecl = {
  kind: "AliasTypeDecl";
  name: string;
  typeParams: string[];
  target: TypeExpr;
  docComment?: string;
};

/** Record type declaration with named fields (like a struct) */
export type RecordTypeDecl = {
  kind: "RecordTypeDecl";
  name: string;
  typeParams: string[];
  fields: Field[];
  docComment?: string;
};

/** Sum type declaration with multiple variants (like a tagged union) */
export type SumTypeDecl = {
  kind: "SumTypeDecl";
  name: string;
  typeParams: string[];
  variants: Variant[];
  docComment?: string;
};

/** Named field with a type, used in records and variants */
export type Field = {
  name: string;
  type: TypeExpr;
};

/** Variant of a sum type with its own set of fields */
export type Variant = {
  name: string;
  fields: Field[];
};

/** Type expression appearing in type annotations */
export type TypeExpr =
  | { kind: "TypeName"; name: string; typeArgs: TypeExpr[] }
  | { kind: "OptionalType"; inner: TypeExpr };

/** Function declaration with parameters, return type, effects, and body */
export type FnDecl = {
  kind: "FnDecl";
  name: string;
  typeParams: string[];
  params: Param[];
  returnType: TypeExpr;
  /** Declared side effects this function may perform */
  effects: string[];
  body: Block;
  docComment?: string;
};

/** Function or message handler parameter */
export type Param = {
  name: string;
  type: TypeExpr;
};

/** Property test parameter with optional predicate constraint */
export type PropertyParam = {
  name: string;
  type: TypeExpr;
  /** Boolean expression constraining generated values */
  predicate?: Expr;
};

/** Block of statements with implicit return of last expression */
export type Block = {
  kind: "Block";
  stmts: Stmt[];
};

/** Union of all statement kinds */
export type Stmt = LetStmt | ReturnStmt | ExprStmt | MatchStmt | AsyncGroupStmt | AsyncStmt;

/** Variable binding statement */
export type LetStmt = {
  kind: "LetStmt";
  name: string;
  /** Optional explicit type annotation for the binding */
  typeAnnotation?: TypeExpr;
  expr: Expr;
  loc?: SourceLocation;
};

/** Early return statement */
export type ReturnStmt = {
  kind: "ReturnStmt";
  expr: Expr;
  loc?: SourceLocation;
};

/** Expression evaluated for side effects, result discarded */
export type ExprStmt = {
  kind: "ExprStmt";
  expr: Expr;
  loc?: SourceLocation;
};

/** Pattern matching statement (does not produce a value) */
export type MatchStmt = {
  kind: "MatchStmt";
  scrutinee: Expr;
  cases: MatchCase[];
};

/** Structured concurrency block grouping async tasks */
export type AsyncGroupStmt = {
  kind: "AsyncGroupStmt";
  body: Block;
  loc?: SourceLocation;
};

/** Single async task within an async_group */
export type AsyncStmt = {
  kind: "AsyncStmt";
  body: Block;
  loc?: SourceLocation;
};

/** Pattern matching expression producing a value */
export type MatchExpr = {
  kind: "MatchExpr";
  scrutinee: Expr;
  cases: MatchCase[];
  loc?: SourceLocation;
};

/** Single case in a match expression/statement */
export type MatchCase = {
  pattern: Pattern;
  body: Block;
};

/** Pattern for destructuring values in match expressions */
export type Pattern =
  | { kind: "WildcardPattern" }
  | { kind: "VarPattern"; name: string }
  | { kind: "CtorPattern"; ctorName: string; fields: PatternField[] };

/** Named field pattern within a constructor pattern */
export type PatternField = {
  name: string;
  pattern: Pattern;
};

/** Union of all expression kinds */
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

/** Integer literal expression */
export type IntLiteral = {
  kind: "IntLiteral";
  value: number;
  loc?: SourceLocation;
};

/** Boolean literal expression */
export type BoolLiteral = {
  kind: "BoolLiteral";
  value: boolean;
  loc?: SourceLocation;
};

/** String literal expression */
export type StringLiteral = {
  kind: "StringLiteral";
  value: string;
  loc?: SourceLocation;
};

/** Variable reference expression */
export type VarRef = {
  kind: "VarRef";
  name: string;
  loc?: SourceLocation;
};

/** List literal expression with homogeneous elements */
export type ListLiteral = {
  kind: "ListLiteral";
  elements: Expr[];
  loc?: SourceLocation;
};

/** Binary operator expression (arithmetic, comparison, logical) */
export type BinaryExpr = {
  kind: "BinaryExpr";
  op: string;
  left: Expr;
  right: Expr;
  loc?: SourceLocation;
};

/** Function call argument, either positional or named */
export type CallArg =
  | { kind: "PositionalArg"; expr: Expr }
  | { kind: "NamedArg"; name: string; expr: Expr };

/** Function call expression supporting mixed positional/named arguments */
export type CallExpr = {
  kind: "CallExpr";
  callee: string;
  args: CallArg[];
  loc?: SourceLocation;
};

/** Record construction expression creating record or variant instances */
export type RecordExpr = {
  kind: "RecordExpr";
  typeName: string;
  fields: { name: string; expr: Expr }[];
  loc?: SourceLocation;
};

/** Field access expression for extracting record/variant fields */
export type FieldAccessExpr = {
  kind: "FieldAccessExpr";
  target: Expr;
  field: string;
  loc?: SourceLocation;
};

/** List/string indexing expression */
export type IndexExpr = {
  kind: "IndexExpr";
  target: Expr;
  index: Expr;
  loc?: SourceLocation;
};

/** Conditional expression with mandatory then branch and optional else */
export type IfExpr = {
  kind: "IfExpr";
  cond: Expr;
  thenBranch: Block;
  elseBranch?: Block;
  loc?: SourceLocation;
};

/** Typed hole expression for incremental development (raises error when evaluated) */
export type HoleExpr = {
  kind: "HoleExpr";
  label?: string;
  loc?: SourceLocation;
};

/** Test declaration for unit testing with assertions */
export type TestDecl = {
  kind: "TestDecl";
  name: string;
  body: Block;
  docComment?: string;
};

/** Property-based test declaration with generated inputs */
export type PropertyDecl = {
  kind: "PropertyDecl";
  name: string;
  params: PropertyParam[];
  body: Block;
  /** Number of test iterations, defaults to 100 */
  iterations?: number;
  docComment?: string;
};

/** Function contract declaration with preconditions (requires) and postconditions (ensures) */
export type FnContractDecl = {
  kind: "FnContractDecl";
  name: string;
  params: Param[];
  returnType: TypeExpr | null;
  /** Preconditions that must hold on entry */
  requires: Expr[];
  /** Postconditions that must hold on exit (can reference 'result') */
  ensures: Expr[];
  docComment?: string;
};

/** Actor declaration defining stateful concurrent entity with message handlers */
export type ActorDecl = {
  kind: "ActorDecl";
  name: string;
  /** Constructor parameters */
  params: Param[];
  /** Internal mutable state fields */
  stateFields: Field[];
  /** Message type handlers */
  handlers: ActorHandler[];
  docComment?: string;
};

/** Actor message handler defining response to a specific message type */
export type ActorHandler = {
  kind: "ActorHandler";
  /** Message type name this handler responds to */
  msgTypeName: string;
  /** Message payload parameters */
  msgParams: Param[];
  returnType: TypeExpr;
  /** Effects this handler may perform */
  effects: string[];
  body: Block;
};
