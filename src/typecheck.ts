import * as ast from "./ast";
import type { SymbolTable, ResolvedModule } from "./loader";
import { resolveIdentifier } from "./loader";

export type TypeCheckError = {
  message: string;
  loc?: ast.SourceLocation;
  filePath?: string;
};

type FnSignature = {
  name: string;
  paramCount: number;
  paramNames: string[];
  effects: Set<string>;
  decl?: ast.FnDecl;
  module?: ast.Module;
};

type TypeDeclInfo = {
  name: string;
  qualifiedName: string;
  typeParams: string[];
  decl: ast.TypeDecl;
  module: ast.Module;
};

type VariantInfo = {
  name: string;
  qualifiedName: string;
  parentQualifiedName: string;
  typeParams: string[];
  fields: ast.Field[];
  module: ast.Module;
  parentDecl: ast.SumTypeDecl;
};

type SumTypeInfo = {
  name: string;
  qualifiedName: string;
  typeParams: string[];
  variants: Map<string, VariantInfo>;
  decl: ast.SumTypeDecl;
  module: ast.Module;
};

type RecordTypeInfo = {
  name: string;
  qualifiedName: string;
  typeParams: string[];
  decl: ast.RecordTypeDecl;
  module: ast.Module;
};

type SchemaInfo = {
  name: string;
  qualifiedName: string;
  version: number;
  decl: ast.SchemaDecl;
  module: ast.Module;
};

type TypecheckContext = {
  functions: Map<string, FnSignature>;
  declaredEffects: Set<string>;
  sumTypes: Map<string, SumTypeInfo>;
  recordTypes: Map<string, RecordTypeInfo>;
  typeDecls: Map<string, TypeDeclInfo>;
  localTypeDecls: Map<string, TypeDeclInfo>;
  variantConstructors: Map<string, VariantInfo[]>;
  schemas: Map<string, SchemaInfo>;
  // For multi-module support
  currentModule?: ast.Module;
  symbolTable?: SymbolTable;
};

type IndexedTypeInfo = {
  sumTypes: Map<string, SumTypeInfo>;
  recordTypes: Map<string, RecordTypeInfo>;
  typeDecls: Map<string, TypeDeclInfo>;
  localTypeDecls: Map<string, TypeDeclInfo>;
  variantConstructors: Map<string, VariantInfo[]>;
  schemas: Map<string, SchemaInfo>;
};

type TypeVar = {
  kind: "Var";
  id: number;
  name?: string;
  rigid: boolean;
};

type TypeConstructor = {
  kind: "Constructor";
  name: string;
  args: Type[];
};

type TypeFunction = {
  kind: "Function";
  params: Type[];
  returnType: Type;
};

type Type = TypeVar | TypeConstructor | TypeFunction;

type TypeEnv = Map<string, Type>;

type Substitution = Map<number, Type>;

type InferState = {
  nextTypeVarId: number;
  substitutions: Substitution;
  errors: TypeCheckError[];
  ctx: TypecheckContext;
  currentFunction: ast.FnDecl;
  expectedReturnType: Type;
  currentFilePath?: string;
};

function makeError(message: string, loc?: ast.SourceLocation, filePath?: string): TypeCheckError {
  const error: TypeCheckError = { message };
  if (loc !== undefined) error.loc = loc;
  if (filePath !== undefined) error.filePath = filePath;
  return error;
}

function formatLocation(loc: ast.SourceLocation): string {
  return `line ${loc.start.line}, column ${loc.start.column}`;
}

const INT_TYPE: TypeConstructor = { kind: "Constructor", name: "Int", args: [] };
const BOOL_TYPE: TypeConstructor = { kind: "Constructor", name: "Bool", args: [] };
const STRING_TYPE: TypeConstructor = { kind: "Constructor", name: "String", args: [] };
const UNIT_TYPE: TypeConstructor = { kind: "Constructor", name: "Unit", args: [] };

function makeFunctionType(params: Type[], returnType: Type): TypeFunction {
  return { kind: "Function", params, returnType };
}

function makeListType(element: Type): TypeConstructor {
  return { kind: "Constructor", name: "List", args: [element] };
}

function makeOptionType(inner: Type): TypeConstructor {
  return { kind: "Constructor", name: "Option", args: [inner] };
}

function freshTypeVar(name: string | undefined, rigid: boolean, state: InferState): TypeVar {
  const id = state.nextTypeVarId;
  state.nextTypeVarId += 1;
  const typeVar: TypeVar = { kind: "Var", id, rigid };
  if (name !== undefined) {
    typeVar.name = name;
  }
  return typeVar;
}

type BuiltinFunctionInfo = {
  arity: number | null;
  effects: Set<string>;
  instantiateType: (state: InferState) => TypeFunction;
};

const BUILTIN_FUNCTIONS: Record<string, BuiltinFunctionInfo> = {
  "list.len": {
    arity: 1,
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      return makeFunctionType([makeListType(element)], INT_TYPE);
    },
  },
  "test.assert_equal": {
    arity: 2,
    effects: new Set(),
    instantiateType: (state) => {
      const valueType = freshTypeVar("T", false, state);
      return makeFunctionType([valueType, valueType], UNIT_TYPE);
    },
  },
  assert: {
    arity: 1,
    effects: new Set(),
    instantiateType: () => makeFunctionType([BOOL_TYPE], UNIT_TYPE),
  },
  "str.concat": {
    arity: 2,
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE, STRING_TYPE], STRING_TYPE),
  },
  __negate: {
    arity: 1,
    effects: new Set(),
    instantiateType: () => makeFunctionType([INT_TYPE], INT_TYPE),
  },
  __not: {
    arity: 1,
    effects: new Set(),
    instantiateType: () => makeFunctionType([BOOL_TYPE], BOOL_TYPE),
  },
  "Log.debug": {
    arity: 2,
    effects: new Set(["Log"]),
    instantiateType: (state) => {
      const payload = freshTypeVar("Payload", false, state);
      return makeFunctionType([STRING_TYPE, payload], UNIT_TYPE);
    },
  },
  "Log.trace": {
    arity: 2,
    effects: new Set(["Log"]),
    instantiateType: (state) => {
      const payload = freshTypeVar("Payload", false, state);
      return makeFunctionType([STRING_TYPE, payload], UNIT_TYPE);
    },
  },
  "str.len": {
    arity: 1,
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE], INT_TYPE),
  },
  "str.slice": {
    arity: 3,
    effects: new Set(),
    instantiateType: () => makeFunctionType([STRING_TYPE, INT_TYPE, INT_TYPE], STRING_TYPE),
  },
  "str.at": {
    arity: 2,
    effects: new Set(),
    instantiateType: (state) => {
      const optionType = makeOptionType(STRING_TYPE);
      return makeFunctionType([STRING_TYPE, INT_TYPE], optionType);
    },
  },
  "math.abs": {
    arity: 1,
    effects: new Set(),
    instantiateType: () => makeFunctionType([INT_TYPE], INT_TYPE),
  },
  "math.min": {
    arity: 2,
    effects: new Set(),
    instantiateType: () => makeFunctionType([INT_TYPE, INT_TYPE], INT_TYPE),
  },
  "math.max": {
    arity: 2,
    effects: new Set(),
    instantiateType: () => makeFunctionType([INT_TYPE, INT_TYPE], INT_TYPE),
  },
  "list.map": {
    arity: 2,
    effects: new Set(),
    instantiateType: (state) => {
      const inputElem = freshTypeVar("A", false, state);
      const outputElem = freshTypeVar("B", false, state);
      const fnType = makeFunctionType([inputElem], outputElem);
      return makeFunctionType([makeListType(inputElem), fnType], makeListType(outputElem));
    },
  },
  "list.filter": {
    arity: 2,
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      const fnType = makeFunctionType([element], BOOL_TYPE);
      return makeFunctionType([makeListType(element), fnType], makeListType(element));
    },
  },
  "list.fold": {
    arity: 3,
    effects: new Set(),
    instantiateType: (state) => {
      const element = freshTypeVar("T", false, state);
      const accumulator = freshTypeVar("Acc", false, state);
      const fnType = makeFunctionType([accumulator, element], accumulator);
      return makeFunctionType([makeListType(element), accumulator, fnType], accumulator);
    },
  },
  "json.encode": {
    arity: 1,
    effects: new Set(),
    instantiateType: (state) => {
      const value = freshTypeVar("T", false, state);
      return makeFunctionType([value], STRING_TYPE);
    },
  },
  "json.decode": {
    arity: 1,
    effects: new Set(),
    instantiateType: (state) => {
      const resultType = freshTypeVar("T", false, state);
      return makeFunctionType([STRING_TYPE], resultType);
    },
  },
};

export function typecheckModule(module: ast.Module): TypeCheckError[] {
  const functions = collectModuleFunctions(module);
  const typeInfo = collectModuleTypeInfo(module);

  const ctx: TypecheckContext = {
    functions,
    declaredEffects: collectEffects(module.decls),
    sumTypes: typeInfo.sumTypes,
    recordTypes: typeInfo.recordTypes,
    typeDecls: typeInfo.typeDecls,
    localTypeDecls: typeInfo.localTypeDecls,
    variantConstructors: typeInfo.variantConstructors,
    schemas: typeInfo.schemas,
    currentModule: module,
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

  for (const decl of module.decls) {
    if (decl.kind === "PropertyDecl") {
      checkProperty(decl, ctx, errors);
    }
  }

  for (const decl of module.decls) {
    if (decl.kind === "SchemaDecl") {
      checkSchema(decl, ctx, errors);
    }
  }

  return errors;
}

/**
 * Typecheck multiple modules with cross-module symbol resolution
 */
export function typecheckModules(
  modules: ResolvedModule[],
  symbolTable: SymbolTable
): TypeCheckError[] {
  const errors: TypeCheckError[] = [];

  // Build global metadata by traversing all modules up front
  const globalFunctions = new Map<string, FnSignature>();
  const globalEffects = new Set<string>();
  const globalSumTypes = new Map<string, SumTypeInfo>();
  const globalRecordTypes = new Map<string, RecordTypeInfo>();
  const globalTypeDecls = new Map<string, TypeDeclInfo>();
  const globalVariantConstructors = new Map<string, VariantInfo[]>();
  const globalSchemas = new Map<string, SchemaInfo>();
  const moduleTypeCache = new Map<ast.Module, IndexedTypeInfo>();

  for (const resolvedModule of modules) {
    const module = resolvedModule.ast;
    const modulePrefix = module.name.join(".");

    for (const decl of module.decls) {
      switch (decl.kind) {
        case "FnDecl": {
          const qualifiedName = modulePrefix ? `${modulePrefix}.${decl.name}` : decl.name;
          const signature: FnSignature = {
            name: qualifiedName,
            paramCount: decl.params.length,
            paramNames: decl.params.map((param) => param.name),
            effects: new Set(decl.effects),
            decl,
            module,
          };
          globalFunctions.set(qualifiedName, signature);
          break;
        }
        case "EffectDecl": {
          const qualifiedName = modulePrefix ? `${modulePrefix}.${decl.name}` : decl.name;
          globalEffects.add(qualifiedName);
          globalEffects.add(decl.name);
          break;
        }
        default:
          break;
      }
    }

    const typeInfo = collectModuleTypeInfo(module);
    moduleTypeCache.set(module, typeInfo);

    for (const info of typeInfo.typeDecls.values()) {
      globalTypeDecls.set(info.qualifiedName, info);
    }

    for (const [key, sumInfo] of typeInfo.sumTypes.entries()) {
      if (!key.includes(".")) {
        continue;
      }
      globalSumTypes.set(key, sumInfo);
    }

    for (const [key, recordInfo] of typeInfo.recordTypes.entries()) {
      if (!key.includes(".")) {
        continue;
      }
      globalRecordTypes.set(key, recordInfo);
    }

    for (const [key, infos] of typeInfo.variantConstructors.entries()) {
      if (!key.includes(".")) {
        continue;
      }
      const existing = globalVariantConstructors.get(key);
      if (existing) {
        existing.push(...infos);
      } else {
        globalVariantConstructors.set(key, [...infos]);
      }
    }

    for (const [key, schemaInfo] of typeInfo.schemas.entries()) {
      if (!key.includes(".")) {
        continue;
      }
      globalSchemas.set(key, schemaInfo);
    }
  }

  // Add generated types from symbol table (e.g., schema-generated types like UserRecord@1)
  for (const [qualifiedName, typeDecl] of symbolTable.types.entries()) {
    if (!globalTypeDecls.has(qualifiedName)) {
      // Find which module this belongs to
      const moduleName = qualifiedName.substring(0, qualifiedName.lastIndexOf('.'));
      const foundModule = modules.find(m => m.ast.name.join('.') === moduleName);
      if (!foundModule) continue;
      
      const typeParams = typeDecl.kind === "AliasTypeDecl" || typeDecl.kind === "RecordTypeDecl" || typeDecl.kind === "SumTypeDecl"
        ? typeDecl.typeParams
        : [];
      
      const info: TypeDeclInfo = {
        name: typeDecl.name,
        qualifiedName,
        typeParams,
        decl: typeDecl,
        module: foundModule.ast,
      };
      globalTypeDecls.set(qualifiedName, info);
      
      // Also add to record types if it's a RecordTypeDecl
      if (typeDecl.kind === "RecordTypeDecl") {
        const recordInfo: RecordTypeInfo = {
          name: typeDecl.name,
          qualifiedName,
          typeParams: typeDecl.typeParams,
          decl: typeDecl,
          module: foundModule.ast,
        };
        globalRecordTypes.set(qualifiedName, recordInfo);
        
        // Add variant constructor entry for the record (so it can be used as a constructor)
        const variantInfo: VariantInfo = {
          name: typeDecl.name,
          qualifiedName,
          parentQualifiedName: qualifiedName,
          typeParams: typeDecl.typeParams,
          fields: typeDecl.fields,
          module: foundModule.ast,
          parentDecl: {
            kind: "SumTypeDecl",
            name: typeDecl.name,
            typeParams: typeDecl.typeParams,
            variants: [{
              name: typeDecl.name,
              fields: typeDecl.fields,
            }],
          } as ast.SumTypeDecl,
        };
        const existing = globalVariantConstructors.get(qualifiedName);
        if (existing) {
          existing.push(variantInfo);
        } else {
          globalVariantConstructors.set(qualifiedName, [variantInfo]);
        }
      }
    }
  }

  for (const resolvedModule of modules) {
    const module = resolvedModule.ast;
    const filePath = resolvedModule.filePath;
    const modulePrefix = module.name.join(".");
    const typeInfo = moduleTypeCache.get(module);
    const moduleFunctions = new Map(globalFunctions);
    const moduleEffects = new Set(globalEffects);
    const moduleSumTypes = new Map(globalSumTypes);
    const moduleRecordTypes = new Map(globalRecordTypes);
    const moduleTypeDecls = new Map(globalTypeDecls);
    const moduleVariantConstructors = new Map<string, VariantInfo[]>();
    const moduleSchemas = new Map(globalSchemas);
    for (const [key, infos] of globalVariantConstructors.entries()) {
      moduleVariantConstructors.set(key, [...infos]);
    }

    // Add built-in Option constructors (Some and None)
    // These work with the built-in Option<T> type
    const builtinOptionSumDecl: ast.SumTypeDecl = {
      kind: "SumTypeDecl",
      name: "Option",
      typeParams: ["T"],
      variants: [
        { name: "Some", fields: [{ name: "value", type: { kind: "TypeName", name: "T", typeArgs: [] } }] },
        { name: "None", fields: [] },
      ],
    };

    const someCtor: VariantInfo = {
      name: "Some",
      qualifiedName: "Some",
      parentQualifiedName: "Option",
      typeParams: ["T"],
      fields: [{ name: "value", type: { kind: "TypeName", name: "T", typeArgs: [] } }],
      module,
      parentDecl: builtinOptionSumDecl,
    };

    const noneCtor: VariantInfo = {
      name: "None",
      qualifiedName: "None",
      parentQualifiedName: "Option",
      typeParams: ["T"],
      fields: [],
      module,
      parentDecl: builtinOptionSumDecl,
    };

    // Add to module context (but don't override user-defined constructors with same name)
    if (!moduleVariantConstructors.has("Some")) {
      moduleVariantConstructors.set("Some", [someCtor]);
    }
    if (!moduleVariantConstructors.has("None")) {
      moduleVariantConstructors.set("None", [noneCtor]);
    }

    // Add built-in Option as a sum type for exhaustiveness checking
    if (!moduleSumTypes.has("Option")) {
      const builtinOptionInfo: SumTypeInfo = {
        name: "Option",
        qualifiedName: "Option",
        typeParams: ["T"],
        variants: new Map([
          ["Some", someCtor],
          ["None", noneCtor],
        ]),
        decl: builtinOptionSumDecl,
        module,
      };
      moduleSumTypes.set("Option", builtinOptionInfo);
    }

    for (const decl of module.decls) {
      if (decl.kind === "FnDecl") {
        const qualifiedName = modulePrefix ? `${modulePrefix}.${decl.name}` : decl.name;
        const signature = globalFunctions.get(qualifiedName);
        if (signature) {
          moduleFunctions.set(decl.name, signature);
        }
      } else if (decl.kind === "EffectDecl") {
        moduleEffects.add(decl.name);
      }
    }

    if (typeInfo) {
      for (const [key, sumInfo] of typeInfo.sumTypes.entries()) {
        moduleSumTypes.set(key, sumInfo);
      }
      for (const [key, recordInfo] of typeInfo.recordTypes.entries()) {
        moduleRecordTypes.set(key, recordInfo);
      }
      for (const [key, infos] of typeInfo.variantConstructors.entries()) {
        const existing = moduleVariantConstructors.get(key);
        if (existing) {
          existing.push(...infos);
        } else {
          moduleVariantConstructors.set(key, [...infos]);
        }
      }
    }

    const ctx: TypecheckContext = {
      functions: moduleFunctions,
      declaredEffects: moduleEffects,
      sumTypes: moduleSumTypes,
      recordTypes: moduleRecordTypes,
      typeDecls: moduleTypeDecls,
      localTypeDecls: typeInfo ? typeInfo.localTypeDecls : new Map(),
      variantConstructors: moduleVariantConstructors,
      schemas: moduleSchemas,
      currentModule: module,
      symbolTable,
    };

    for (const decl of module.decls) {
      if (decl.kind === "FnDecl") {
        checkFunction(decl, ctx, errors, filePath);
      }
    }

    for (const decl of module.decls) {
      if (decl.kind === "FnContractDecl") {
        checkContract(decl, ctx, errors);
      }
    }

    for (const decl of module.decls) {
      if (decl.kind === "PropertyDecl") {
        checkProperty(decl, ctx, errors, filePath);
      }
    }

    for (const decl of module.decls) {
      if (decl.kind === "SchemaDecl") {
        checkSchema(decl, ctx, errors, filePath);
      }
    }
  }

  return errors;
}

function collectModuleFunctions(module: ast.Module): Map<string, FnSignature> {
  const map = new Map<string, FnSignature>();
  const modulePrefix = module.name.join(".");
  for (const decl of module.decls) {
    if (decl.kind !== "FnDecl") {
      continue;
    }
    const qualifiedName = modulePrefix ? `${modulePrefix}.${decl.name}` : decl.name;
    const signature: FnSignature = {
      name: qualifiedName,
      paramCount: decl.params.length,
      paramNames: decl.params.map((param) => param.name),
      effects: new Set(decl.effects),
      decl,
      module,
    };
    map.set(qualifiedName, signature);
    map.set(decl.name, signature);
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

function collectModuleTypeInfo(module: ast.Module): IndexedTypeInfo {
  const sumTypes = new Map<string, SumTypeInfo>();
  const recordTypes = new Map<string, RecordTypeInfo>();
  const typeDecls = new Map<string, TypeDeclInfo>();
  const localTypeDecls = new Map<string, TypeDeclInfo>();
  const variantConstructors = new Map<string, VariantInfo[]>();
  const schemas = new Map<string, SchemaInfo>();

  const modulePrefix = module.name.join(".");

  const addVariantMapping = (key: string, info: VariantInfo): void => {
    const existing = variantConstructors.get(key);
    if (existing) {
      existing.push(info);
    } else {
      variantConstructors.set(key, [info]);
    }
  };

  // Collect schemas
  for (const decl of module.decls) {
    if (decl.kind === "SchemaDecl") {
      const qualifiedName = modulePrefix ? `${modulePrefix}.${decl.name}` : decl.name;
      const schemaInfo: SchemaInfo = {
        name: decl.name,
        qualifiedName,
        version: decl.version,
        decl,
        module,
      };
      schemas.set(decl.name, schemaInfo);
      schemas.set(qualifiedName, schemaInfo);
      // Also add versioned name
      const versionedName = `${decl.name}@${decl.version}`;
      const versionedQualifiedName = modulePrefix ? `${modulePrefix}.${versionedName}` : versionedName;
      const versionedInfo: SchemaInfo = {
        name: versionedName,
        qualifiedName: versionedQualifiedName,
        version: decl.version,
        decl,
        module,
      };
      schemas.set(versionedName, versionedInfo);
      schemas.set(versionedQualifiedName, versionedInfo);
    }
  }

  for (const decl of module.decls) {
    if (decl.kind !== "AliasTypeDecl" && decl.kind !== "RecordTypeDecl" && decl.kind !== "SumTypeDecl") {
      continue;
    }

    const qualifiedName = modulePrefix ? `${modulePrefix}.${decl.name}` : decl.name;
    const typeDeclInfo: TypeDeclInfo = {
      name: decl.name,
      qualifiedName,
      typeParams: decl.typeParams,
      decl,
      module,
    };
  typeDecls.set(qualifiedName, typeDeclInfo);
    localTypeDecls.set(decl.name, typeDeclInfo);

    if (decl.kind === "RecordTypeDecl") {
      const recordInfo: RecordTypeInfo = {
        name: decl.name,
        qualifiedName,
        typeParams: decl.typeParams,
        decl,
        module,
      };
      recordTypes.set(decl.name, recordInfo);
      recordTypes.set(qualifiedName, recordInfo);
      continue;
    }

    if (decl.kind === "SumTypeDecl") {
      const variantsMap = new Map<string, VariantInfo>();
      for (const variant of decl.variants) {
        const variantQualifiedName = `${qualifiedName}.${variant.name}`;
        const variantInfo: VariantInfo = {
          name: variant.name,
          qualifiedName: variantQualifiedName,
          parentQualifiedName: qualifiedName,
          typeParams: decl.typeParams,
          fields: variant.fields,
          module,
          parentDecl: decl,
        };
        variantsMap.set(variant.name, variantInfo);
        addVariantMapping(variant.name, variantInfo);
        addVariantMapping(variantQualifiedName, variantInfo);
        if (decl.name !== variant.name) {
          addVariantMapping(`${decl.name}.${variant.name}`, variantInfo);
        }
      }
      const sumInfo: SumTypeInfo = {
        name: decl.name,
        qualifiedName,
        typeParams: decl.typeParams,
        variants: variantsMap,
        decl,
        module,
      };
      sumTypes.set(decl.name, sumInfo);
      sumTypes.set(qualifiedName, sumInfo);
    }
  }

  return {
    sumTypes,
    recordTypes,
    typeDecls,
    localTypeDecls,
    variantConstructors,
    schemas,
  };
}

function checkFunction(fn: ast.FnDecl, ctx: TypecheckContext, errors: TypeCheckError[], filePath?: string) {
  verifyDeclaredEffects(fn, ctx, errors, filePath);
  typeCheckFunctionBody(fn, ctx, errors, filePath);
}

function checkProperty(
  property: ast.PropertyDecl,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  filePath?: string,
): void {
  const syntheticFn: ast.FnDecl = {
    kind: "FnDecl",
    name: `__property_${property.name}`,
    typeParams: [],
    params: property.params.map((param) => ({ name: param.name, type: param.type })),
    returnType: { kind: "TypeName", name: "Unit", typeArgs: [] },
    effects: [],
    body: property.body,
  };

  const state: InferState = {
    nextTypeVarId: 0,
    substitutions: new Map(),
    errors,
    ctx,
    currentFunction: syntheticFn,
    expectedReturnType: UNIT_TYPE,
  };

  if (filePath !== undefined) {
    state.currentFilePath = filePath;
  }

  const env: TypeEnv = new Map();
  const typeParamScope = new Map<string, Type>();
  const resolutionModule = ctx.currentModule;

  for (const param of syntheticFn.params) {
    const paramType = convertTypeExpr(param.type, typeParamScope, state, resolutionModule);
    env.set(param.name, paramType);
  }

  for (const param of property.params) {
    if (!param.predicate) {
      continue;
    }
    const predicateType = inferExpr(param.predicate, env, state);
    unify(
      predicateType,
      BOOL_TYPE,
      state,
      `Predicate for parameter '${param.name}' must evaluate to Bool`,
      param.predicate.loc,
    );
  }

  inferBlock(property.body, env, state, {
    expectedReturnType: UNIT_TYPE,
    treatAsExpression: false,
    cloneEnv: false,
  });
}

function checkSchema(
  schema: ast.SchemaDecl,
  ctx: TypecheckContext,
  errors: TypeCheckError[],
  filePath?: string,
): void {
  // Validate version is positive
  if (schema.version <= 0) {
    errors.push(makeError(
      `Schema '${schema.name}' version must be positive, got ${schema.version}`,
      undefined,
      filePath
    ));
  }

  // Validate field types are valid
  const state: InferState = {
    nextTypeVarId: 0,
    substitutions: new Map(),
    errors,
    ctx,
    currentFunction: undefined as any, // Not needed for schema checking
    expectedReturnType: UNIT_TYPE,
  };

  if (filePath !== undefined) {
    state.currentFilePath = filePath;
  }

  const typeParamScope = new Map<string, Type>();
  const resolutionModule = ctx.currentModule;

  for (const field of schema.fields) {
    try {
      convertTypeExpr(field.type, typeParamScope, state, resolutionModule);
    } catch (err) {
      errors.push(makeError(
        `Schema '${schema.name}' field '${field.name}' has invalid type`,
        undefined,
        filePath
      ));
    }
  }
}

function verifyDeclaredEffects(fn: ast.FnDecl, ctx: TypecheckContext, errors: TypeCheckError[], filePath?: string) {
  if (fn.effects.length === 0) {
    return;
  }
  for (const effect of fn.effects) {
    if (!ctx.declaredEffects.has(effect)) {
      errors.push(makeError(`Function '${fn.name}' declares unknown effect '${effect}'`, undefined, filePath));
    }
  }
}

type BlockResult = {
  valueType: Type;
  returned: boolean;
};

type StatementResult = {
  valueType: Type;
  returned: boolean;
};

type BlockOptions = {
  expectedReturnType: Type;
  treatAsExpression: boolean;
  cloneEnv?: boolean;
};

function typeCheckFunctionBody(fn: ast.FnDecl, ctx: TypecheckContext, errors: TypeCheckError[], filePath?: string): void {
  const state: InferState = {
    nextTypeVarId: 0,
    substitutions: new Map(),
    errors,
    ctx,
    currentFunction: fn,
    expectedReturnType: UNIT_TYPE,
  };
  if (filePath !== undefined) {
    state.currentFilePath = filePath;
  }

  const typeParamScope = new Map<string, Type>();
  for (const paramName of fn.typeParams) {
    typeParamScope.set(paramName, freshTypeVar(paramName, true, state));
  }

  const env: TypeEnv = new Map();
  const resolutionModule = ctx.currentModule;

  for (const param of fn.params) {
    const paramType = convertTypeExpr(param.type, typeParamScope, state, resolutionModule);
    env.set(param.name, paramType);
  }

  const declaredReturnType = convertTypeExpr(fn.returnType, typeParamScope, state, resolutionModule);
  state.expectedReturnType = declaredReturnType;

  inferBlock(fn.body, env, state, {
    expectedReturnType: declaredReturnType,
    treatAsExpression: false,
    cloneEnv: false,
  });
}

function instantiateFunctionSignature(
  signature: FnSignature,
  state: InferState,
  rigid: boolean,
): { params: Type[]; returnType: Type } | null {
  if (!signature.decl) {
    return null;
  }

  const typeParamScope = new Map<string, Type>();
  for (const paramName of signature.decl.typeParams) {
    typeParamScope.set(paramName, freshTypeVar(paramName, rigid, state));
  }

  const resolutionModule = signature.module ?? state.ctx.currentModule;

  const params = signature.decl.params.map((param) =>
    convertTypeExpr(param.type, typeParamScope, state, resolutionModule)
  );
  const returnType = convertTypeExpr(signature.decl.returnType, typeParamScope, state, resolutionModule);

  return { params, returnType };
}

function inferBlock(block: ast.Block, env: TypeEnv, state: InferState, options: BlockOptions): BlockResult {
  const workingEnv = options.cloneEnv ? new Map(env) : env;
  let returned = false;
  let lastValue: Type = UNIT_TYPE;
  const expectedReturnType = options.expectedReturnType ?? state.expectedReturnType;

  for (const stmt of block.stmts) {
    const result = inferStmt(stmt, workingEnv, state, expectedReturnType);
    lastValue = result.valueType;
    if (result.returned) {
      returned = true;
    }
  }

  if (!options.treatAsExpression && !returned) {
    return { valueType: UNIT_TYPE, returned };
  }

  return { valueType: applySubstitution(lastValue, state), returned };
}

function inferStmt(
  stmt: ast.Stmt,
  env: TypeEnv,
  state: InferState,
  expectedReturnType: Type,
): StatementResult {
  switch (stmt.kind) {
    case "LetStmt": {
      const exprType = inferExpr(stmt.expr, env, state);
      env.set(stmt.name, exprType);
      return { valueType: UNIT_TYPE, returned: false };
    }
    case "ReturnStmt": {
      const exprType = inferExpr(stmt.expr, env, state);
      unify(exprType, expectedReturnType, state, `Return type mismatch in function '${state.currentFunction.name}'`, stmt.loc);
      return { valueType: exprType, returned: true };
    }
    case "ExprStmt": {
      const exprType = inferExpr(stmt.expr, env, state);
      return { valueType: exprType, returned: false };
    }
    case "MatchStmt": {
      return inferMatchStmt(stmt, env, state, expectedReturnType);
    }
    default: {
      const exhaustive: never = stmt;
      throw new Error(`Unsupported statement kind: ${(exhaustive as ast.Stmt).kind}`);
    }
  }
}

function inferMatchStmt(
  stmt: ast.MatchStmt,
  env: TypeEnv,
  state: InferState,
  expectedReturnType: Type,
): StatementResult {
  const scrutineeType = inferExpr(stmt.scrutinee, env, state);
  checkMatchExhaustiveness(stmt, state.ctx, state.errors);

  let allReturn = true;
  let accumulatedType: Type | null = null;

  for (const matchCase of stmt.cases) {
    const caseEnv = new Map(env);
    bindPattern(matchCase.pattern, scrutineeType, caseEnv, state);
    const caseResult = inferBlock(matchCase.body, caseEnv, state, {
      expectedReturnType,
      treatAsExpression: true,
      cloneEnv: false,
    });

    if (!caseResult.returned) {
      allReturn = false;
      if (accumulatedType === null) {
        accumulatedType = caseResult.valueType;
      } else {
        unify(
          caseResult.valueType,
          accumulatedType,
          state,
          `Match case result mismatch in function '${state.currentFunction.name}'`,
        );
        accumulatedType = applySubstitution(accumulatedType, state);
      }
    }
  }

  if (allReturn) {
    return { valueType: expectedReturnType, returned: true };
  }

  return {
    valueType: accumulatedType ? applySubstitution(accumulatedType, state) : UNIT_TYPE,
    returned: false,
  };
}

function inferExpr(expr: ast.Expr, env: TypeEnv, state: InferState): Type {
  switch (expr.kind) {
    case "IntLiteral":
      return INT_TYPE;
    case "BoolLiteral":
      return BOOL_TYPE;
    case "StringLiteral":
      return STRING_TYPE;
    case "VarRef": {
      const binding = env.get(expr.name);
      if (!binding) {
        state.errors.push(makeError(
          `Unknown variable '${expr.name}' in function '${state.currentFunction.name}'`,
          expr.loc,
          state.currentFilePath
        ));
        return freshTypeVar(expr.name, false, state);
      }
      return applySubstitution(binding, state);
    }
    case "ListLiteral": {
      const elementType = freshTypeVar("ListElement", false, state);
      for (const element of expr.elements) {
        const elementExprType = inferExpr(element, env, state);
        unify(
          elementExprType,
          elementType,
          state,
          `List element type mismatch in function '${state.currentFunction.name}'`,
        );
      }
      return makeListType(applySubstitution(elementType, state));
    }
    case "BinaryExpr":
      return inferBinaryExpr(expr, env, state);
    case "CallExpr":
      return inferCallExpr(expr, env, state);
    case "RecordExpr":
      return inferRecordExpr(expr, env, state);
    case "FieldAccessExpr":
      return inferFieldAccess(expr, env, state);
    case "IndexExpr":
      return inferIndexExpr(expr, env, state);
    case "IfExpr":
      return inferIfExpr(expr, env, state);
    default: {
      const exhaustive: never = expr;
      throw new Error(`Unsupported expression kind: ${(exhaustive as ast.Expr).kind}`);
    }
  }
}

function inferBinaryExpr(expr: ast.BinaryExpr, env: TypeEnv, state: InferState): Type {
  const leftType = inferExpr(expr.left, env, state);
  const rightType = inferExpr(expr.right, env, state);

  const numericOperators = new Set(["+", "-", "*", "/"]);
  const comparisonOperators = new Set([">", "<", ">=", "<="]);
  const logicalOperators = new Set(["&&", "||"]);

  if (numericOperators.has(expr.op)) {
    unify(leftType, INT_TYPE, state, `Left operand of '${expr.op}' must be Int`);
    unify(rightType, INT_TYPE, state, `Right operand of '${expr.op}' must be Int`);
    return INT_TYPE;
  }

  if (comparisonOperators.has(expr.op)) {
    unify(leftType, INT_TYPE, state, `Left operand of '${expr.op}' must be Int`);
    unify(rightType, INT_TYPE, state, `Right operand of '${expr.op}' must be Int`);
    return BOOL_TYPE;
  }

  if (logicalOperators.has(expr.op)) {
    unify(leftType, BOOL_TYPE, state, `Left operand of '${expr.op}' must be Bool`);
    unify(rightType, BOOL_TYPE, state, `Right operand of '${expr.op}' must be Bool`);
    return BOOL_TYPE;
  }

  if (expr.op === "==" || expr.op === "!=") {
    unify(
      leftType,
      rightType,
      state,
      `Operands of '${expr.op}' must have the same type in function '${state.currentFunction.name}'`,
    );
    return BOOL_TYPE;
  }

  state.errors.push({
    message: `Unsupported binary operator '${expr.op}' in function '${state.currentFunction.name}'`,
  });
  return freshTypeVar("UnknownBinaryResult", false, state);
}

function inferCallExpr(expr: ast.CallExpr, env: TypeEnv, state: InferState): Type {
  const builtin = BUILTIN_FUNCTIONS[expr.callee];
  if (builtin) {
    if (builtin.arity !== null && builtin.arity !== expr.args.length) {
      state.errors.push({
        message: `Builtin '${expr.callee}' expects ${builtin.arity} arguments but got ${expr.args.length}`,
      });
    }
    const instantiated = builtin.instantiateType(state);
    verifyEffectSubset(builtin.effects, state.currentFunction.effects, expr.callee, state.currentFunction.name, state.errors);
    expr.args.forEach((arg, index) => {
      const argType = inferExpr(arg, env, state);
      const expectedParam = instantiated.params[index] ?? freshTypeVar("BuiltinArg", false, state);
      unify(
        argType,
        expectedParam,
        state,
        `Argument ${index + 1} of builtin '${expr.callee}' has incompatible type`,
        arg.loc,
      );
    });
    return applySubstitution(instantiated.returnType, state);
  }

  const ctx = state.ctx;
  let resolvedName = expr.callee;
  if (ctx.currentModule && ctx.symbolTable) {
    resolvedName = resolveIdentifier(expr.callee, ctx.currentModule, ctx.symbolTable);
  }

  const signature = ctx.functions.get(resolvedName) ?? ctx.functions.get(expr.callee);
  if (!signature) {
    state.errors.push(makeError(`Unknown function '${expr.callee}'`, expr.loc, state.currentFilePath));
    return freshTypeVar("UnknownCall", false, state);
  }

  if (signature.paramCount !== expr.args.length) {
    state.errors.push(makeError(
      `Function '${expr.callee}' expects ${signature.paramCount} arguments but got ${expr.args.length}`,
      expr.loc,
      state.currentFilePath
    ));
  }

  verifyEffectSubset(signature.effects, state.currentFunction.effects, expr.callee, state.currentFunction.name, state.errors);

  const instantiated = instantiateFunctionSignature(signature, state, false);
  if (!instantiated) {
    state.errors.push({ message: `Cannot instantiate function '${expr.callee}'` });
    return freshTypeVar("UnknownCall", false, state);
  }

  for (let i = 0; i < expr.args.length; i += 1) {
    const argExpr = expr.args[i]!;
    const argType = inferExpr(argExpr, env, state);
    const expectedParam = instantiated.params[i] ?? freshTypeVar("Param", false, state);
    unify(
      argType,
      expectedParam,
      state,
      `Argument ${i + 1} of function '${expr.callee}' has incompatible type`,
      argExpr.loc,
    );
  }

  return applySubstitution(instantiated.returnType, state);
}

function inferRecordExpr(expr: ast.RecordExpr, env: TypeEnv, state: InferState): Type {
  const variantInfo = resolveVariant(expr.typeName, state);
  if (variantInfo) {
    const typeParamScope = new Map<string, Type>();
    for (const paramName of variantInfo.typeParams) {
      typeParamScope.set(paramName, freshTypeVar(paramName, false, state));
    }

    const fieldTypes = new Map<string, Type>();
    for (const field of variantInfo.fields) {
      fieldTypes.set(
        field.name,
        convertTypeExpr(field.type, typeParamScope, state, variantInfo.module),
      );
    }

    const resultType: Type = {
      kind: "Constructor",
      name: variantInfo.parentQualifiedName,
      args: variantInfo.typeParams.map((paramName) => typeParamScope.get(paramName)!),
    };

    const providedFields = new Set<string>();

    for (const fieldExpr of expr.fields) {
      const expectedType = fieldTypes.get(fieldExpr.name);
      if (!expectedType) {
        state.errors.push({
          message: `Constructor '${expr.typeName}' has no field named '${fieldExpr.name}'`,
        });
        continue;
      }
      const actualType = inferExpr(fieldExpr.expr, env, state);
      unify(
        actualType,
        expectedType,
        state,
        `Field '${fieldExpr.name}' on constructor '${expr.typeName}' has incompatible type`,
      );
      providedFields.add(fieldExpr.name);
    }

    for (const field of variantInfo.fields) {
      if (!providedFields.has(field.name)) {
        state.errors.push({
          message: `Constructor '${expr.typeName}' is missing value for field '${field.name}'`,
        });
      }
    }

    return applySubstitution(resultType, state);
  }

  const recordInfo = resolveRecordType(expr.typeName, state);
  if (!recordInfo) {
    state.errors.push({ message: `Unknown constructor '${expr.typeName}'` });
    return freshTypeVar(expr.typeName, false, state);
  }

  const typeParamScope = new Map<string, Type>();
  for (const paramName of recordInfo.typeParams) {
    typeParamScope.set(paramName, freshTypeVar(paramName, false, state));
  }

  const expectedFields = new Map<string, Type>();
  for (const field of recordInfo.decl.fields) {
    expectedFields.set(
      field.name,
      convertTypeExpr(field.type, typeParamScope, state, recordInfo.module),
    );
  }

  const providedFields = new Set<string>();

  for (const fieldExpr of expr.fields) {
    const expectedType = expectedFields.get(fieldExpr.name);
    if (!expectedType) {
      state.errors.push({
        message: `Record '${expr.typeName}' has no field named '${fieldExpr.name}'`,
      });
      continue;
    }
    const actualType = inferExpr(fieldExpr.expr, env, state);
    unify(
      actualType,
      expectedType,
      state,
      `Field '${fieldExpr.name}' on record '${expr.typeName}' has incompatible type`,
    );
    providedFields.add(fieldExpr.name);
  }

  for (const fieldName of expectedFields.keys()) {
    if (!providedFields.has(fieldName)) {
      state.errors.push({
        message: `Record '${expr.typeName}' is missing value for field '${fieldName}'`,
      });
    }
  }

  const resultType: Type = {
    kind: "Constructor",
    name: recordInfo.qualifiedName,
    args: recordInfo.typeParams.map((paramName) => typeParamScope.get(paramName)!),
  };

  return applySubstitution(resultType, state);
}

function inferFieldAccess(expr: ast.FieldAccessExpr, env: TypeEnv, state: InferState): Type {
  const targetType = inferExpr(expr.target, env, state);
  const resolvedTarget = applySubstitution(targetType, state);

  if (resolvedTarget.kind !== "Constructor") {
    state.errors.push({
      message: `Cannot access field '${expr.field}' on non-record value`,
    });
    return freshTypeVar("FieldAccess", false, state);
  }

  const recordInfo = resolveRecordType(resolvedTarget.name, state);
  if (!recordInfo) {
    state.errors.push({
      message: `Cannot resolve record type for field access '${expr.field}'`,
    });
    return freshTypeVar("FieldAccess", false, state);
  }

  const fieldDecl = recordInfo.decl.fields.find((field) => field.name === expr.field);
  if (!fieldDecl) {
    state.errors.push({
      message: `Record '${recordInfo.name}' has no field named '${expr.field}'`,
    });
    return freshTypeVar("FieldAccess", false, state);
  }

  const typeParamScope = new Map<string, Type>();
  recordInfo.typeParams.forEach((paramName, index) => {
    const argType = resolvedTarget.args[index];
    typeParamScope.set(paramName, argType ?? freshTypeVar(paramName, false, state));
  });

  const fieldType = convertTypeExpr(fieldDecl.type, typeParamScope, state, recordInfo.module);
  return applySubstitution(fieldType, state);
}

function inferIfExpr(expr: ast.IfExpr, env: TypeEnv, state: InferState): Type {
  const condType = inferExpr(expr.cond, env, state);
  unify(condType, BOOL_TYPE, state, "If condition must be a Bool");

  const thenEnv = new Map(env);
  const thenResult = inferBlock(expr.thenBranch, thenEnv, state, {
    expectedReturnType: state.expectedReturnType,
    treatAsExpression: true,
    cloneEnv: false,
  });

  if (!expr.elseBranch) {
    return UNIT_TYPE;
  }

  const elseEnv = new Map(env);
  const elseResult = inferBlock(expr.elseBranch, elseEnv, state, {
    expectedReturnType: state.expectedReturnType,
    treatAsExpression: true,
    cloneEnv: false,
  });

  unify(
    thenResult.valueType,
    elseResult.valueType,
    state,
    "If expression branches must produce the same type",
  );

  return applySubstitution(thenResult.valueType, state);
}

function inferIndexExpr(expr: ast.IndexExpr, env: TypeEnv, state: InferState): Type {
  const targetType = inferExpr(expr.target, env, state);
  const indexType = inferExpr(expr.index, env, state);
  unify(indexType, INT_TYPE, state, "List index must be Int");

  const elementType = freshTypeVar("ListElement", false, state);
  unify(targetType, makeListType(elementType), state, "Indexing is only supported on lists");
  return applySubstitution(elementType, state);
}

function bindPattern(pattern: ast.Pattern, valueType: Type, env: TypeEnv, state: InferState): void {
  switch (pattern.kind) {
    case "WildcardPattern":
      return;
    case "VarPattern": {
      env.set(pattern.name, valueType);
      return;
    }
    case "CtorPattern": {
      const variantInfo = resolveVariant(pattern.ctorName, state);
      if (!variantInfo) {
        state.errors.push({ message: `Unknown constructor '${pattern.ctorName}'` });
        return;
      }

      const typeParamScope = new Map<string, Type>();
      for (const paramName of variantInfo.typeParams) {
        typeParamScope.set(paramName, freshTypeVar(paramName, false, state));
      }

      const variantType: Type = {
        kind: "Constructor",
        name: variantInfo.parentQualifiedName,
        args: variantInfo.typeParams.map((param) => typeParamScope.get(param)!),
      };

      unify(valueType, variantType, state, `Pattern constructor '${pattern.ctorName}' does not match scrutinee type`);

      const fieldTypes = new Map<string, Type>();
      for (const field of variantInfo.fields) {
        fieldTypes.set(
          field.name,
          convertTypeExpr(field.type, typeParamScope, state, variantInfo.module),
        );
      }

      for (const fieldPattern of pattern.fields) {
        const expectedType = fieldTypes.get(fieldPattern.name);
        if (!expectedType) {
          state.errors.push({
            message: `Constructor '${pattern.ctorName}' has no field named '${fieldPattern.name}'`,
          });
          continue;
        }
        bindPattern(fieldPattern.pattern, expectedType, env, state);
      }
      return;
    }
    default: {
      const exhaustive: never = pattern;
      throw new Error(`Unsupported pattern kind: ${(exhaustive as ast.Pattern).kind}`);
    }
  }
}

const BUILTIN_SCALAR_TYPES = new Map<string, TypeConstructor>([
  ["Int", INT_TYPE],
  ["Bool", BOOL_TYPE],
  ["String", STRING_TYPE],
  ["Unit", UNIT_TYPE],
]);

function convertTypeExpr(
  typeExpr: ast.TypeExpr,
  scope: Map<string, Type>,
  state: InferState,
  module: ast.Module | undefined,
): Type {
  switch (typeExpr.kind) {
    case "TypeName": {
      const scoped = scope.get(typeExpr.name);
      if (scoped) {
        return scoped;
      }

      const builtinScalar = BUILTIN_SCALAR_TYPES.get(typeExpr.name);
      if (builtinScalar && typeExpr.typeArgs.length === 0) {
        return builtinScalar;
      }

      if (typeExpr.name === "List") {
        if (typeExpr.typeArgs.length !== 1) {
          state.errors.push({ message: "List expects exactly one type argument" });
          return makeListType(freshTypeVar("ListElem", false, state));
        }
        const inner = convertTypeExpr(typeExpr.typeArgs[0]!, scope, state, module);
        return makeListType(inner);
      }

      if (typeExpr.name === "Option") {
        if (typeExpr.typeArgs.length !== 1) {
          state.errors.push({ message: "Option expects exactly one type argument" });
          return makeOptionType(freshTypeVar("OptionElem", false, state));
        }
        const inner = convertTypeExpr(typeExpr.typeArgs[0]!, scope, state, module);
        return makeOptionType(inner);
      }

      const declInfo = findTypeDecl(typeExpr.name, state.ctx, module);
      if (!declInfo) {
        state.errors.push({
          message: `Unknown type '${typeExpr.name}' in function '${state.currentFunction.name}'`,
        });
        return freshTypeVar(typeExpr.name, false, state);
      }

      if (declInfo.decl.kind === "AliasTypeDecl") {
        const aliasDecl = declInfo.decl;
        if (aliasDecl.typeParams.length !== typeExpr.typeArgs.length) {
          state.errors.push({
            message: `Type alias '${aliasDecl.name}' expects ${aliasDecl.typeParams.length} type arguments`,
          });
        }
        const aliasScope = new Map(scope);
        aliasDecl.typeParams.forEach((paramName, index) => {
          const argExpr = typeExpr.typeArgs[index];
          const argType = argExpr
            ? convertTypeExpr(argExpr, scope, state, declInfo.module)
            : freshTypeVar(paramName, false, state);
          aliasScope.set(paramName, argType);
        });
        return convertTypeExpr(aliasDecl.target, aliasScope, state, declInfo.module);
      }

      if (declInfo.decl.kind === "RecordTypeDecl" || declInfo.decl.kind === "SumTypeDecl") {
        const expectedArgs = declInfo.typeParams.length;
        if (expectedArgs !== typeExpr.typeArgs.length) {
          state.errors.push({
            message: `Type '${declInfo.name}' expects ${expectedArgs} type arguments`,
          });
        }
        const args = declInfo.typeParams.map((paramName, index) => {
          const argExpr = typeExpr.typeArgs[index];
          return argExpr
            ? convertTypeExpr(argExpr, scope, state, declInfo.module)
            : freshTypeVar(paramName, false, state);
        });
        return { kind: "Constructor", name: declInfo.qualifiedName, args };
      }

      return freshTypeVar(typeExpr.name, false, state);
    }
    case "OptionalType": {
      const inner = convertTypeExpr(typeExpr.inner, scope, state, module);
      return makeOptionType(inner);
    }
    default: {
      const exhaustive: never = typeExpr;
      throw new Error(`Unsupported type expression kind: ${(exhaustive as ast.TypeExpr).kind}`);
    }
  }
}

function findTypeDecl(
  name: string,
  ctx: TypecheckContext,
  module: ast.Module | undefined,
): TypeDeclInfo | undefined {
  if (ctx.typeDecls.has(name)) {
    return ctx.typeDecls.get(name);
  }

  const local = ctx.localTypeDecls.get(name);
  if (local) {
    return local;
  }

  if (module && ctx.symbolTable) {
    const resolved = resolveIdentifier(name, module, ctx.symbolTable);
    return ctx.typeDecls.get(resolved);
  }

  return undefined;
}

function resolveRecordType(name: string, state: InferState): RecordTypeInfo | undefined {
  const direct = state.ctx.recordTypes.get(name);
  if (direct) {
    return direct;
  }

  if (state.ctx.currentModule && state.ctx.symbolTable) {
    const resolved = resolveIdentifier(name, state.ctx.currentModule, state.ctx.symbolTable);
    return state.ctx.recordTypes.get(resolved);
  }

  return undefined;
}

function resolveVariant(name: string, state: InferState): VariantInfo | undefined {
  const direct = state.ctx.variantConstructors.get(name);
  if (direct && direct.length === 1) {
    return direct[0];
  }

  if (direct && direct.length > 1) {
    state.errors.push({ message: `Ambiguous constructor '${name}'` });
    return direct[0];
  }

  if (state.ctx.currentModule && state.ctx.symbolTable) {
    const resolved = resolveIdentifier(name, state.ctx.currentModule, state.ctx.symbolTable);
    const resolvedMatch = state.ctx.variantConstructors.get(resolved);
    if (resolvedMatch && resolvedMatch.length > 0) {
      return resolvedMatch[0];
    }
  }

  return undefined;
}

function prune(type: Type, state: InferState): Type {
  if (type.kind === "Var") {
    const replacement = state.substitutions.get(type.id);
    if (replacement) {
      const pruned = prune(replacement, state);
      state.substitutions.set(type.id, pruned);
      return pruned;
    }
  }
  return type;
}

function applySubstitution(type: Type, state: InferState): Type {
  const pruned = prune(type, state);
  if (pruned.kind === "Constructor") {
    return {
      kind: "Constructor",
      name: pruned.name,
      args: pruned.args.map((arg) => applySubstitution(arg, state)),
    };
  }
  if (pruned.kind === "Function") {
    return {
      kind: "Function",
      params: pruned.params.map((param) => applySubstitution(param, state)),
      returnType: applySubstitution(pruned.returnType, state),
    };
  }
  return pruned;
}

function occursInType(typeVar: TypeVar, type: Type, state: InferState): boolean {
  const target = prune(type, state);
  if (target.kind === "Var") {
    return target.id === typeVar.id;
  }
  if (target.kind === "Constructor") {
    return target.args.some((arg) => occursInType(typeVar, arg, state));
  }
  if (target.kind === "Function") {
    return (
      target.params.some((param) => occursInType(typeVar, param, state)) ||
      occursInType(typeVar, target.returnType, state)
    );
  }
  return false;
}

function unify(left: Type, right: Type, state: InferState, context?: string, loc?: ast.SourceLocation): void {
  const a = prune(left, state);
  const b = prune(right, state);

  if (a === b) {
    return;
  }

  if (a.kind === "Var") {
    if (b.kind === "Var" && a.id === b.id) {
      return;
    }
    if (a.rigid) {
      reportUnificationError(a, b, state, context ?? "Cannot unify rigid type variable", loc);
      return;
    }
    if (occursInType(a, b, state)) {
      reportUnificationError(a, b, state, context ?? "Occurs check failed", loc);
      return;
    }
    state.substitutions.set(a.id, b);
    return;
  }

  if (b.kind === "Var") {
    unify(b, a, state, context, loc);
    return;
  }

  if (a.kind === "Constructor" && b.kind === "Constructor") {
    if (a.name !== b.name || a.args.length !== b.args.length) {
      reportUnificationError(a, b, state, context ?? "Type constructor mismatch", loc);
      return;
    }
    for (let i = 0; i < a.args.length; i += 1) {
      unify(a.args[i]!, b.args[i]!, state, context, loc);
    }
    return;
  }

  if (a.kind === "Function" && b.kind === "Function") {
    if (a.params.length !== b.params.length) {
      reportUnificationError(a, b, state, context ?? "Function arity mismatch", loc);
      return;
    }
    for (let i = 0; i < a.params.length; i += 1) {
      unify(a.params[i]!, b.params[i]!, state, context, loc);
    }
    unify(a.returnType, b.returnType, state, context, loc);
    return;
  }

  reportUnificationError(a, b, state, context ?? "Type mismatch", loc);
}

function reportUnificationError(left: Type, right: Type, state: InferState, context: string, loc?: ast.SourceLocation): void {
  const leftStr = typeToString(applySubstitution(left, state));
  const rightStr = typeToString(applySubstitution(right, state));
  state.errors.push(makeError(`${context}: ${leftStr} vs ${rightStr}`, loc, state.currentFilePath));
}

function typeToString(type: Type): string {
  switch (type.kind) {
    case "Var":
      return type.name ?? `t${type.id}`;
    case "Constructor":
      if (type.args.length === 0) {
        return type.name;
      }
      return `${type.name}<${type.args.map((arg) => typeToString(arg)).join(", ")}>`;
    case "Function":
      return `(${type.params.map((param) => typeToString(param)).join(", ")}) -> ${typeToString(type.returnType)}`;
    default: {
      const exhaustive: never = type;
      return (exhaustive as Type).kind;
    }
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
          for (const variantName of typeInfo.variants.keys()) {
            if (!coveredCtors.has(variantName)) {
              uncoveredVariants.push(variantName);
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
      // Validate that the constructor exists (either as a sum type variant or record type)
      let foundCtor = false;
      
      // Check sum type variants
      for (const [typeName, typeInfo] of ctx.sumTypes.entries()) {
        if (typeInfo.variants.has(expr.typeName)) {
          foundCtor = true;
          break;
        }
      }
      
      // Check record types
      if (!foundCtor && ctx.recordTypes.has(expr.typeName)) {
        foundCtor = true;
      }
      
      // Also check if it's a record type name in the symbol table (for multi-module support)
      if (!foundCtor && ctx.symbolTable && ctx.currentModule) {
        let qualifiedName = expr.typeName;
        // Try to resolve the identifier
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

  // Resolve identifier using current module and symbol table
  let qualifiedName = expr.callee;
  if (ctx.currentModule && ctx.symbolTable) {
    qualifiedName = resolveIdentifier(expr.callee, ctx.currentModule, ctx.symbolTable);
  }

  const signature = ctx.functions.get(qualifiedName);
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
