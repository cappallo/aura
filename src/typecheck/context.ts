import * as ast from "../ast";
import type { SymbolTable, ResolvedModule } from "../loader";

export type TypeCheckError = {
  message: string;
  loc?: ast.SourceLocation;
  filePath?: string;
};

export type FnSignature = {
  name: string;
  paramCount: number;
  paramNames: string[];
  effects: Set<string>;
  decl?: ast.FnDecl;
  module?: ast.Module;
};

export type TypeDeclInfo = {
  name: string;
  qualifiedName: string;
  typeParams: string[];
  decl: ast.TypeDecl;
  module: ast.Module;
};

export type VariantInfo = {
  name: string;
  qualifiedName: string;
  parentQualifiedName: string;
  typeParams: string[];
  fields: ast.Field[];
  module: ast.Module;
  parentDecl: ast.SumTypeDecl;
};

export type SumTypeInfo = {
  name: string;
  qualifiedName: string;
  typeParams: string[];
  variants: Map<string, VariantInfo>;
  decl: ast.SumTypeDecl;
  module: ast.Module;
};

export type RecordTypeInfo = {
  name: string;
  qualifiedName: string;
  typeParams: string[];
  decl: ast.RecordTypeDecl;
  module: ast.Module;
};

export type SchemaInfo = {
  name: string;
  qualifiedName: string;
  version: number;
  decl: ast.SchemaDecl;
  module: ast.Module;
};

export type TypecheckContext = {
  functions: Map<string, FnSignature>;
  declaredEffects: Set<string>;
  sumTypes: Map<string, SumTypeInfo>;
  recordTypes: Map<string, RecordTypeInfo>;
  typeDecls: Map<string, TypeDeclInfo>;
  localTypeDecls: Map<string, TypeDeclInfo>;
  variantConstructors: Map<string, VariantInfo[]>;
  schemas: Map<string, SchemaInfo>;
  currentModule?: ast.Module;
  symbolTable?: SymbolTable;
};

export type IndexedTypeInfo = {
  sumTypes: Map<string, SumTypeInfo>;
  recordTypes: Map<string, RecordTypeInfo>;
  typeDecls: Map<string, TypeDeclInfo>;
  localTypeDecls: Map<string, TypeDeclInfo>;
  variantConstructors: Map<string, VariantInfo[]>;
  schemas: Map<string, SchemaInfo>;
};

export type TypeVar = {
  kind: "Var";
  id: number;
  name?: string;
  rigid: boolean;
};

export type TypeConstructor = {
  kind: "Constructor";
  name: string;
  args: Type[];
};

export type TypeFunction = {
  kind: "Function";
  params: Type[];
  returnType: Type;
};

export type Type = TypeVar | TypeConstructor | TypeFunction;

export type TypeEnv = Map<string, Type>;

export type Substitution = Map<number, Type>;

export type InferState = {
  nextTypeVarId: number;
  substitutions: Substitution;
  errors: TypeCheckError[];
  ctx: TypecheckContext;
  currentFunction: ast.FnDecl;
  expectedReturnType: Type;
  currentFilePath?: string;
  asyncGroupDepth?: number;
  insideAsyncTask?: boolean;
};

export function makeError(message: string, loc?: ast.SourceLocation, filePath?: string): TypeCheckError {
  const error: TypeCheckError = { message };
  if (loc !== undefined) error.loc = loc;
  if (filePath !== undefined) error.filePath = filePath;
  return error;
}

export function formatLocation(loc: ast.SourceLocation): string {
  return `line ${loc.start.line}, column ${loc.start.column}`;
}

export const INT_TYPE: TypeConstructor = { kind: "Constructor", name: "Int", args: [] };
export const BOOL_TYPE: TypeConstructor = { kind: "Constructor", name: "Bool", args: [] };
export const STRING_TYPE: TypeConstructor = { kind: "Constructor", name: "String", args: [] };
export const UNIT_TYPE: TypeConstructor = { kind: "Constructor", name: "Unit", args: [] };
export const ACTOR_REF_TYPE: TypeConstructor = { kind: "Constructor", name: "ActorRef", args: [] };

export function makeFunctionType(params: Type[], returnType: Type): TypeFunction {
  return { kind: "Function", params, returnType };
}

export function makeListType(element: Type): TypeConstructor {
  return { kind: "Constructor", name: "List", args: [element] };
}

export function makeOptionType(inner: Type): TypeConstructor {
  return { kind: "Constructor", name: "Option", args: [inner] };
}

export function freshTypeVar(name: string | undefined, rigid: boolean, state: InferState): TypeVar {
  const id = state.nextTypeVarId;
  state.nextTypeVarId += 1;
  const typeVar: TypeVar = { kind: "Var", id, rigid };
  if (name !== undefined) {
    typeVar.name = name;
  }
  return typeVar;
}

export type { ResolvedModule };
