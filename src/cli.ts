#!/usr/bin/env node

import path from "path";
import process from "process";
import { parseModuleFromFile } from "./parser";
import { typecheckModule } from "./typecheck";
import { buildRuntime, callFunction, prettyValue, runTests, Value, RuntimeError } from "./interpreter";

function main() {
  const [, , command, ...rest] = process.argv;

  if (!command) {
    printUsage();
    process.exit(1);
  }

  try {
    switch (command) {
      case "run":
        return handleRun(rest);
      case "test":
        return handleTest(rest);
      case "check":
        return handleCheck(rest);
      default:
        console.error(`Unknown command '${command}'`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    handleFatal(error);
  }
}

function handleRun(args: string[]) {
  const [filePath, fnName, ...fnArgs] = args;
  if (!filePath || !fnName) {
    console.error("Usage: lx run <file.lx> <module.fnName> [args...]");
    process.exit(1);
  }

  const module = loadModule(filePath);
  const runtime = buildRuntime(module);

  const [moduleName, functionName] = splitQualifiedName(fnName);
  if (moduleName && moduleName !== module.name.join(".")) {
    console.warn(`Warning: requested module '${moduleName}' does not match parsed module '${module.name.join(".")}'`);
  }

  const values = fnArgs.map(parseArgAsValue);
  const result = callFunction(runtime, functionName, values);
  console.log(JSON.stringify(prettyValue(result), null, 2));
}

function handleTest(args: string[]) {
  const [filePath] = args;
  if (!filePath) {
    console.error("Usage: lx test <file.lx>");
    process.exit(1);
  }

  const module = loadModule(filePath);
  const runtime = buildRuntime(module);
  const outcomes = runTests(runtime);

  let failures = 0;
  for (const outcome of outcomes) {
    if (outcome.success) {
      console.log(`✓ ${outcome.name}`);
    } else {
      failures += 1;
      console.error(`✗ ${outcome.name}`);
      if (outcome.error instanceof Error) {
        console.error(`  ${outcome.error.message}`);
      } else if (outcome.error) {
        console.error(`  ${String(outcome.error)}`);
      }
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

function handleCheck(args: string[]) {
  const [filePath] = args;
  if (!filePath) {
    console.error("Usage: lx check <file.lx>");
    process.exit(1);
  }

  loadModule(filePath);
  console.log("Typecheck succeeded");
}

function loadModule(filePath: string) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const module = parseModuleFromFile(absolutePath);
  const errors = typecheckModule(module);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`Type error: ${error.message}`);
    }
    process.exit(1);
  }
  return module;
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
  console.log("  lx run <file.lx> <module.fnName> [jsonArgs...]");
  console.log("  lx test <file.lx>");
  console.log("  lx check <file.lx>");
}

main();
