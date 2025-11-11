import * as ast from "../ast";
import type { SymbolTable } from "../loader";

/** Type checking error with optional source location */
export type TypeCheckError = {
  message: string;
  loc?: ast.SourceLocation;
  filePath?: string;
};

/** Function signature metadata for type checking calls */
export type FnSignature = {
  name: string;
  paramCount: number;
  paramNames: string[];
  /** Side effects this function may perform */
  effects: Set<string>;
  /** AST node if user-defined (undefined for builtins) */
  decl?: ast.FnDecl;
  /** Module where function is defined */
  module?: ast.Module;
};

/** Indexed type declaration information (alias, record, or sum) */
export type TypeDeclInfo = {
  name: string;
  qualifiedName: string;
  typeParams: string[];
  decl: ast.TypeDecl;
  module: ast.Module;
};

/** Indexed variant constructor information for sum type variants */
export type VariantInfo = {
  name: string;
  qualifiedName: string;
  /** Qualified name of parent sum type */
  parentQualifiedName: string;
  /** Type parameters inherited from parent */
  typeParams: string[];
  fields: ast.Field[];
  module: ast.Module;
  parentDecl: ast.SumTypeDecl;
};

/** Indexed sum type information with variant map */
export type SumTypeInfo = {
  name: string;
  qualifiedName: string;
  typeParams: string[];
  /** Map from variant name to variant info */
  variants: Map<string, VariantInfo>;
  decl: ast.SumTypeDecl;
  module: ast.Module;
};

/** Indexed record type information */
export type RecordTypeInfo = {
  name: string;
  qualifiedName: string;
  typeParams: string[];
  decl: ast.RecordTypeDecl;
  module: ast.Module;
};

/** Indexed schema information for codec generation */
export type SchemaInfo = {
  name: string;
  qualifiedName: string;
  version: number;
  decl: ast.SchemaDecl;
  module: ast.Module;
};

/** Global type checking context with all declarations indexed */
export type TypecheckContext = {
  /** All function signatures indexed by qualified name */
  functions: Map<string, FnSignature>;
  /** All declared effect names */
  declaredEffects: Set<string>;
  /** All sum types indexed by qualified name */
  sumTypes: Map<string, SumTypeInfo>;
  /** All record types indexed by qualified name */
  recordTypes: Map<string, RecordTypeInfo>;
  /** All type declarations (alias, record, sum) indexed by qualified name */
  typeDecls: Map<string, TypeDeclInfo>;
  /** Type declarations local to current module (before cross-module resolution) */
  localTypeDecls: Map<string, TypeDeclInfo>;
  /** Variant constructors indexed by name (may have multiple for ambiguous names) */
  variantConstructors: Map<string, VariantInfo[]>;
  /** All schema declarations indexed by qualified name */
  schemas: Map<string, SchemaInfo>;
  /** Current module being checked */
  currentModule?: ast.Module;
  /** Global symbol table for multi-module projects */
  symbolTable?: SymbolTable;
};

/** Subset of TypecheckContext containing only type-related information */
export type IndexedTypeInfo = {
  sumTypes: Map<string, SumTypeInfo>;
  recordTypes: Map<string, RecordTypeInfo>;
  typeDecls: Map<string, TypeDeclInfo>;
  localTypeDecls: Map<string, TypeDeclInfo>;
  variantConstructors: Map<string, VariantInfo[]>;
  schemas: Map<string, SchemaInfo>;
};

/** Type variable for Hindley-Milner type inference */
export type TypeVar = {
  kind: "Var";
  /** Unique identifier for this type variable */
  id: number;
  /** Optional descriptive name for error messages */
  name?: string;
  /** Rigid type vars cannot be unified (from user-declared type params) */
  rigid: boolean;
};

/** Type constructor application (e.g., List<Int>, Option<String>) */
export type TypeConstructor = {
  kind: "Constructor";
  /** Type constructor name (Int, Bool, List, Option, user-defined types) */
  name: string;
  /** Type arguments for parameterized types */
  args: Type[];
};

/** Function type for first-class function values */
export type TypeFunction = {
  kind: "Function";
  params: Type[];
  returnType: Type;
};

/** Union of all type representations in the type system */
export type Type = TypeVar | TypeConstructor | TypeFunction;

/** Environment mapping variable names to their inferred types */
export type TypeEnv = Map<string, Type>;

/** Substitution mapping type variable IDs to their resolved types */
export type Substitution = Map<number, Type>;

/** Mutable state threaded through type inference */
export type InferState = {
  /** Counter for generating fresh type variable IDs */
  nextTypeVarId: number;
  /** Accumulated substitutions from unification */
  substitutions: Substitution;
  /** Accumulated type errors */
  errors: TypeCheckError[];
  /** Global type checking context */
  ctx: TypecheckContext;
  /** Function currently being checked */
  currentFunction: ast.FnDecl;
  /** Expected return type for current function */
  expectedReturnType: Type;
  /** File path being checked (for error reporting) */
  currentFilePath?: string;
  /** Nesting depth of async_group blocks */
  asyncGroupDepth?: number;
  /** Whether we're inside an async task */
  insideAsyncTask?: boolean;
};

/** Create a type error with optional location and file path */
export function makeError(message: string, loc?: ast.SourceLocation, filePath?: string): TypeCheckError {
  const error: TypeCheckError = { message };
  if (loc !== undefined) error.loc = loc;
  if (filePath !== undefined) error.filePath = filePath;
  return error;
}

/** Format source location for error messages */
export function formatLocation(loc: ast.SourceLocation): string {
  return `line ${loc.start.line}, column ${loc.start.column}`;
}

// Built-in scalar types
export const INT_TYPE: TypeConstructor = { kind: "Constructor", name: "Int", args: [] };
export const BOOL_TYPE: TypeConstructor = { kind: "Constructor", name: "Bool", args: [] };
export const STRING_TYPE: TypeConstructor = { kind: "Constructor", name: "String", args: [] };
export const UNIT_TYPE: TypeConstructor = { kind: "Constructor", name: "Unit", args: [] };
export const ACTOR_REF_TYPE: TypeConstructor = { kind: "Constructor", name: "ActorRef", args: [] };

/** Construct a function type from parameter types and return type */
export function makeFunctionType(params: Type[], returnType: Type): TypeFunction {
  return { kind: "Function", params, returnType };
}

/** Construct a List<T> type */
export function makeListType(element: Type): TypeConstructor {
  return { kind: "Constructor", name: "List", args: [element] };
}

/** Construct an Option<T> type */
export function makeOptionType(inner: Type): TypeConstructor {
  return { kind: "Constructor", name: "Option", args: [inner] };
}

/** Generate a fresh type variable with unique ID for type inference */
export function freshTypeVar(name: string | undefined, rigid: boolean, state: InferState): TypeVar {
  const id = state.nextTypeVarId;
  state.nextTypeVarId += 1;
  const typeVar: TypeVar = { kind: "Var", id, rigid };
  if (name !== undefined) {
    typeVar.name = name;
  }
  return typeVar;
}
