import * as ast from "../ast";
import { RuntimeError } from "./errors";
import { SeededRNG } from "./rng";
import { runProperty } from "./properties";
import { enforceContractClauses, evalBlock } from "./evaluation";
import { prettyValue } from "./values";
import {
  FnContract,
  Runtime,
  RuntimeOptions,
  TestOutcome,
  Value,
  Env,
} from "./types";

/**
 * Build runtime context from a single module.
 * Indexes all declarations and initializes execution state.
 */
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
    } else if (
      decl.kind === "AliasTypeDecl" ||
      decl.kind === "RecordTypeDecl" ||
      decl.kind === "SumTypeDecl"
    ) {
      typeDecls.set(decl.name, decl);
    } else if (decl.kind === "ActorDecl") {
      actors.set(decl.name, decl);
      if (modulePrefix) {
        actors.set(`${modulePrefix}.${decl.name}`, decl);
      }
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
 * Build runtime context from multiple modules.
 * Indexes declarations from all modules with qualified names.
 * Primary module is the last in the list (entry point).
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

  const primaryModule = modules[modules.length - 1]!.ast;

  for (const resolvedModule of modules) {
    const module = resolvedModule.ast;
    const modulePrefix = module.name.join(".");

    for (const decl of module.decls) {
      if (decl.kind === "FnDecl") {
        const qualifiedName = `${modulePrefix}.${decl.name}`;
        functions.set(qualifiedName, decl);
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

/**
 * Call a function by name with positional arguments.
 * Enforces contracts (requires/ensures), traces execution, and handles actor message delivery.
 * Throws RuntimeError if function not found or arity mismatch.
 */
export function callFunction(runtime: Runtime, name: string, args: Value[]): Value {
  const fn = runtime.functions.get(name);
  if (!fn) {
    throw new RuntimeError(`Function '${name}' not found`);
  }
  if (fn.params.length !== args.length) {
    throw new RuntimeError(
      `Function '${name}' expects ${fn.params.length} arguments but received ${args.length}`,
    );
  }

  const argsStr = args.map(prettyValue).join(", ");
  addTrace(runtime, "call", `${name}(${argsStr})`);

  const oldDepth = runtime.traceDepth ?? 0;
  runtime.traceDepth = oldDepth + 1;

  const paramEnv: Env = new Map();
  for (let i = 0; i < fn.params.length; i += 1) {
    const param = fn.params[i]!;
    const arg = args[i]!;
    paramEnv.set(param.name, arg);
    addTrace(runtime, "let", `${param.name} = ${prettyValue(arg)}`, arg);
  }

  const contract = runtime.contracts.get(name) ?? null;

  if (contract) {
    enforceContractClauses(contract.requires, paramEnv, runtime, name, "requires");
  }

  const executionEnv: Env = new Map(paramEnv);
  const result = evalBlock(fn.body, executionEnv, runtime);
  const returnValue = result.value;

  if (contract) {
    const ensuresEnv: Env = new Map(paramEnv);
    ensuresEnv.set("result", returnValue);
    enforceContractClauses(contract.ensures, ensuresEnv, runtime, name, "ensures");
  }

  addTrace(runtime, "return", `${name} => ${prettyValue(returnValue)}`, returnValue);

  runtime.traceDepth = oldDepth;

  return returnValue;
}

/**
 * Run all unit tests and property tests in the runtime.
 * Returns outcomes with success/failure status and error details.
 */
export function runTests(runtime: Runtime): TestOutcome[] {
  const outcomes: TestOutcome[] = [];

  for (const test of runtime.tests) {
    try {
      const env: Env = new Map();
      const result = evalBlock(test.body, env, runtime);
      if (result.type === "return" && result.value.kind !== "Unit") {
        outcomes.push({
          kind: "test",
          name: test.name,
          success: false,
          error: new RuntimeError("Tests must not return non-unit values"),
        });
      } else {
        outcomes.push({ kind: "test", name: test.name, success: true });
      }
    } catch (error) {
      outcomes.push({ kind: "test", name: test.name, success: false, error });
    }
  }

  for (const property of runtime.properties) {
    outcomes.push(runProperty(property, runtime));
  }

  return outcomes;
}

function addTrace(
  runtime: Runtime,
  stepType: "call" | "return" | "let" | "expr" | "match",
  description: string,
  value?: Value,
  location?: ast.SourceLocation,
) {
  if (!runtime.tracing || !runtime.traces) {
    return;
  }

  const depth = runtime.traceDepth ?? 0;
  const { sourceLocationToErrorLocation } = require("../structured");

  runtime.traces.push({
    kind: "trace",
    stepType,
    description,
    value: value ? prettyValue(value) : undefined,
    location: location ? sourceLocationToErrorLocation(location) : undefined,
    depth,
  });
}
