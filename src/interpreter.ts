import * as ast from "./ast";
import { StructuredLog } from "./structured";

export type Value =
  | { kind: "Int"; value: number }
  | { kind: "Bool"; value: boolean }
  | { kind: "String"; value: string }
  | { kind: "List"; elements: Value[] }
  | { kind: "Ctor"; name: string; fields: Map<string, Value> }
  | { kind: "Unit" };

export type Runtime = {
  module: ast.Module;
  functions: Map<string, ast.FnDecl>;
  contracts: Map<string, FnContract>;
  tests: ast.TestDecl[];
  properties: ast.PropertyDecl[];
  typeDecls: Map<string, ast.TypeDecl>;
  // For multi-module support
  symbolTable?: import("./loader").SymbolTable;
  // Structured logging support
  outputFormat?: "text" | "json";
  logs?: StructuredLog[];
  // Execution tracing support
  traces?: import("./structured").StructuredTrace[];
  tracing?: boolean;
  traceDepth?: number;
};

type FnContract = {
  requires: ast.Expr[];
  ensures: ast.Expr[];
};

type Env = Map<string, Value>;

type EvalResult =
  | { type: "value"; value: Value }
  | { type: "return"; value: Value };

type MatchEnv = Env;

type TestOutcome = {
  kind: "test" | "property";
  name: string;
  success: boolean;
  error?: unknown;
};

const DEFAULT_PROPERTY_RUNS = 50;
const MAX_GENERATION_ATTEMPTS = 100;
const MAX_GENERATION_DEPTH = 4;
const RANDOM_STRING_CHARS = "abcdefghijklmnopqrstuvwxyz";

export function buildRuntime(module: ast.Module, outputFormat?: "text" | "json"): Runtime {
  const functions = new Map<string, ast.FnDecl>();
  const contracts = new Map<string, FnContract>();
  const tests: ast.TestDecl[] = [];
  const properties: ast.PropertyDecl[] = [];
  const typeDecls = new Map<string, ast.TypeDecl>();

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
    }
  }

  const runtime: Runtime = { 
    module, 
    functions, 
    contracts, 
    tests, 
    properties, 
    typeDecls,
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
  modules: import("./loader").ResolvedModule[],
  symbolTable: import("./loader").SymbolTable,
  outputFormat?: "text" | "json"
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
  
  const runtime: Runtime = {
    module: primaryModule,
    functions,
    contracts,
    tests,
    properties,
    typeDecls,
    symbolTable,
  };
  if (outputFormat !== undefined) {
    runtime.outputFormat = outputFormat;
    if (outputFormat === "json") {
      runtime.logs = [];
    }
  }
  return runtime;
}

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

  // Trace function call
  const argsStr = args.map(prettyValue).join(", ");
  addTrace(runtime, "call", `${name}(${argsStr})`);
  
  // Increase trace depth
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

  // Trace function return
  addTrace(runtime, "return", `${name} => ${prettyValue(returnValue)}`, returnValue);
  
  // Restore trace depth
  runtime.traceDepth = oldDepth;

  return returnValue;
}

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

function evalBlock(block: ast.Block, env: Env, runtime: Runtime): EvalResult {
  let lastValue: Value = { kind: "Unit" };
  for (const stmt of block.stmts) {
    const outcome = evalStmt(stmt, env, runtime);
    if (outcome.type === "return") {
      return outcome;
    }
    lastValue = outcome.value;
  }
  return { type: "value", value: lastValue };
}

function evalStmt(stmt: ast.Stmt, env: Env, runtime: Runtime): EvalResult {
  switch (stmt.kind) {
    case "LetStmt": {
      const value = evalExpr(stmt.expr, env, runtime);
      env.set(stmt.name, value);
      return { type: "value", value: { kind: "Unit" } };
    }
    case "ReturnStmt": {
      const value = evalExpr(stmt.expr, env, runtime);
      return { type: "return", value };
    }
    case "ExprStmt": {
      const value = evalExpr(stmt.expr, env, runtime);
      return { type: "value", value };
    }
    case "MatchStmt": {
      return evalMatch(stmt, env, runtime);
    }
    default:
      throw new RuntimeError(`Unsupported statement kind: ${(stmt as ast.Stmt).kind}`);
  }
}

function evalMatch(stmt: ast.MatchStmt, env: Env, runtime: Runtime): EvalResult {
  const scrutinee = evalExpr(stmt.scrutinee, env, runtime);
  for (const matchCase of stmt.cases) {
    const matchEnv = tryMatchPattern(matchCase.pattern, scrutinee, env);
    if (matchEnv) {
      const result = evalBlock(matchCase.body, matchEnv, runtime);
      if (result.type === "return") {
        return result;
      }
      return { type: "value", value: result.value };
    }
  }
  throw new RuntimeError("Non-exhaustive match expression");
}

function tryMatchPattern(pattern: ast.Pattern, value: Value, env: Env): MatchEnv | null {
  switch (pattern.kind) {
    case "WildcardPattern":
      return new Map(env);
    case "VarPattern": {
      const nextEnv = new Map(env);
      nextEnv.set(pattern.name, value);
      return nextEnv;
    }
    case "CtorPattern": {
      if (value.kind !== "Ctor" || value.name !== pattern.ctorName) {
        return null;
      }
      const nextEnv = new Map(env);
      for (const fieldPattern of pattern.fields) {
        const fieldValue = value.fields.get(fieldPattern.name);
        if (!fieldValue) {
          return null;
        }
        const boundEnv = tryMatchPattern(fieldPattern.pattern, fieldValue, nextEnv);
        if (!boundEnv) {
          return null;
        }
        for (const [key, val] of boundEnv.entries()) {
          nextEnv.set(key, val);
        }
      }
      return nextEnv;
    }
    default:
      return null;
  }
}

function evalExpr(expr: ast.Expr, env: Env, runtime: Runtime): Value {
  switch (expr.kind) {
    case "IntLiteral":
      return { kind: "Int", value: expr.value };
    case "BoolLiteral":
      return { kind: "Bool", value: expr.value };
    case "StringLiteral":
      return { kind: "String", value: expr.value };
    case "VarRef": {
      const value = env.get(expr.name);
      if (value === undefined) {
        throw new RuntimeError(`Unbound variable '${expr.name}'`);
      }
      return value;
    }
    case "ListLiteral":
      return {
        kind: "List",
        elements: expr.elements.map((element) => evalExpr(element, env, runtime)),
      };
    case "BinaryExpr":
      return evalBinary(expr, env, runtime);
    case "CallExpr":
      return evalCall(expr, env, runtime);
    case "RecordExpr":
      return evalRecord(expr, env, runtime);
    case "FieldAccessExpr":
      return evalFieldAccess(expr, env, runtime);
    case "IndexExpr":
      return evalIndexExpr(expr, env, runtime);
    case "IfExpr":
      return evalIfExpr(expr, env, runtime);
    default:
      throw new RuntimeError(`Unsupported expression kind: ${(expr as ast.Expr).kind}`);
  }
}

function evalBinary(expr: ast.BinaryExpr, env: Env, runtime: Runtime): Value {
  const left = evalExpr(expr.left, env, runtime);
  const right = evalExpr(expr.right, env, runtime);

  switch (expr.op) {
    case "+":
      return makeInt(binaryIntOp(left, right, (a, b) => a + b));
    case "-":
      return makeInt(binaryIntOp(left, right, (a, b) => a - b));
    case "*":
      return makeInt(binaryIntOp(left, right, (a, b) => a * b));
    case "/":
      return makeInt(binaryIntOp(left, right, (a, b) => Math.floor(a / b)));
    case "==":
      return { kind: "Bool", value: valueEquals(left, right) };
    case "!=":
      return { kind: "Bool", value: !valueEquals(left, right) };
    case "&&":
      return makeBool(binaryBoolOp(left, right, (a, b) => a && b));
    case "||":
      return makeBool(binaryBoolOp(left, right, (a, b) => a || b));
    case "<":
      return makeBool(binaryIntOp(left, right, (a, b) => a < b) === 1);
    case "<=":
      return makeBool(binaryIntOp(left, right, (a, b) => a <= b) === 1);
    case ">":
      return makeBool(binaryIntOp(left, right, (a, b) => a > b) === 1);
    case ">=":
      return makeBool(binaryIntOp(left, right, (a, b) => a >= b) === 1);
    default:
      throw new RuntimeError(`Unsupported binary operator '${expr.op}'`);
  }
}

function makeInt(value: number | Value): Value {
  if (typeof value === "number") {
    return { kind: "Int", value };
  }
  return value;
}

function makeBool(value: boolean): Value {
  return { kind: "Bool", value };
}

function binaryIntOp(left: Value, right: Value, op: (a: number, b: number) => number | boolean): number {
  if (left.kind !== "Int" || right.kind !== "Int") {
    throw new RuntimeError("Arithmetic operations require integer operands");
  }
  const result = op(left.value, right.value);
  if (typeof result === "boolean") {
    return result ? 1 : 0;
  }
  return result;
}

function binaryBoolOp(left: Value, right: Value, op: (a: boolean, b: boolean) => boolean): boolean {
  if (left.kind !== "Bool" || right.kind !== "Bool") {
    throw new RuntimeError("Logical operations require boolean operands");
  }
  return op(left.value, right.value);
}

function evalCall(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  switch (expr.callee) {
    case "list.len":
      return builtinLength(expr, env, runtime);
    case "test.assert_equal":
      return builtinAssertEqual(expr, env, runtime);
    case "assert":
      return builtinAssert(expr, env, runtime);
    case "str.concat":
      return builtinStrConcat(expr, env, runtime);
    case "str.len":
      return builtinStrLen(expr, env, runtime);
    case "str.slice":
      return builtinStrSlice(expr, env, runtime);
    case "str.at":
      return builtinStrAt(expr, env, runtime);
    case "math.abs":
      return builtinMathAbs(expr, env, runtime);
    case "math.min":
      return builtinMathMin(expr, env, runtime);
    case "math.max":
      return builtinMathMax(expr, env, runtime);
    case "list.map":
      return builtinListMap(expr, env, runtime);
    case "list.filter":
      return builtinListFilter(expr, env, runtime);
    case "list.fold":
      return builtinListFold(expr, env, runtime);
    case "Log.debug":
      return builtinLog("debug", expr, env, runtime);
    case "Log.trace":
      return builtinLog("trace", expr, env, runtime);
    case "__negate":
      return builtinNegate(expr, env, runtime);
    case "__not":
      return builtinNot(expr, env, runtime);
    default:
      return callUserFunction(expr, env, runtime);
  }
}

function builtinLength(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 1) {
    throw new RuntimeError("length expects exactly one argument");
  }
  const listArg = expr.args[0]!;
  const listValue = evalExpr(listArg, env, runtime);
  if (listValue.kind !== "List") {
    throw new RuntimeError("length expects a list argument");
  }
  return { kind: "Int", value: listValue.elements.length };
}

function builtinAssertEqual(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 2) {
    throw new RuntimeError("test.assert_equal expects exactly two arguments");
  }
  const left = evalExpr(expr.args[0]!, env, runtime);
  const right = evalExpr(expr.args[1]!, env, runtime);
  if (!valueEquals(left, right)) {
    throw new RuntimeError("test.assert_equal failed");
  }
  return { kind: "Unit" };
}

function builtinAssert(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 1) {
    throw new RuntimeError("assert expects exactly one argument");
  }
  const condition = evalExpr(expr.args[0]!, env, runtime);
  if (condition.kind !== "Bool") {
    throw new RuntimeError("assert expects a boolean argument");
  }
  if (!condition.value) {
    throw new RuntimeError("assertion failed");
  }
  return { kind: "Unit" };
}

function builtinStrConcat(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 2) {
    throw new RuntimeError("str_concat expects exactly two arguments");
  }
  const left = evalExpr(expr.args[0]!, env, runtime);
  const right = evalExpr(expr.args[1]!, env, runtime);
  if (left.kind !== "String" || right.kind !== "String") {
    throw new RuntimeError("str_concat expects two string arguments");
  }
  return { kind: "String", value: left.value + right.value };
}

function builtinLog(level: "debug" | "trace", expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 2) {
    throw new RuntimeError(`Log.${level} expects exactly two arguments`);
  }
  const labelValue = evalExpr(expr.args[0]!, env, runtime);
  if (labelValue.kind !== "String") {
    throw new RuntimeError(`Log.${level} expects the first argument to be a string label`);
  }
  const payloadValue = evalExpr(expr.args[1]!, env, runtime);
  if (payloadValue.kind !== "Ctor") {
    throw new RuntimeError(`Log.${level} expects the payload to be a record value`);
  }

  const payloadPretty = prettyValue(payloadValue);
  
  // Structured logging support
  if (runtime.outputFormat === "json" && runtime.logs) {
    const { createLog } = require("./structured");
    const log = createLog(
      level,
      labelValue.value,
      payloadPretty as Record<string, any>,
      undefined,
      new Date().toISOString()
    );
    runtime.logs.push(log);
  } else {
    // Text output (default)
    const serializedPayload = JSON.stringify(payloadPretty);
    // eslint-disable-next-line no-console
    console.log(`[Log.${level}] ${labelValue.value} ${serializedPayload}`);
  }

  return { kind: "Unit" };
}

function builtinNegate(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 1) {
    throw new RuntimeError("negation expects exactly one argument");
  }
  const value = evalExpr(expr.args[0]!, env, runtime);
  if (value.kind !== "Int") {
    throw new RuntimeError("negation expects an integer argument");
  }
  return { kind: "Int", value: -value.value };
}

function builtinNot(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 1) {
    throw new RuntimeError("logical not expects exactly one argument");
  }
  const value = evalExpr(expr.args[0]!, env, runtime);
  if (value.kind !== "Bool") {
    throw new RuntimeError("logical not expects a boolean argument");
  }
  return { kind: "Bool", value: !value.value };
}

// String operations
function builtinStrLen(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 1) {
    throw new RuntimeError("str.len expects exactly one argument");
  }
  const str = evalExpr(expr.args[0]!, env, runtime);
  if (str.kind !== "String") {
    throw new RuntimeError("str.len expects a string argument");
  }
  return { kind: "Int", value: str.value.length };
}

function builtinStrSlice(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 3) {
    throw new RuntimeError("str.slice expects exactly three arguments");
  }
  const str = evalExpr(expr.args[0]!, env, runtime);
  const start = evalExpr(expr.args[1]!, env, runtime);
  const end = evalExpr(expr.args[2]!, env, runtime);
  
  if (str.kind !== "String") {
    throw new RuntimeError("str.slice expects a string as first argument");
  }
  if (start.kind !== "Int" || end.kind !== "Int") {
    throw new RuntimeError("str.slice expects integer start and end positions");
  }
  
  return { kind: "String", value: str.value.slice(start.value, end.value) };
}

function builtinStrAt(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 2) {
    throw new RuntimeError("str.at expects exactly two arguments");
  }
  const str = evalExpr(expr.args[0]!, env, runtime);
  const index = evalExpr(expr.args[1]!, env, runtime);
  
  if (str.kind !== "String") {
    throw new RuntimeError("str.at expects a string as first argument");
  }
  if (index.kind !== "Int") {
    throw new RuntimeError("str.at expects an integer index");
  }
  
  const idx = index.value;
  if (idx < 0 || idx >= str.value.length) {
    // Return None
    return { kind: "Ctor", name: "None", fields: new Map() };
  }
  
  // Return Some(char)
  const char = str.value.charAt(idx);
  const fields = new Map<string, Value>();
  fields.set("value", { kind: "String", value: char });
  return {
    kind: "Ctor",
    name: "Some",
    fields,
  };
}

// Math operations
function builtinMathAbs(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 1) {
    throw new RuntimeError("math.abs expects exactly one argument");
  }
  const value = evalExpr(expr.args[0]!, env, runtime);
  if (value.kind !== "Int") {
    throw new RuntimeError("math.abs expects an integer argument");
  }
  return { kind: "Int", value: Math.abs(value.value) };
}

function builtinMathMin(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 2) {
    throw new RuntimeError("math.min expects exactly two arguments");
  }
  const left = evalExpr(expr.args[0]!, env, runtime);
  const right = evalExpr(expr.args[1]!, env, runtime);
  
  if (left.kind !== "Int" || right.kind !== "Int") {
    throw new RuntimeError("math.min expects integer arguments");
  }
  return { kind: "Int", value: Math.min(left.value, right.value) };
}

function builtinMathMax(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 2) {
    throw new RuntimeError("math.max expects exactly two arguments");
  }
  const left = evalExpr(expr.args[0]!, env, runtime);
  const right = evalExpr(expr.args[1]!, env, runtime);
  
  if (left.kind !== "Int" || right.kind !== "Int") {
    throw new RuntimeError("math.max expects integer arguments");
  }
  return { kind: "Int", value: Math.max(left.value, right.value) };
}

// List operations
function builtinListMap(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 2) {
    throw new RuntimeError("list.map expects exactly two arguments");
  }
  const list = evalExpr(expr.args[0]!, env, runtime);
  const fnArg = expr.args[1]!;
  
  if (list.kind !== "List") {
    throw new RuntimeError("list.map expects a list as first argument");
  }
  
  // The function argument should be a variable name referencing a function
  if (fnArg.kind !== "VarRef") {
    throw new RuntimeError("list.map expects a function as second argument");
  }
  
  const fnName = fnArg.name;
  let resolvedFnName = fnName;
  
  // Resolve identifier if we have a symbol table
  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("./loader");
    resolvedFnName = resolveIdentifier(fnName, runtime.module, runtime.symbolTable);
  }
  
  const fn = runtime.functions.get(resolvedFnName);
  if (!fn) {
    throw new RuntimeError(`Unknown function '${fnName}' in list.map`);
  }
  if (fn.params.length !== 1) {
    throw new RuntimeError("list.map expects a function that takes exactly one argument");
  }
  
  const mapped = list.elements.map((element) => {
    const callEnv: Env = new Map();
    callEnv.set(fn.params[0]!.name, element);
    const result = evalBlock(fn.body, callEnv, runtime);
    return result.value;
  });
  
  return { kind: "List", elements: mapped };
}

function builtinListFilter(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 2) {
    throw new RuntimeError("list.filter expects exactly two arguments");
  }
  const list = evalExpr(expr.args[0]!, env, runtime);
  const fnArg = expr.args[1]!;
  
  if (list.kind !== "List") {
    throw new RuntimeError("list.filter expects a list as first argument");
  }
  
  if (fnArg.kind !== "VarRef") {
    throw new RuntimeError("list.filter expects a function as second argument");
  }
  
  const fnName = fnArg.name;
  let resolvedFnName = fnName;
  
  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("./loader");
    resolvedFnName = resolveIdentifier(fnName, runtime.module, runtime.symbolTable);
  }
  
  const fn = runtime.functions.get(resolvedFnName);
  if (!fn) {
    throw new RuntimeError(`Unknown function '${fnName}' in list.filter`);
  }
  if (fn.params.length !== 1) {
    throw new RuntimeError("list.filter expects a function that takes exactly one argument");
  }
  
  const filtered = list.elements.filter((element) => {
    const callEnv: Env = new Map();
    callEnv.set(fn.params[0]!.name, element);
    const result = evalBlock(fn.body, callEnv, runtime);
    if (result.value.kind !== "Bool") {
      throw new RuntimeError("list.filter predicate must return a boolean");
    }
    return result.value.value;
  });
  
  return { kind: "List", elements: filtered };
}

function builtinListFold(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  if (expr.args.length !== 3) {
    throw new RuntimeError("list.fold expects exactly three arguments");
  }
  const list = evalExpr(expr.args[0]!, env, runtime);
  const initial = evalExpr(expr.args[1]!, env, runtime);
  const fnArg = expr.args[2]!;
  
  if (list.kind !== "List") {
    throw new RuntimeError("list.fold expects a list as first argument");
  }
  
  if (fnArg.kind !== "VarRef") {
    throw new RuntimeError("list.fold expects a function as third argument");
  }
  
  const fnName = fnArg.name;
  let resolvedFnName = fnName;
  
  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("./loader");
    resolvedFnName = resolveIdentifier(fnName, runtime.module, runtime.symbolTable);
  }
  
  const fn = runtime.functions.get(resolvedFnName);
  if (!fn) {
    throw new RuntimeError(`Unknown function '${fnName}' in list.fold`);
  }
  if (fn.params.length !== 2) {
    throw new RuntimeError("list.fold expects a function that takes exactly two arguments");
  }
  
  let accumulator = initial;
  for (const element of list.elements) {
    const callEnv: Env = new Map();
    callEnv.set(fn.params[0]!.name, accumulator);
    callEnv.set(fn.params[1]!.name, element);
    const result = evalBlock(fn.body, callEnv, runtime);
    accumulator = result.value;
  }
  
  return accumulator;
}

function callUserFunction(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  let calleeName = expr.callee;
  
  // Resolve identifier if we have a symbol table
  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("./loader");
    calleeName = resolveIdentifier(expr.callee, runtime.module, runtime.symbolTable);
  }
  
  const fn = runtime.functions.get(calleeName);
  if (!fn) {
    throw new RuntimeError(`Unknown function '${expr.callee}'`);
  }
  if (fn.params.length !== expr.args.length) {
    throw new RuntimeError(
      `Function '${expr.callee}' expects ${fn.params.length} arguments but received ${expr.args.length}`,
    );
  }

  const callEnv: Env = new Map();
  for (let i = 0; i < fn.params.length; i += 1) {
    const param = fn.params[i]!;
    const argExpr = expr.args[i]!;
    const argValue = evalExpr(argExpr, env, runtime);
    callEnv.set(param.name, argValue);
  }

  const result = evalBlock(fn.body, callEnv, runtime);
  return result.value;
}

type ParameterGenerationResult =
  | { success: true }
  | { success: false; paramName: string; message: string; cause?: unknown };

function runProperty(property: ast.PropertyDecl, runtime: Runtime): TestOutcome {
  const iterations = property.iterations ?? DEFAULT_PROPERTY_RUNS;
  const rng = () => Math.random();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const env: Env = new Map();
    const generation = generateParametersForProperty(property, env, runtime, rng);
    if (!generation.success) {
      const snapshot = snapshotEnv(env);
      const parts: string[] = [
        `Property '${property.name}' could not generate value for parameter '${generation.paramName}': ${generation.message}`,
      ];
      if (generation.cause) {
        const causeMessage = generation.cause instanceof Error ? generation.cause.message : String(generation.cause);
        parts.push(`Cause: ${causeMessage}`);
      }
      if (Object.keys(snapshot).length > 0) {
        parts.push(`Bound inputs: ${JSON.stringify(snapshot)}`);
      }
      return {
        kind: "property",
        name: property.name,
        success: false,
        error: new RuntimeError(parts.join(" ")),
      };
    }

    try {
      const result = evalBlock(property.body, new Map(env), runtime);
      if (result.type === "return" && result.value.kind !== "Unit") {
        return {
          kind: "property",
          name: property.name,
          success: false,
          error: propertyFailureError(property.name, iteration, env, "Properties must not return non-unit values"),
        };
      }
    } catch (error) {
      return {
        kind: "property",
        name: property.name,
        success: false,
        error: propertyFailureError(property.name, iteration, env, error),
      };
    }
  }

  return { kind: "property", name: property.name, success: true };
}

function generateParametersForProperty(
  property: ast.PropertyDecl,
  env: Env,
  runtime: Runtime,
  rng: () => number,
): ParameterGenerationResult {
  for (const param of property.params) {
    const result = tryGenerateParameter(param, env, runtime, rng);
    if (!result.success) {
      return result;
    }
  }
  return { success: true };
}

function tryGenerateParameter(
  param: ast.PropertyParam,
  env: Env,
  runtime: Runtime,
  rng: () => number,
): ParameterGenerationResult {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const candidate = generateValueForTypeExpr(param.type, runtime, 0, rng);
    env.set(param.name, candidate);

    if (!param.predicate) {
      return { success: true };
    }

    let predicateValue: Value;
    try {
      predicateValue = evalExpr(param.predicate, env, runtime);
    } catch (error) {
      return {
        success: false,
        paramName: param.name,
        message: "error evaluating predicate",
        cause: error,
      };
    }

    if (predicateValue.kind !== "Bool") {
      return {
        success: false,
        paramName: param.name,
        message: "predicate must evaluate to a boolean value",
      };
    }

    if (predicateValue.value) {
      return { success: true };
    }

    env.delete(param.name);
  }

  return {
    success: false,
    paramName: param.name,
    message: `predicate remained unsatisfied after ${MAX_GENERATION_ATTEMPTS} attempts`,
  };
}

function propertyFailureError(propertyName: string, iteration: number, env: Env, cause: unknown): RuntimeError {
  const snapshot = snapshotEnv(env);
  const serializedInputs = JSON.stringify(snapshot);
  const causeMessage =
    cause instanceof RuntimeError || cause instanceof Error ? cause.message : String(cause);
  return new RuntimeError(
    `Property '${propertyName}' failed on iteration ${iteration + 1} with input ${serializedInputs}: ${causeMessage}`,
  );
}

function snapshotEnv(env: Env): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [name, value] of env.entries()) {
    obj[name] = prettyValue(value);
  }
  return obj;
}

function generateValueForTypeExpr(
  typeExpr: ast.TypeExpr,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  if (depth > MAX_GENERATION_DEPTH) {
    return defaultValueForType(typeExpr, runtime);
  }

  if (typeExpr.kind === "OptionalType") {
    return generateOptionalValue(typeExpr, runtime, depth, rng);
  }

  if (typeExpr.kind === "TypeName") {
    return generateFromTypeName(typeExpr, runtime, depth, rng);
  }

  return { kind: "Unit" };
}

function generateFromTypeName(
  typeExpr: Extract<ast.TypeExpr, { kind: "TypeName" }>,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  if (typeExpr.typeArgs.length === 0) {
    switch (typeExpr.name) {
      case "Int":
        return { kind: "Int", value: randomInt(rng) };
      case "Bool":
        return { kind: "Bool", value: randomBool(rng) };
      case "String":
        return { kind: "String", value: randomString(rng) };
      case "Unit":
        return { kind: "Unit" };
      default:
        break;
    }
  }

  if (typeExpr.name === "List") {
    const elementType = typeExpr.typeArgs[0] ?? { kind: "TypeName", name: "Int", typeArgs: [] };
    return generateListValue(elementType, runtime, depth, rng);
  }

  if (typeExpr.name === "Option" && typeExpr.typeArgs.length === 1) {
    const inner = typeExpr.typeArgs[0]!;
    return generateOptionalValue({ kind: "OptionalType", inner }, runtime, depth, rng);
  }

  const decl = findTypeDecl(runtime, typeExpr.name);
  if (!decl) {
    return { kind: "Unit" };
  }

  switch (decl.kind) {
    case "AliasTypeDecl": {
      const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
      const target = substituteTypeExpr(decl.target, substitutions);
      return generateValueForTypeExpr(target, runtime, depth + 1, rng);
    }
    case "RecordTypeDecl":
      return generateRecordValue(decl, typeExpr, runtime, depth, rng);
    case "SumTypeDecl":
      return generateSumValue(decl, typeExpr, runtime, depth, rng);
    default:
      return { kind: "Unit" };
  }
}

function generateRecordValue(
  decl: ast.RecordTypeDecl,
  typeExpr: Extract<ast.TypeExpr, { kind: "TypeName" }>,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
  const fields = new Map<string, Value>();
  for (const field of decl.fields) {
    const fieldType = substituteTypeExpr(field.type, substitutions);
    const value = generateValueForTypeExpr(fieldType, runtime, depth + 1, rng);
    fields.set(field.name, value);
  }
  return { kind: "Ctor", name: decl.name, fields };
}

function generateSumValue(
  decl: ast.SumTypeDecl,
  typeExpr: Extract<ast.TypeExpr, { kind: "TypeName" }>,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  if (decl.variants.length === 0) {
    return { kind: "Unit" };
  }

  const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
  let variant: ast.Variant;
  if (depth >= MAX_GENERATION_DEPTH) {
    variant = decl.variants.find((candidate) => candidate.fields.length === 0) ?? decl.variants[0]!;
  } else {
    const index = Math.floor(rng() * decl.variants.length);
    variant = decl.variants[index] ?? decl.variants[0]!;
  }

  const fields = new Map<string, Value>();
  for (const field of variant.fields) {
    const fieldType = substituteTypeExpr(field.type, substitutions);
    const value = generateValueForTypeExpr(fieldType, runtime, depth + 1, rng);
    fields.set(field.name, value);
  }

  return { kind: "Ctor", name: variant.name, fields };
}

function generateListValue(
  elementType: ast.TypeExpr,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  const maxLength = depth >= MAX_GENERATION_DEPTH ? 0 : 3;
  const length = maxLength === 0 ? 0 : Math.floor(rng() * (maxLength + 1));
  const elements: Value[] = [];
  for (let i = 0; i < length; i += 1) {
    elements.push(generateValueForTypeExpr(elementType, runtime, depth + 1, rng));
  }
  return { kind: "List", elements };
}

function generateOptionalValue(
  typeExpr: Extract<ast.TypeExpr, { kind: "OptionalType" }>,
  runtime: Runtime,
  depth: number,
  rng: () => number,
): Value {
  if (depth >= MAX_GENERATION_DEPTH || rng() < 0.3) {
    return makeCtor("None");
  }
  const value = generateValueForTypeExpr(typeExpr.inner, runtime, depth + 1, rng);
  return makeCtor("Some", [["value", value]]);
}

function findTypeDecl(runtime: Runtime, name: string): ast.TypeDecl | undefined {
  if (runtime.typeDecls.has(name)) {
    return runtime.typeDecls.get(name);
  }
  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("./loader");
    const qualified = resolveIdentifier(name, runtime.module, runtime.symbolTable);
    return runtime.typeDecls.get(qualified);
  }
  return undefined;
}

function buildTypeArgMap(params: string[], args: ast.TypeExpr[]): Map<string, ast.TypeExpr> {
  const map = new Map<string, ast.TypeExpr>();
  for (let i = 0; i < params.length; i += 1) {
    const paramName = params[i]!;
    const arg = args[i] ?? { kind: "TypeName", name: "Int", typeArgs: [] };
    map.set(paramName, arg);
  }
  return map;
}

function substituteTypeExpr(
  typeExpr: ast.TypeExpr,
  substitutions: Map<string, ast.TypeExpr>,
  depth = 0,
): ast.TypeExpr {
  if (depth > 10) {
    return typeExpr;
  }

  if (typeExpr.kind === "TypeName") {
    if (typeExpr.typeArgs.length > 0) {
      return {
        kind: "TypeName",
        name: typeExpr.name,
        typeArgs: typeExpr.typeArgs.map((arg) => substituteTypeExpr(arg, substitutions, depth + 1)),
      };
    }
    const replacement = substitutions.get(typeExpr.name);
    if (replacement) {
      return substituteTypeExpr(replacement, substitutions, depth + 1);
    }
    return typeExpr;
  }

  if (typeExpr.kind === "OptionalType") {
    return {
      kind: "OptionalType",
      inner: substituteTypeExpr(typeExpr.inner, substitutions, depth + 1),
    };
  }

  return typeExpr;
}

function defaultValueForType(typeExpr: ast.TypeExpr, runtime: Runtime): Value {
  if (typeExpr.kind === "OptionalType") {
    return makeCtor("None");
  }

  if (typeExpr.kind === "TypeName") {
    switch (typeExpr.name) {
      case "Int":
        return { kind: "Int", value: 0 };
      case "Bool":
        return { kind: "Bool", value: false };
      case "String":
        return { kind: "String", value: "" };
      case "Unit":
        return { kind: "Unit" };
      case "List":
        return { kind: "List", elements: [] };
      default:
        break;
    }

    const decl = findTypeDecl(runtime, typeExpr.name);
    if (!decl) {
      return { kind: "Unit" };
    }

    if (decl.kind === "AliasTypeDecl") {
      const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
      const target = substituteTypeExpr(decl.target, substitutions);
      return defaultValueForType(target, runtime);
    }

    if (decl.kind === "RecordTypeDecl") {
      const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
      const fields = new Map<string, Value>();
      for (const field of decl.fields) {
        const fieldType = substituteTypeExpr(field.type, substitutions);
        fields.set(field.name, defaultValueForType(fieldType, runtime));
      }
      return { kind: "Ctor", name: decl.name, fields };
    }

    if (decl.kind === "SumTypeDecl") {
      const substitutions = buildTypeArgMap(decl.typeParams, typeExpr.typeArgs);
      const variant = decl.variants.find((candidate) => candidate.fields.length === 0) ?? decl.variants[0];
      if (!variant) {
        return { kind: "Unit" };
      }
      const fields = new Map<string, Value>();
      for (const field of variant.fields) {
        const fieldType = substituteTypeExpr(field.type, substitutions);
        fields.set(field.name, defaultValueForType(fieldType, runtime));
      }
      return { kind: "Ctor", name: variant.name, fields };
    }
  }

  return { kind: "Unit" };
}

function randomInt(rng: () => number): number {
  return Math.floor(rng() * 41) - 20;
}

function randomBool(rng: () => number): boolean {
  return rng() < 0.5;
}

function randomString(rng: () => number): string {
  const length = Math.floor(rng() * 6);
  let result = "";
  for (let i = 0; i < length; i += 1) {
    const index = Math.floor(rng() * RANDOM_STRING_CHARS.length);
    result += RANDOM_STRING_CHARS[index] ?? "a";
  }
  return result;
}

function makeCtor(name: string, entries?: [string, Value][]): Value {
  const fields = new Map<string, Value>();
  if (entries) {
    for (const [fieldName, fieldValue] of entries) {
      fields.set(fieldName, fieldValue);
    }
  }
  return { kind: "Ctor", name, fields };
}

function evalRecord(expr: ast.RecordExpr, env: Env, runtime: Runtime): Value {
  const fields = new Map<string, Value>();
  for (const field of expr.fields) {
    fields.set(field.name, evalExpr(field.expr, env, runtime));
  }
  return {
    kind: "Ctor",
    name: expr.typeName,
    fields,
  };
}

function evalFieldAccess(expr: ast.FieldAccessExpr, env: Env, runtime: Runtime): Value {
  const target = evalExpr(expr.target, env, runtime);
  if (target.kind !== "Ctor") {
    throw new RuntimeError("Field access expects a record/constructor value");
  }
  const value = target.fields.get(expr.field);
  if (value === undefined) {
    throw new RuntimeError(`Field '${expr.field}' does not exist on '${target.name}'`);
  }
  return value;
}

function evalIndexExpr(expr: ast.IndexExpr, env: Env, runtime: Runtime): Value {
  const target = evalExpr(expr.target, env, runtime);
  const index = evalExpr(expr.index, env, runtime);
  if (target.kind !== "List") {
    throw new RuntimeError("Indexing expects a list target");
  }
  if (index.kind !== "Int") {
    throw new RuntimeError("Indexing expects an integer index");
  }
  if (index.value < 0 || index.value >= target.elements.length) {
    throw new RuntimeError("Index out of bounds");
  }
  const element = target.elements[index.value];
  if (element === undefined) {
    throw new RuntimeError("Index out of bounds");
  }
  return element;
}

function evalIfExpr(expr: ast.IfExpr, env: Env, runtime: Runtime): Value {
  const condition = evalExpr(expr.cond, env, runtime);
  if (condition.kind !== "Bool") {
    throw new RuntimeError("if condition must evaluate to a boolean value");
  }
  const branchEnv = new Map(env);
  if (condition.value) {
    const result = evalBlock(expr.thenBranch, branchEnv, runtime);
    return result.value;
  }
  if (expr.elseBranch) {
    const result = evalBlock(expr.elseBranch, branchEnv, runtime);
    return result.value;
  }
  return { kind: "Unit" };
}

function enforceContractClauses(
  clauses: ast.Expr[],
  env: Env,
  runtime: Runtime,
  fnName: string,
  clauseType: "requires" | "ensures",
) {
  for (const clause of clauses) {
    const value = evalExpr(clause, env, runtime);
    if (value.kind !== "Bool") {
      throw new RuntimeError(`Contract ${clauseType} clause for '${fnName}' must evaluate to a boolean value`);
    }
    if (!value.value) {
      throw new RuntimeError(`Contract ${clauseType} clause failed for '${fnName}'`);
    }
  }
}

function valueEquals(a: Value, b: Value): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "Int":
    case "Bool":
    case "String":
      return a.value === (b as typeof a).value;
    case "Unit":
      return true;
    case "List": {
      const bb = b as typeof a;
      if (a.elements.length !== bb.elements.length) {
        return false;
      }
      for (let i = 0; i < a.elements.length; i += 1) {
        const left = a.elements[i];
        const right = bb.elements[i];
        if (left === undefined || right === undefined || !valueEquals(left, right)) {
          return false;
        }
      }
      return true;
    }
    case "Ctor": {
      const bb = b as typeof a;
      if (a.name !== bb.name || a.fields.size !== bb.fields.size) {
        return false;
      }
      for (const [key, val] of a.fields.entries()) {
        const other = bb.fields.get(key);
        if (!other || !valueEquals(val, other)) {
          return false;
        }
      }
      return true;
    }
    default:
      return false;
  }
}

export function prettyValue(value: Value): unknown {
  switch (value.kind) {
    case "Int":
    case "Bool":
    case "String":
      return value.value;
    case "Unit":
      return null;
    case "List":
      return value.elements.map((element) => prettyValue(element));
    case "Ctor": {
      const obj: Record<string, unknown> = {};
      for (const [key, fieldValue] of value.fields.entries()) {
        obj[key] = prettyValue(fieldValue);
      }
      return { [value.name]: obj };
    }
    default:
      return null;
  }
}

function addTrace(
  runtime: Runtime,
  stepType: "call" | "return" | "let" | "expr" | "match",
  description: string,
  value?: Value,
  location?: ast.SourceLocation
) {
  if (!runtime.tracing || !runtime.traces) {
    return;
  }
  
  const depth = runtime.traceDepth ?? 0;
  const { sourceLocationToErrorLocation } = require("./structured");
  
  runtime.traces.push({
    kind: "trace",
    stepType,
    description,
    value: value ? prettyValue(value) : undefined,
    location: location ? sourceLocationToErrorLocation(location) : undefined,
    depth,
  });
}

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}
