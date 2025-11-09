#!/usr/bin/env node

import path from "path";
import process from "process";
import { parseModuleFromFile } from "./parser";
import { typecheckModule, typecheckModules } from "./typecheck";
import { buildRuntime, buildMultiModuleRuntime, callFunction, prettyValue, runTests, Value, RuntimeError } from "./interpreter";
import { loadModules, buildSymbolTable } from "./loader";
import * as ast from "./ast";
import { StructuredOutput, formatStructuredOutput } from "./structured";

export type OutputFormat = "text" | "json";

export type CliContext = {
  format: OutputFormat;
};

function main() {
  const [, , command, ...rest] = process.argv;

  if (!command) {
    printUsage();
    process.exit(1);
  }

  try {
    // Parse global flags
    const { args, format } = parseGlobalFlags(rest);
    const ctx: CliContext = { format };

    switch (command) {
      case "run":
        return handleRun(args, ctx);
      case "test":
        return handleTest(args, ctx);
      case "check":
        return handleCheck(args, ctx);
      default:
        console.error(`Unknown command '${command}'`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    handleFatal(error);
  }
}

function parseGlobalFlags(args: string[]): { args: string[]; format: OutputFormat } {
  let format: OutputFormat = "text";
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
    } else {
      remaining.push(arg);
    }
  }

  return { args: remaining, format };
}

function handleRun(args: string[], ctx: CliContext) {
  const [filePath, fnName, ...fnArgs] = args;
  if (!filePath || !fnName) {
    console.error("Usage: lx run [--format=json|text] <file.lx> <module.fnName> [args...]");
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

  const runtime = modules && symbolTable 
    ? buildMultiModuleRuntime(modules, symbolTable, ctx.format)
    : buildRuntime(module, ctx.format);

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
    console.error("Usage: lx test [--format=json|text] <file.lx>");
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

  const runtime = modules && symbolTable
    ? buildMultiModuleRuntime(modules, symbolTable, ctx.format)
    : buildRuntime(module, ctx.format);
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
    console.error("Usage: lx check [--format=json|text] <file.lx>");
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
  const module = parseModuleFromFile(absolutePath);
  
  // Check if module has imports
  if (module.imports.length === 0) {
    // No imports - use single-module typecheck
    const typeErrors = typecheckModule(module);
    if (typeErrors.length > 0) {
      const structuredErrors = typeErrors.map(convertToStructuredError);
      return { module, errors: structuredErrors };
    }
    return { module };
  }
  
  // Has imports - use multi-module loader
  const modules = loadModules(absolutePath);
  const symbolTable = buildSymbolTable(modules);
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
  console.log("  lx [--format=json|text] run <file.lx> <module.fnName> [jsonArgs...]");
  console.log("  lx [--format=json|text] test <file.lx>");
  console.log("  lx [--format=json|text] check <file.lx>");
  console.log("");
  console.log("Options:");
  console.log("  --format=json    Output structured JSON for LLM consumption");
  console.log("  --format=text    Output human-readable text (default)");
}

main();
