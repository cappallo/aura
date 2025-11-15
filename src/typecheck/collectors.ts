/**
 * Module collector functions for gathering module-level information.
 * First pass of type checking: index all declarations before checking bodies.
 */

import * as ast from "../ast";
import {
  FnSignature,
  IndexedTypeInfo,
  RecordTypeInfo,
  SchemaInfo,
  SumTypeInfo,
  TypeDeclInfo,
  VariantInfo,
} from "./types";

/** Helper to create ActorRef type expression */
function actorRefTypeExpr(messageType?: ast.TypeExpr): ast.TypeExpr {
  return {
    kind: "TypeName",
    name: "ActorRef",
    typeArgs: messageType ? [messageType] : [],
  };
}

/** Determine the sum type representing an actor's messages */
function inferActorMessageTypeExpr(
  actor: ast.ActorDecl,
  variantConstructors?: Map<string, VariantInfo[]>,
): ast.TypeExpr | undefined {
  if (!variantConstructors) {
    return undefined;
  }
  let parentQualified: string | null = null;
  let parentName: string | null = null;
  for (const handler of actor.handlers) {
    const candidates = variantConstructors.get(handler.msgTypeName);
    if (!candidates || candidates.length === 0) {
      return undefined;
    }
    const variantInfo = candidates[0]!;
    if (!parentQualified) {
      parentQualified = variantInfo.parentQualifiedName;
      parentName = variantInfo.parentDecl.name;
      continue;
    }
    if (variantInfo.parentQualifiedName !== parentQualified) {
      return undefined;
    }
  }
  if (!parentName) {
    return undefined;
  }
  return { kind: "TypeName", name: parentName, typeArgs: [] };
}

/** Helper to clone parameter (avoiding mutation) */
function cloneParam(param: ast.Param): ast.Param {
  return {
    name: param.name,
    type: param.type,
  };
}

/** Generate synthetic spawn function declaration for an actor */
function createActorSpawnDecl(actor: ast.ActorDecl, messageType?: ast.TypeExpr): ast.FnDecl {
  return {
    kind: "FnDecl",
    name: `${actor.name}.spawn`,
    typeParams: [],
    params: actor.params.map((param) => cloneParam(param)),
    returnType: actorRefTypeExpr(messageType),
    effects: ["Concurrent"],
    body: { kind: "Block", stmts: [] },
  };
}

function createActorHandlerDecl(
  actor: ast.ActorDecl,
  handler: ast.ActorHandler,
  messageType?: ast.TypeExpr,
): ast.FnDecl {
  return {
    kind: "FnDecl",
    name: `${actor.name}.${handler.msgTypeName}`,
    typeParams: [],
    params: [
      { name: "actor", type: actorRefTypeExpr(messageType) },
      ...handler.msgParams.map((param) => cloneParam(param)),
    ],
    returnType: handler.returnType,
    effects: [...handler.effects],
    body: { kind: "Block", stmts: [] },
  };
}

function createSyntheticSignature(
  decl: ast.FnDecl,
  module: ast.Module,
  qualifiedName: string,
): FnSignature {
  return {
    name: qualifiedName,
    paramCount: decl.params.length,
    paramNames: decl.params.map((param) => param.name),
    effects: new Set(decl.effects),
    decl,
    module,
  };
}

export function registerActorSignaturesLocal(
  map: Map<string, FnSignature>,
  actor: ast.ActorDecl,
  module: ast.Module,
  modulePrefix: string,
  variantConstructors?: Map<string, VariantInfo[]>,
): void {
  const messageType = inferActorMessageTypeExpr(actor, variantConstructors);
  const spawnDecl = createActorSpawnDecl(actor, messageType);
  const spawnQualified = modulePrefix ? `${modulePrefix}.${spawnDecl.name}` : spawnDecl.name;
  const spawnSignature = createSyntheticSignature(spawnDecl, module, spawnQualified);
  map.set(spawnQualified, spawnSignature);
  map.set(spawnDecl.name, spawnSignature);

  for (const handler of actor.handlers) {
    const handlerDecl = createActorHandlerDecl(actor, handler, messageType);
    const handlerQualified = modulePrefix ? `${modulePrefix}.${handlerDecl.name}` : handlerDecl.name;
    const handlerSignature = createSyntheticSignature(handlerDecl, module, handlerQualified);
    map.set(handlerQualified, handlerSignature);
    map.set(handlerDecl.name, handlerSignature);
  }
}

export function registerActorSignaturesGlobal(
  map: Map<string, FnSignature>,
  actor: ast.ActorDecl,
  module: ast.Module,
  modulePrefix: string,
  variantConstructors?: Map<string, VariantInfo[]>,
): void {
  const messageType = inferActorMessageTypeExpr(actor, variantConstructors);
  const spawnDecl = createActorSpawnDecl(actor, messageType);
  const spawnQualified = modulePrefix ? `${modulePrefix}.${spawnDecl.name}` : spawnDecl.name;
  const spawnSignature = createSyntheticSignature(spawnDecl, module, spawnQualified);
  map.set(spawnQualified, spawnSignature);

  for (const handler of actor.handlers) {
    const handlerDecl = createActorHandlerDecl(actor, handler, messageType);
    const handlerQualified = modulePrefix ? `${modulePrefix}.${handlerDecl.name}` : handlerDecl.name;
    const handlerSignature = createSyntheticSignature(handlerDecl, module, handlerQualified);
    map.set(handlerQualified, handlerSignature);
  }
}

/**
 * Collect all function signatures from a module.
 * Includes user-defined functions and synthetic actor functions (spawn and handlers).
 * Indexes by both qualified and unqualified names.
 */
export function collectModuleFunctions(
  module: ast.Module,
  variantConstructors?: Map<string, VariantInfo[]>,
): Map<string, FnSignature> {
  const map = new Map<string, FnSignature>();
  const modulePrefix = module.name.join(".");
  for (const decl of module.decls) {
    if (decl.kind === "FnDecl") {
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
      continue;
    }

    if (decl.kind === "ActorDecl") {
      registerActorSignaturesLocal(map, decl, module, modulePrefix, variantConstructors);
    }
  }
  return map;
}

/**
 * Collect all declared effects from module declarations.
 * Includes built-in effects (Concurrent, Log).
 */
export function collectEffects(decls: ast.TopLevelDecl[]): Set<string> {
  const effects = new Set<string>(["Concurrent", "Log"]);
  for (const decl of decls) {
    if (decl.kind === "EffectDecl") {
      effects.add(decl.name);
    }
  }
  return effects;
}

export function collectModuleTypeInfo(module: ast.Module): IndexedTypeInfo {
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
