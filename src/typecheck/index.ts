/**
 * Type checking module for Lx language.
 * 
 * Two-pass checking:
 * 1. Collect all declarations (functions, types, effects) into context
 * 2. Check function bodies with full context available
 * 
 * Implements Hindley-Milner type inference with effects tracking.
 */

import * as ast from "../ast";
import type { ResolvedModule, SymbolTable } from "../loader";
import {
  collectEffects,
  collectModuleFunctions,
  collectModuleTypeInfo,
  registerActorSignaturesGlobal,
} from "./collectors";
import {
  checkActor,
  checkContract,
  checkFunction,
  checkProperty,
  checkSchema,
} from "./checkers";
import {
  FnSignature,
  IndexedTypeInfo,
  RecordTypeInfo,
  SchemaInfo,
  SumTypeInfo,
  TypeCheckError,
  TypeDeclInfo,
  TypecheckContext,
  VariantInfo,
} from "./types";

export * from "./types";
export * from "./builtins";

export function typecheckModule(module: ast.Module): TypeCheckError[] {
  const typeInfo = collectModuleTypeInfo(module);
  const functions = collectModuleFunctions(module, typeInfo.variantConstructors);

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

  for (const decl of module.decls) {
    if (decl.kind === "ActorDecl") {
      checkActor(decl, ctx, errors);
    }
  }

  return errors;
}

export function typecheckModules(
  modules: ResolvedModule[],
  symbolTable: SymbolTable,
): TypeCheckError[] {
  const errors: TypeCheckError[] = [];

  const globalFunctions = new Map<string, FnSignature>();
  const globalEffects = new Set<string>(["Concurrent", "Log"]);
  const globalSumTypes = new Map<string, SumTypeInfo>();
  const globalRecordTypes = new Map<string, RecordTypeInfo>();
  const globalTypeDecls = new Map<string, TypeDeclInfo>();
  const globalVariantConstructors = new Map<string, VariantInfo[]>();
  const globalSchemas = new Map<string, SchemaInfo>();
  const moduleTypeCache = new Map<ast.Module, IndexedTypeInfo>();

  for (const resolvedModule of modules) {
    const module = resolvedModule.ast;
    const modulePrefix = module.name.join(".");
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
        case "ActorDecl": {
          registerActorSignaturesGlobal(
            globalFunctions,
            decl,
            module,
            modulePrefix,
            typeInfo.variantConstructors,
          );
          break;
        }
        default:
          break;
      }
    }
  }

  for (const [qualifiedName, typeDecl] of symbolTable.types.entries()) {
    if (!globalTypeDecls.has(qualifiedName)) {
      const moduleName = qualifiedName.substring(0, qualifiedName.lastIndexOf("."));
      const foundModule = modules.find((m) => m.ast.name.join(".") === moduleName);
      if (!foundModule) continue;

      const typeParams =
        typeDecl.kind === "AliasTypeDecl" ||
        typeDecl.kind === "RecordTypeDecl" ||
        typeDecl.kind === "SumTypeDecl"
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

      if (typeDecl.kind === "RecordTypeDecl") {
        const recordInfo: RecordTypeInfo = {
          name: typeDecl.name,
          qualifiedName,
          typeParams: typeDecl.typeParams,
          decl: typeDecl,
          module: foundModule.ast,
        };
        globalRecordTypes.set(qualifiedName, recordInfo);

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
            variants: [
              {
                name: typeDecl.name,
                fields: typeDecl.fields,
              },
            ],
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

    if (!moduleVariantConstructors.has("Some")) {
      moduleVariantConstructors.set("Some", [someCtor]);
    }
    if (!moduleVariantConstructors.has("None")) {
      moduleVariantConstructors.set("None", [noneCtor]);
    }

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
      } else if (decl.kind === "ActorDecl") {
        const spawnName = `${decl.name}.spawn`;
        const spawnQualified = modulePrefix ? `${modulePrefix}.${spawnName}` : spawnName;
        const spawnSignature = globalFunctions.get(spawnQualified);
        if (spawnSignature) {
          moduleFunctions.set(spawnName, spawnSignature);
        }

        for (const handler of decl.handlers) {
          const handlerName = `${decl.name}.${handler.msgTypeName}`;
          const handlerQualified = modulePrefix ? `${modulePrefix}.${handlerName}` : handlerName;
          const handlerSignature = globalFunctions.get(handlerQualified);
          if (handlerSignature) {
            moduleFunctions.set(handlerName, handlerSignature);
          }
        }
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

    for (const decl of module.decls) {
      if (decl.kind === "ActorDecl") {
        checkActor(decl, ctx, errors, filePath);
      }
    }
  }

  return errors;
}
