#!/usr/bin/env node

import fs from "fs";
import path from "path";
import process from "process";
import { parseModuleFromFile, parseModule } from "./parser";
import { parseModuleFromAstFile } from "./ast_json";
import { typecheckModule, typecheckModules } from "./typecheck";
import {
  buildRuntime,
  buildMultiModuleRuntime,
  callFunction,
  prettyValue,
  runTests,
  Value,
  RuntimeError,
  SchedulerMode,
} from "./interpreter";
import { loadModules, buildSymbolTable, generateTypesFromSchemas } from "./loader";
import * as ast from "./ast";
import { StructuredOutput, StructuredError, formatStructuredOutput } from "./structured";
import { applyRefactor, findRefactorDecl, RefactorError } from "./refactors";

export type OutputFormat = "text" | "json";

export type InputFormat = "source" | "ast";

export type CliContext = {
  format: OutputFormat;
  input: InputFormat;
  scheduler: SchedulerMode;
  seed?: number;
};

function main() {
  const [, , command, ...rest] = process.argv;

  if (!command) {
    printUsage();
    process.exit(1);
  }

  try {
    // Parse global flags
    const { args, format, input, scheduler, seed } = parseGlobalFlags(rest);
    const ctx: CliContext = { format, input, scheduler };
    if (seed !== undefined) {
      ctx.seed = seed;
    }

    switch (command) {
      case "run":
        return handleRun(args, ctx);
      case "test":
        return handleTest(args, ctx);
      case "check":
        return handleCheck(args, ctx);
      case "format":
        return handleFormat(args, ctx);
      case "explain":
        return handleExplain(args, ctx);
      case "patch-body":
        return handlePatchBody(args, ctx);
      case "apply-refactor":
        return handleApplyRefactor(args, ctx);
      default:
        console.error(`Unknown command '${command}'`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    handleFatal(error);
  }
}

function parseGlobalFlags(args: string[]): {
  args: string[];
  format: OutputFormat;
  input: InputFormat;
  scheduler: SchedulerMode;
  seed?: number;
} {
  let format: OutputFormat = "text";
  let input: InputFormat = "source";
  let scheduler: SchedulerMode = "immediate";
  let seed: number | undefined = undefined;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    
    if (arg === "--format" && i + 1 < args.length) {
      const formatValue = args[i + 1];
      if (formatValue === "json" || formatValue === "text") {
        format = formatValue;
        i++; // Skip the next argument
      } else {
        console.error(`Invalid format: ${formatValue}. Must be 'text' or 'json'.`);
        process.exit(1);
      }
    } else if (arg.startsWith("--format=")) {
      const formatValue = arg.substring(9);
      if (formatValue === "json" || formatValue === "text") {
        format = formatValue;
      } else {
        console.error(`Invalid format: ${formatValue}. Must be 'text' or 'json'.`);
        process.exit(1);
      }
    } else if (arg === "--input" && i + 1 < args.length) {
      const value = args[i + 1]!;
      input = parseInputFormat(value);
      i += 1;
    } else if (arg.startsWith("--input=")) {
      const value = arg.substring(8);
      input = parseInputFormat(value);
    } else if (arg === "--scheduler" && i + 1 < args.length) {
      const value = args[i + 1]!;
      scheduler = parseSchedulerMode(value);
      i += 1;
    } else if (arg.startsWith("--scheduler=")) {
      const value = arg.substring(12);
      scheduler = parseSchedulerMode(value);
    } else if (arg === "--seed" && i + 1 < args.length) {
      const value = args[i + 1]!;
      seed = parseSeed(value);
      i += 1;
    } else if (arg.startsWith("--seed=")) {
      const value = arg.substring(7);
      seed = parseSeed(value);
    } else {
      remaining.push(arg);
    }
  }

  const result: {
    args: string[];
    format: OutputFormat;
    input: InputFormat;
    scheduler: SchedulerMode;
    seed?: number;
  } = { args: remaining, format, input, scheduler };
  
  if (seed !== undefined) {
    result.seed = seed;
  }
  
  return result;
}

function parseSeed(value: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    console.error(`Invalid seed: ${value}. Must be an integer.`);
    process.exit(1);
  }
  return parsed;
}

function parseInputFormat(value: string): InputFormat {
  if (value === "source" || value === "ast") {
    return value;
  }
  console.error(`Invalid input format: ${value}. Must be 'source' or 'ast'.`);
  process.exit(1);
}

function parseSchedulerMode(value: string): SchedulerMode {
  if (value === "immediate" || value === "deterministic") {
    return value;
  }
  console.error(`Invalid scheduler: ${value}. Must be 'immediate' or 'deterministic'.`);
  process.exit(1);
}

function parseBlockSnippet(snippet: string, snippetPath: string): ast.Block {
  const pseudoModule = [
    "module __patch.temp",
    "fn __temp() -> Unit {",
    snippet,
    "}",
  ].join("\n");
  let parsed: ast.Module;
  try {
    parsed = parseModule(pseudoModule, snippetPath);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Failed to parse snippet '${snippetPath}': ${error.message}`);
    } else {
      console.error(`Failed to parse snippet '${snippetPath}': ${String(error)}`);
    }
    process.exit(1);
  }
  const fnDecl = parsed.decls.find((decl): decl is ast.FnDecl => decl.kind === "FnDecl");
  if (!fnDecl) {
    console.error(`Snippet '${snippetPath}' did not contain a function body`);
    process.exit(1);
  }
  return fnDecl.body;
}

function handleRun(args: string[], ctx: CliContext) {
  const [filePath, fnName, ...fnArgs] = args;
  if (!filePath || !fnName) {
    console.error("Usage: lx run [--format=json|text] [--input=source|ast] <file> <module.fnName> [args...]");
    process.exit(1);
  }

  const { module, modules, symbolTable, errors } = loadModuleWithDependencies(filePath, ctx);
  
  if (errors && errors.length > 0) {
    if (ctx.format === "json") {
      const output: StructuredOutput = { status: "error", errors };
      console.log(formatStructuredOutput(output));
    } else {
      for (const error of errors) {
        console.error(formatError(error));
      }
    }
    process.exit(1);
  }

  const runtimeOptions: import("./interpreter").RuntimeOptions = { schedulerMode: ctx.scheduler };
  if (ctx.seed !== undefined) {
    runtimeOptions.seed = ctx.seed;
  }
  const runtime = modules && symbolTable 
    ? buildMultiModuleRuntime(modules, symbolTable, ctx.format, runtimeOptions)
    : buildRuntime(module, ctx.format, runtimeOptions);

  const [moduleName, functionName] = splitQualifiedName(fnName);
  if (moduleName && moduleName !== module.name.join(".")) {
    console.warn(`Warning: requested module '${moduleName}' does not match parsed module '${module.name.join(".")}'`);
  }

  const values = fnArgs.map(parseArgAsValue);
  const result = callFunction(runtime, functionName, values);
  
  if (ctx.format === "json") {
    const output: StructuredOutput = {
      status: "success",
      result: prettyValue(result),
    };
    if (runtime.logs && runtime.logs.length > 0) {
      output.logs = runtime.logs;
    }
    console.log(formatStructuredOutput(output));
  } else {
    console.log(JSON.stringify(prettyValue(result), null, 2));
  }
}

function handleTest(args: string[], ctx: CliContext) {
  const [filePath] = args;
  if (!filePath) {
    console.error("Usage: lx test [--format=json|text] [--input=source|ast] <file>");
    process.exit(1);
  }

  const { module, modules, symbolTable, errors } = loadModuleWithDependencies(filePath, ctx);
  
  if (errors && errors.length > 0) {
    if (ctx.format === "json") {
      const output: StructuredOutput = { status: "error", errors };
      console.log(formatStructuredOutput(output));
    } else {
      for (const error of errors) {
        console.error(formatError(error));
      }
    }
    process.exit(1);
  }

  const runtimeOptions: import("./interpreter").RuntimeOptions = { schedulerMode: ctx.scheduler };
  if (ctx.seed !== undefined) {
    runtimeOptions.seed = ctx.seed;
  }
  const runtime = modules && symbolTable 
    ? buildMultiModuleRuntime(modules, symbolTable, ctx.format, runtimeOptions)
    : buildRuntime(module, ctx.format, runtimeOptions);
  const outcomes = runTests(runtime);

  let failures = 0;
  const testResults: Array<{ name: string; success: boolean; error?: string }> = [];

  for (const outcome of outcomes) {
    const label = outcome.kind === "property" ? `property ${outcome.name}` : outcome.name;
    const errorMsg = outcome.error instanceof Error 
      ? outcome.error.message 
      : outcome.error ? String(outcome.error) : undefined;

    const result: { name: string; success: boolean; error?: string } = {
      name: label,
      success: outcome.success,
    };
    if (errorMsg !== undefined) {
      result.error = errorMsg;
    }
    testResults.push(result);

    if (!outcome.success) {
      failures += 1;
    }

    if (ctx.format === "text") {
      if (outcome.success) {
        console.log(`✓ ${label}`);
      } else {
        console.error(`✗ ${label}`);
        if (errorMsg) {
          console.error(`  ${errorMsg}`);
        }
      }
    }
  }

  if (ctx.format === "json") {
    const output: StructuredOutput = {
      status: failures > 0 ? "error" : "success",
      result: { tests: testResults, passed: testResults.length - failures, failed: failures },
    };
    if (runtime.logs && runtime.logs.length > 0) {
      output.logs = runtime.logs;
    }
    console.log(formatStructuredOutput(output));
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

function handleCheck(args: string[], ctx: CliContext) {
  const [filePath] = args;
  if (!filePath) {
    console.error("Usage: lx check [--format=json|text] [--input=source|ast] <file>");
    process.exit(1);
  }

  const { errors } = loadModuleWithDependencies(filePath, ctx);
  
  if (errors && errors.length > 0) {
    if (ctx.format === "json") {
      const output: StructuredOutput = { status: "error", errors };
      console.log(formatStructuredOutput(output));
    } else {
      for (const error of errors) {
        console.error(formatError(error));
      }
    }
    process.exit(1);
  }

  if (ctx.format === "json") {
    const output: StructuredOutput = { status: "success" };
    console.log(formatStructuredOutput(output));
  } else {
    console.log("Typecheck succeeded");
  }
}

function handleFormat(args: string[], ctx: CliContext) {
  const [filePath] = args;
  if (!filePath) {
    console.error("Usage: lx format <file.lx>");
    process.exit(1);
  }

  try {
    const mod = parseModuleFromFile(filePath);
    const { formatModule } = require("./formatter");
    const formatted = formatModule(mod);
    console.log(formatted);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Format error: ${error.message}`);
    } else {
      console.error(`Format error: ${String(error)}`);
    }
    process.exit(1);
  }
}

function handleExplain(args: string[], ctx: CliContext) {
  const [filePath, fnName, ...fnArgs] = args;
  if (!filePath || !fnName) {
    console.error("Usage: lx explain [--format=json|text] [--input=source|ast] <file> <module.fnName> [args...]");
    process.exit(1);
  }

  const { module, modules, symbolTable, errors } = loadModuleWithDependencies(filePath, ctx);

  if (errors && errors.length > 0) {
    if (ctx.format === "json") {
      const output: StructuredOutput = { status: "error", errors };
      console.log(formatStructuredOutput(output));
    } else {
      for (const error of errors) {
        console.error(formatError(error));
      }
    }
    process.exit(1);
  }

  const runtimeOptions: import("./interpreter").RuntimeOptions = { schedulerMode: ctx.scheduler };
  if (ctx.seed !== undefined) {
    runtimeOptions.seed = ctx.seed;
  }
  const runtime = modules && symbolTable 
    ? buildMultiModuleRuntime(modules, symbolTable, ctx.format, runtimeOptions)
    : buildRuntime(module, ctx.format, runtimeOptions);

  // Enable tracing
  runtime.tracing = true;
  runtime.traces = [];
  runtime.traceDepth = 0;

  const [moduleName, functionName] = splitQualifiedName(fnName);
  if (moduleName && moduleName !== module.name.join(".")) {
    console.warn(`Warning: requested module '${moduleName}' does not match parsed module '${module.name.join(".")}'`);
  }

  const values = fnArgs.map(parseArgAsValue);

  try {
    const result = callFunction(runtime, functionName, values);

    if (ctx.format === "json") {
      const output: StructuredOutput = {
        status: "success",
        result: prettyValue(result),
        traces: runtime.traces,
      };
      if (runtime.logs) {
        output.logs = runtime.logs;
      }
      console.log(formatStructuredOutput(output));
    } else {
      console.log(`Result: ${prettyValue(result)}\n`);
      console.log("Execution trace:");
      for (const trace of runtime.traces || []) {
        const indent = "  ".repeat(trace.depth);
        console.log(`${indent}[${trace.stepType}] ${trace.description}`);
      }
    }
  } catch (error) {
    if (error instanceof RuntimeError) {
      if (ctx.format === "json") {
        const errorObj = convertToStructuredError({
          message: error.message,
          filePath: filePath,
        });
        const output: StructuredOutput = {
          status: "error",
          errors: [errorObj],
          traces: runtime.traces,
        };
        if (runtime.logs) {
          output.logs = runtime.logs;
        }
        console.log(formatStructuredOutput(output));
      } else {
        console.error(`Runtime error: ${error.message}`);
        if (runtime.traces && runtime.traces.length > 0) {
          console.error("\nExecution trace before error:");
          for (const trace of runtime.traces) {
            const indent = "  ".repeat(trace.depth);
            console.error(`${indent}[${trace.stepType}] ${trace.description}`);
          }
        }
      }
      process.exit(1);
    }
    throw error;
  }
}

function handlePatchBody(args: string[], ctx: CliContext) {
  const [filePath, qualifiedName, bodyFile] = args;
  if (!filePath || !qualifiedName || !bodyFile) {
    console.error("Usage: lx patch-body <file.lx> <module.fnName> <bodySnippet.lx>");
    process.exit(1);
  }
  if (ctx.input !== "source") {
    console.error("Patch operations currently require --input=source");
    process.exit(1);
  }

  const absolutePath = path.resolve(process.cwd(), filePath);
  const moduleAst = parseModuleFromFile(absolutePath);
  const [moduleName, fnName] = splitQualifiedName(qualifiedName);
  const modulePath = moduleAst.name.join(".");
  if (moduleName && moduleName !== modulePath) {
    console.error(`Module mismatch: requested '${moduleName}', but file defines '${modulePath}'`);
    process.exit(1);
  }

  const fnDecl = moduleAst.decls.find(
    (decl): decl is ast.FnDecl => decl.kind === "FnDecl" && decl.name === fnName,
  );
  if (!fnDecl) {
    console.error(`Function '${fnName}' not found in module '${modulePath}'`);
    process.exit(1);
  }

  const snippetPath = path.resolve(process.cwd(), bodyFile);
  const snippet = fs.readFileSync(snippetPath, "utf8");
  const replacementBlock = parseBlockSnippet(snippet, snippetPath);
  fnDecl.body = replacementBlock;

  const errors = typecheckModule(moduleAst);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(formatError(error));
    }
    process.exit(1);
  }

  const { formatModule } = require("./formatter");
  const formatted = formatModule(moduleAst);
  fs.writeFileSync(absolutePath, `${formatted}\n`, "utf8");
  console.log(`Patched ${fnName} in ${filePath}`);
}

function handleApplyRefactor(args: string[], ctx: CliContext) {
  const [filePath, refactorName] = args;
  if (!filePath || !refactorName) {
    console.error("Usage: lx apply-refactor <file.lx> <refactorName>");
    process.exit(1);
  }
  if (ctx.input !== "source") {
    console.error("Refactor operations currently require --input=source");
    process.exit(1);
  }

  const loadResult = loadModuleWithDependencies(filePath, ctx);
  if (loadResult.errors && loadResult.errors.length > 0) {
    console.log("Load errors:", JSON.stringify(loadResult.errors, null, 2));
    if (ctx.format === "json") {
      const output: StructuredOutput = { status: "error", errors: loadResult.errors };
      console.log(formatStructuredOutput(output));
    } else {
      for (const error of loadResult.errors) {
        console.error(`${error.message}`);
      }
    }
    process.exit(1);
  }

  const modules = loadResult.modules;
  const symbolTable = loadResult.symbolTable;
  if (!modules || !symbolTable) {
    console.error("Internal error: module graph not available for refactor");
    process.exit(1);
  }

  const refactorInfo = findRefactorDecl(modules, refactorName);
  if (!refactorInfo) {
    const message = `Refactor '${refactorName}' not found`;
    if (ctx.format === "json") {
    const error: StructuredError = {
      kind: "error",
      errorType: "RefactorError",
      message,
    };
      const output: StructuredOutput = { status: "error", errors: [error] };
      console.log(formatStructuredOutput(output));
    } else {
      console.error(message);
    }
    process.exit(1);
  }

  let applyResult;
  try {
    applyResult = applyRefactor(refactorInfo.decl, modules, symbolTable);
  } catch (error) {
    if (error instanceof RefactorError) {
      if (ctx.format === "json") {
        const structuredError: StructuredError = {
          kind: "error",
          errorType: "RefactorError",
          message: error.message,
        };
        const output: StructuredOutput = { status: "error", errors: [structuredError] };
        console.log(formatStructuredOutput(output));
      } else {
        console.error(`Refactor error: ${error.message}`);
      }
      process.exit(1);
    }
    throw error;
  }

  const updatedSymbolTable = buildSymbolTable(modules);
  generateTypesFromSchemas(updatedSymbolTable);
  const typeErrors = typecheckModules(modules, updatedSymbolTable);
  if (typeErrors.length > 0) {
    if (ctx.format === "json") {
      const errors = typeErrors.map(convertToStructuredError);
      const output: StructuredOutput = { status: "error", errors };
      console.log(formatStructuredOutput(output));
    } else {
      for (const error of typeErrors) {
        console.error(formatError(error));
      }
    }
    process.exit(1);
  }

  const { formatModule } = require("./formatter");
  for (const change of applyResult.moduleChanges) {
    const targetModule = modules.find((mod) => mod.moduleName.join(".") === change.module);
    if (!targetModule) {
      continue;
    }
    const formatted = formatModule(targetModule.ast);
    fs.writeFileSync(targetModule.filePath, formatted, "utf8");
  }

  if (ctx.format === "json") {
    const output: StructuredOutput = {
      status: "success",
      result: {
        refactor: applyResult.refactorName,
        operations: applyResult.operationSummaries,
        modules: applyResult.moduleChanges,
      },
    };
    console.log(formatStructuredOutput(output));
  } else {
    console.log(`Applied refactor '${applyResult.refactorName}'`);
    if (applyResult.operationSummaries.length === 0) {
      console.log("  (no operations defined)");
    } else {
      for (const summary of applyResult.operationSummaries) {
        switch (summary.kind) {
          case "rename_type":
            console.log(
              `  - renamed type ${summary.from} -> ${summary.to} (type refs: ${summary.typeReferencesUpdated}, constructors: ${summary.recordConstructorsUpdated})`,
            );
            break;
          case "rename_function":
            console.log(
              `  - renamed function ${summary.from} -> ${summary.to} (call sites: ${summary.callSitesUpdated}, contracts: ${summary.contractsRenamed})`,
            );
            break;
          case "move_type":
            console.log(
              `  - moved type ${summary.symbol} from ${summary.fromModule} to ${summary.toModule} (refs: ${summary.referencesUpdated})`,
            );
            break;
          case "move_function":
            console.log(
              `  - moved function ${summary.symbol} from ${summary.fromModule} to ${summary.toModule} (call sites: ${summary.callSitesUpdated})`,
            );
            break;
        }
      }
    }
    if (applyResult.moduleChanges.length === 0) {
      console.log("No files modified.");
    } else {
      for (const change of applyResult.moduleChanges) {
        console.log(`  * ${change.filePath}`);
        for (const reason of change.changes) {
          console.log(`    - ${reason}`);
        }
      }
    }
  }
}

function formatError(error: import("./typecheck").TypeCheckError): string {
  let msg = "Type error: ";
  if (error.filePath) {
    msg += `${error.filePath}:`;
  }
  if (error.loc) {
    msg += `${error.loc.start.line}:${error.loc.start.column}: `;
  }
  msg += error.message;
  return msg;
}

function convertToStructuredError(error: import("./typecheck").TypeCheckError): import("./structured").StructuredError {
  const { createError, sourceLocationToErrorLocation } = require("./structured");
  
  const location = sourceLocationToErrorLocation(
    error.loc,
    error.filePath,
    undefined
  );
  
  return createError(
    "TypeCheckError",
    error.message,
    location,
    undefined,
    undefined
  );
}

function loadModule(filePath: string) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const module = parseModuleFromFile(absolutePath);
  const errors = typecheckModule(module);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(formatError(error));
    }
    process.exit(1);
  }
  return module;
}

type LoadResult = {
  module: ast.Module;
  modules?: import("./loader").ResolvedModule[];
  symbolTable?: import("./loader").SymbolTable;
  errors?: import("./structured").StructuredError[];
};

function loadModuleWithDependencies(filePath: string, ctx: CliContext): LoadResult {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const module =
    ctx.input === "ast"
      ? parseModuleFromAstFile(absolutePath)
      : parseModuleFromFile(absolutePath);

  if (ctx.input === "ast" && module.imports.length > 0) {
    const error = convertToStructuredError({
      message: "AST input currently supports single modules without imports",
      filePath: absolutePath,
    });
    return { module, errors: [error] };
  }
  
  // Check if module has imports
  if (module.imports.length === 0 || ctx.input === "ast") {
    // No imports - use single-module typecheck, but still generate types from schemas
    const modules = [{ moduleName: module.name, filePath: absolutePath, ast: module }];
    const symbolTable = buildSymbolTable(modules);
    generateTypesFromSchemas(symbolTable);
    
    const typeErrors = typecheckModules(modules, symbolTable);
    if (typeErrors.length > 0) {
      const structuredErrors = typeErrors.map(convertToStructuredError);
      return { module, modules, symbolTable, errors: structuredErrors };
    }
    return { module, modules, symbolTable };
  }
  
  // Has imports - use multi-module loader
  const modules = loadModules(absolutePath);
  const symbolTable = buildSymbolTable(modules);
  
  // Generate types from schema declarations
  generateTypesFromSchemas(symbolTable);
  
  const typeErrors = typecheckModules(modules, symbolTable);
  
  if (typeErrors.length > 0) {
    const structuredErrors = typeErrors.map(convertToStructuredError);
    return { module, modules, symbolTable, errors: structuredErrors };
  }
  
  return { module, modules, symbolTable };
}

function parseArgAsValue(raw: string): Value {
  const parsed = JSON.parse(raw);
  return fromJsValue(parsed);
}

function fromJsValue(value: unknown): Value {
  if (typeof value === "number") {
    return { kind: "Int", value: Math.trunc(value) };
  }
  if (typeof value === "boolean") {
    return { kind: "Bool", value };
  }
  if (typeof value === "string") {
    return { kind: "String", value };
  }
  if (Array.isArray(value)) {
    return { kind: "List", elements: value.map(fromJsValue) };
  }
  throw new RuntimeError("Only numbers, booleans, strings, and arrays are currently supported as CLI arguments");
}

function splitQualifiedName(name: string): [string | null, string] {
  if (!name.includes(".")) {
    return [null, name];
  }
  const parts = name.split(".");
  const fnName = parts.pop() as string;
  return [parts.join("."), fnName];
}

function handleFatal(error: unknown) {
  if (error instanceof RuntimeError || error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
}

function printUsage() {
  console.log("Usage:");
  console.log("  lx run [--format=json|text] [--input=source|ast] [--seed=N] <file> <module.fnName> [args...]");
  console.log("  lx test [--format=json|text] [--input=source|ast] [--seed=N] <file>");
  console.log("  lx check [--format=json|text] [--input=source|ast] <file>");
  console.log("  lx format <file.lx>");
  console.log("  lx explain [--format=json|text] [--input=source|ast] [--seed=N] <file> <module.fnName> [args...]");
  console.log("  lx patch-body <file.lx> <module.fnName> <bodySnippet.lx>");
  console.log("  lx apply-refactor <file.lx> <refactorName>");
  console.log("");
  console.log("Options:");
  console.log("  --format=json    Output structured JSON for LLM consumption");
  console.log("  --format=text    Output human-readable text (default)");
  console.log("  --input=source   Treat input file as .lx source (default)");
  console.log("  --input=ast      Treat input file as JSON AST");
  console.log("  --scheduler=immediate|deterministic  Control actor mailbox scheduling (default: immediate)");
  console.log("  --seed=N         Set random number generator seed for deterministic property tests");
}

main();
