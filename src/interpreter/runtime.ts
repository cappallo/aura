import * as ast from "../ast";
import { SeededRNG } from "./rng";
import { Runtime, RuntimeOptions, FnContract } from "./types";

export function buildRuntime(
  module: ast.Module,
  outputFormat?: "text" | "json",
  options?: RuntimeOptions,
): Runtime {
  const functions = new Map<string, ast.FnDecl>();
  const contracts = new Map<string, FnContract>();
  const tests: ast.TestDecl[] = [];
  const properties: ast.PropertyDecl[] = [];
  const typeDecls = new Map<string, ast.TypeDecl>();
  const actors = new Map<string, ast.ActorDecl>();
  const modulePrefix = module.name.join(".");

  for (const decl of module.decls) {
    if (decl.kind === "FnDecl") {
      functions.set(decl.name, decl);
    } else if (decl.kind === "FnContractDecl") {
      contracts.set(decl.name, {
        requires: decl.requires,
        ensures: decl.ensures,
      });
    } else if (decl.kind === "TestDecl") {
      tests.push(decl);
    } else if (decl.kind === "PropertyDecl") {
      properties.push(decl);
    } else if (decl.kind === "ActorDecl") {
      actors.set(decl.name, decl);
      if (modulePrefix) {
        actors.set(`${modulePrefix}.${decl.name}`, decl);
      }
    } else if (
      decl.kind === "AliasTypeDecl" ||
      decl.kind === "RecordTypeDecl" ||
      decl.kind === "SumTypeDecl"
    ) {
      typeDecls.set(decl.name, decl);
    }
  }

  const runtime: Runtime = {
    module,
    functions,
    contracts,
    tests,
    properties,
    typeDecls,
    actors,
    actorInstances: new Map(),
    nextActorId: 1,
    schedulerMode: options?.schedulerMode ?? "immediate",
    pendingActorDeliveries: [],
    isProcessingActorMessages: false,
    rng: options?.seed !== undefined ? new SeededRNG(options.seed) : null,
  };
  if (outputFormat !== undefined) {
    runtime.outputFormat = outputFormat;
    if (outputFormat === "json") {
      runtime.logs = [];
    }
  }
  return runtime;
}

/**
 * Build runtime from multiple modules with cross-module symbol resolution
 */
export function buildMultiModuleRuntime(
  modules: import("../loader").ResolvedModule[],
  symbolTable: import("../loader").SymbolTable,
  outputFormat?: "text" | "json",
  options?: RuntimeOptions,
): Runtime {
  const functions = new Map<string, ast.FnDecl>();
  const contracts = new Map<string, FnContract>();
  const tests: ast.TestDecl[] = [];
  const properties: ast.PropertyDecl[] = [];
  const typeDecls = new Map<string, ast.TypeDecl>();

  // Primary module is the last one loaded
  const primaryModule = modules[modules.length - 1]!.ast;

  // Collect functions from all modules with qualified names
  for (const resolvedModule of modules) {
    const module = resolvedModule.ast;
    const modulePrefix = module.name.join(".");

    for (const decl of module.decls) {
      if (decl.kind === "FnDecl") {
        const qualifiedName = `${modulePrefix}.${decl.name}`;
        functions.set(qualifiedName, decl);
        // Also add unqualified name if it's the primary module
        if (module === primaryModule) {
          functions.set(decl.name, decl);
        }
      } else if (decl.kind === "FnContractDecl") {
        const qualifiedName = `${modulePrefix}.${decl.name}`;
        contracts.set(qualifiedName, {
          requires: decl.requires,
          ensures: decl.ensures,
        });
        if (module === primaryModule) {
          contracts.set(decl.name, {
            requires: decl.requires,
            ensures: decl.ensures,
          });
        }
      } else if (decl.kind === "TestDecl") {
        // Only run tests from the primary module
        if (module === primaryModule) {
          tests.push(decl);
        }
      } else if (decl.kind === "PropertyDecl") {
        if (module === primaryModule) {
          properties.push(decl);
        }
      } else if (
        decl.kind === "AliasTypeDecl" ||
        decl.kind === "RecordTypeDecl" ||
        decl.kind === "SumTypeDecl"
      ) {
        const qualifiedName = modulePrefix ? `${modulePrefix}.${decl.name}` : decl.name;
        typeDecls.set(qualifiedName, decl);
        if (module === primaryModule) {
          typeDecls.set(decl.name, decl);
        }
      }
    }
  }

  const actors = new Map<string, ast.ActorDecl>();
  for (const resolvedModule of modules) {
    const module = resolvedModule.ast;
    const modulePrefix = module.name.join(".");

    for (const decl of module.decls) {
      if (decl.kind === "ActorDecl") {
        const qualifiedName = `${modulePrefix}.${decl.name}`;
        actors.set(qualifiedName, decl);
        if (module === primaryModule) {
          actors.set(decl.name, decl);
        }
      }
    }
  }

  const runtime: Runtime = {
    module: primaryModule,
    functions,
    contracts,
    tests,
    properties,
    typeDecls,
    actors,
    actorInstances: new Map(),
    nextActorId: 1,
    schedulerMode: options?.schedulerMode ?? "immediate",
    pendingActorDeliveries: [],
    isProcessingActorMessages: false,
    symbolTable,
    rng: options?.seed !== undefined ? new SeededRNG(options.seed) : null,
  };
  if (outputFormat !== undefined) {
    runtime.outputFormat = outputFormat;
    if (outputFormat === "json") {
      runtime.logs = [];
    }
  }
  return runtime;
}
