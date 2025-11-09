import * as ast from "./ast";

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
  // For multi-module support
  symbolTable?: import("./loader").SymbolTable;
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
  name: string;
  success: boolean;
  error?: unknown;
};

export function buildRuntime(module: ast.Module): Runtime {
  const functions = new Map<string, ast.FnDecl>();
  const contracts = new Map<string, FnContract>();
  const tests: ast.TestDecl[] = [];

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
    }
  }

  return { module, functions, contracts, tests };
}

/**
 * Build runtime from multiple modules with cross-module symbol resolution
 */
export function buildMultiModuleRuntime(
  modules: import("./loader").ResolvedModule[],
  symbolTable: import("./loader").SymbolTable
): Runtime {
  const functions = new Map<string, ast.FnDecl>();
  const contracts = new Map<string, FnContract>();
  const tests: ast.TestDecl[] = [];
  
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
      }
    }
  }
  
  return { module: primaryModule, functions, contracts, tests, symbolTable };
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

  const paramEnv: Env = new Map();
  for (let i = 0; i < fn.params.length; i += 1) {
    const param = fn.params[i]!;
    const arg = args[i]!;
    paramEnv.set(param.name, arg);
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

  return returnValue;
}

export function runTests(runtime: Runtime): TestOutcome[] {
  return runtime.tests.map((test) => {
    try {
      const env: Env = new Map();
      const result = evalBlock(test.body, env, runtime);
      if (result.type === "return" && result.value.kind !== "Unit") {
        return {
          name: test.name,
          success: false,
          error: new RuntimeError("Tests must not return non-unit values"),
        };
      }
      return { name: test.name, success: true };
    } catch (error) {
      return { name: test.name, success: false, error };
    }
  });
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
    case "str.concat":
      return builtinStrConcat(expr, env, runtime);
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

  const serializedPayload = JSON.stringify(prettyValue(payloadValue));
  // eslint-disable-next-line no-console
  console.log(`[Log.${level}] ${labelValue.value} ${serializedPayload}`);

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

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}
