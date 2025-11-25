import * as ast from "../ast";
import { alignCallArguments, CallArgIssue } from "../callargs";
import { RuntimeError } from "./errors";
import {
  ActorInstance,
  prepareActorHandlerArgs,
  processActorDeliveries,
  registerActorSupervision,
  stopActor,
} from "./actors";
import { Runtime, Value, Env, EvalResult } from "./types";
import {
  jsValueToValue,
  makeActorRefValue,
  makeBool,
  makeCtor,
  makeInt,
  prettyValue,
  valueEquals,
  valueToJsValue,
} from "./values";
import { createLog } from "../structured";

type MatchEnv = Env;

type AsyncTask = {
  env: Env;
  stmts: ast.Stmt[];
  nextIndex: number;
  completed: boolean;
  cancelled: boolean;
};

type AsyncGroupContext = {
  tasks: AsyncTask[];
};

/**
 * Parameter names for builtin functions (used for named argument alignment).
 * Must be kept in sync with builtin implementations.
 */
const BUILTIN_PARAM_NAMES: Record<string, string[]> = {
  "list.len": ["list"],
  "list.append": ["list", "item"],
  "list.concat": ["left", "right"],
  "list.head": ["list"],
  "list.tail": ["list"],
  "list.take": ["list", "count"],
  "list.drop": ["list", "count"],
  "list.reverse": ["list"],
  "list.contains": ["list", "item"],
  "list.find": ["list", "predicate"],
  "list.flat_map": ["list", "mapper"],
  "list.zip": ["left", "right"],
  "list.enumerate": ["list"],
  "test.assert_equal": ["expected", "actual"],
  assert: ["condition"],
  "str.concat": ["left", "right"],
  "str.split": ["text", "delimiter"],
  "str.join": ["list", "delimiter"],
  "str.contains": ["text", "substring"],
  "str.starts_with": ["text", "prefix"],
  "str.ends_with": ["text", "suffix"],
  "str.trim": ["text"],
  "str.to_upper": ["text"],
  "str.to_lower": ["text"],
  "str.replace": ["text", "pattern", "replacement"],
  "str.index_of": ["text", "substring"],
  __negate: ["value"],
  __not: ["value"],
  "Log.debug": ["label", "payload"],
  "Log.trace": ["label", "payload"],
  "str.len": ["text"],
  "str.slice": ["text", "start", "end"],
  "str.at": ["text", "index"],
  "math.abs": ["value"],
  "math.min": ["left", "right"],
  "math.max": ["left", "right"],
  "list.map": ["list", "mapper"],
  "list.filter": ["list", "predicate"],
  "list.fold": ["list", "initial", "reducer"],
  parallel_map: ["list", "mapper"],
  parallel_fold: ["list", "initial", "reducer"],
  parallel_for_each: ["list", "action"],
  "json.encode": ["value"],
  "json.decode": ["text"],
  "Concurrent.flush": [],
  "Concurrent.step": [],
  "Concurrent.stop": ["actor"],
};

/** Get parameter names for a builtin function (throws if not found) */
export function getBuiltinParamNames(name: string): string[] {
  const names = BUILTIN_PARAM_NAMES[name];
  if (!names) {
    throw new RuntimeError(`Internal error: missing parameter metadata for builtin '${name}'`);
  }
  return names;
}

/** Evaluate a block of statements, returning last value or early return */
export function evalBlock(block: ast.Block, env: Env, runtime: Runtime): EvalResult {
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
    case "AsyncGroupStmt": {
      return evalAsyncGroupStmt(stmt, env, runtime);
    }
    case "AsyncStmt": {
      throw new RuntimeError("'async' statements must be nested inside an async_group block");
    }
    default:
      throw new RuntimeError(`Unsupported statement kind: ${(stmt as ast.Stmt).kind}`);
  }
}

function evalAsyncGroupStmt(stmt: ast.AsyncGroupStmt, env: Env, runtime: Runtime): EvalResult {
  const context: AsyncGroupContext = { tasks: [] };

  for (const inner of stmt.body.stmts) {
    if (inner.kind === "AsyncStmt") {
      scheduleAsyncTask(context, inner, env);
      continue;
    }

    if (inner.kind === "ReturnStmt") {
      runAsyncGroupTasks(context, runtime);
      const value = evalExpr(inner.expr, env, runtime);
      return { type: "return", value };
    }

    const result = evalStmt(inner, env, runtime);
    if (result.type === "return") {
      runAsyncGroupTasks(context, runtime);
      return result;
    }
  }

  runAsyncGroupTasks(context, runtime);
  return { type: "value", value: { kind: "Unit" } };
}

function scheduleAsyncTask(context: AsyncGroupContext, stmt: ast.AsyncStmt, env: Env): void {
  const task: AsyncTask = {
    env,
    stmts: stmt.body.stmts,
    nextIndex: 0,
    completed: stmt.body.stmts.length === 0,
    cancelled: false,
  };
  context.tasks.push(task);
}

function runAsyncGroupTasks(context: AsyncGroupContext, runtime: Runtime): void {
  let remaining = context.tasks.filter((task) => !task.completed).length;
  if (remaining === 0) {
    return;
  }

  let index = 0;
  while (remaining > 0) {
    const task = context.tasks[index % context.tasks.length]!;
    index += 1;
    if (task.completed) {
      continue;
    }

    try {
      executeAsyncTaskStep(task, runtime);
    } catch (error) {
      cancelPendingAsyncTasks(context, task);
      throw error;
    }

    if (task.completed) {
      remaining -= 1;
    }
  }
}

function executeAsyncTaskStep(task: AsyncTask, runtime: Runtime): void {
  if (task.completed) {
    return;
  }

  if (task.nextIndex >= task.stmts.length) {
    task.completed = true;
    return;
  }

  const stmt = task.stmts[task.nextIndex]!;
  if (stmt.kind === "AsyncStmt") {
    throw new RuntimeError("'async' statements must be nested inside an async_group block");
  }

  const result = evalStmt(stmt, task.env, runtime);
  task.nextIndex += 1;

  if (result.type === "return") {
    throw new RuntimeError("'return' is not allowed inside async tasks");
  }

  if (task.nextIndex >= task.stmts.length) {
    task.completed = true;
  }
}

function cancelPendingAsyncTasks(context: AsyncGroupContext, failedTask: AsyncTask): void {
  for (const task of context.tasks) {
    if (task === failedTask) {
      continue;
    }
    task.cancelled = true;
    task.completed = true;
  }
}

function evalMatch(stmt: ast.MatchStmt, env: Env, runtime: Runtime): EvalResult {
  const scrutinee = evalExpr(stmt.scrutinee, env, runtime);
  return executeMatch(scrutinee, stmt.cases, env, runtime);
}

function evalMatchExpr(expr: ast.MatchExpr, env: Env, runtime: Runtime): Value {
  const scrutinee = evalExpr(expr.scrutinee, env, runtime);
  const result = executeMatch(scrutinee, expr.cases, env, runtime);
  return result.value;
}

function executeMatch(scrutinee: Value, cases: ast.MatchCase[], env: Env, runtime: Runtime): EvalResult {
  for (const matchCase of cases) {
    const matchEnv = tryMatchPattern(matchCase.pattern, scrutinee, env);
    if (!matchEnv) {
      continue;
    }
    const result = evalBlock(matchCase.body, matchEnv, runtime);
    if (result.type === "return") {
      return result;
    }
    return { type: "value", value: result.value };
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

/**
 * Evaluate an expression to a runtime value.
 * Handles literals, variables, operations, function calls, pattern matching, etc.
 * Throws RuntimeError for evaluation failures.
 */
export function evalExpr(expr: ast.Expr, env: Env, runtime: Runtime): Value {
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
    case "MatchExpr":
      return evalMatchExpr(expr, env, runtime);
    case "RecordExpr":
      return evalRecord(expr, env, runtime);
    case "FieldAccessExpr":
      return evalFieldAccess(expr, env, runtime);
    case "IndexExpr":
      return evalIndexExpr(expr, env, runtime);
    case "IfExpr":
      return evalIfExpr(expr, env, runtime);
    case "HoleExpr":
      throw new RuntimeError(`Encountered unfilled hole${expr.label ? ` '${expr.label}'` : ""}`);
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

function binaryIntOp(
  left: Value,
  right: Value,
  op: (a: number, b: number) => number | boolean,
): number {
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
    case "list.append":
      return builtinListAppend(expr, env, runtime);
    case "list.concat":
      return builtinListConcat(expr, env, runtime);
    case "list.head":
      return builtinListHead(expr, env, runtime);
    case "list.tail":
      return builtinListTail(expr, env, runtime);
    case "list.take":
      return builtinListTake(expr, env, runtime);
    case "list.drop":
      return builtinListDrop(expr, env, runtime);
    case "list.reverse":
      return builtinListReverse(expr, env, runtime);
    case "list.contains":
      return builtinListContains(expr, env, runtime);
    case "list.find":
      return builtinListFind(expr, env, runtime);
    case "list.flat_map":
      return builtinListFlatMap(expr, env, runtime);
    case "list.zip":
      return builtinListZip(expr, env, runtime);
    case "list.enumerate":
      return builtinListEnumerate(expr, env, runtime);
    case "test.assert_equal":
      return builtinAssertEqual(expr, env, runtime);
    case "assert":
      return builtinAssert(expr, env, runtime);
    case "str.concat":
      return builtinStrConcat(expr, env, runtime);
    case "str.split":
      return builtinStrSplit(expr, env, runtime);
    case "str.join":
      return builtinStrJoin(expr, env, runtime);
    case "str.contains":
      return builtinStrContains(expr, env, runtime);
    case "str.starts_with":
      return builtinStrStartsWith(expr, env, runtime);
    case "str.ends_with":
      return builtinStrEndsWith(expr, env, runtime);
    case "str.trim":
      return builtinStrTrim(expr, env, runtime);
    case "str.to_upper":
      return builtinStrToUpper(expr, env, runtime);
    case "str.to_lower":
      return builtinStrToLower(expr, env, runtime);
    case "str.replace":
      return builtinStrReplace(expr, env, runtime);
    case "str.index_of":
      return builtinStrIndexOf(expr, env, runtime);
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
    case "parallel_map":
      return builtinParallelMap(expr, env, runtime);
    case "parallel_fold":
      return builtinParallelFold(expr, env, runtime);
    case "parallel_for_each":
      return builtinParallelForEach(expr, env, runtime);
    case "Log.debug":
      return builtinLog("debug", expr, env, runtime);
    case "Log.trace":
      return builtinLog("trace", expr, env, runtime);
    case "json.encode":
      return builtinJsonEncode(expr, env, runtime);
    case "json.decode":
      return builtinJsonDecode(expr, env, runtime);
    case "Concurrent.flush":
      return builtinConcurrentFlush(expr, env, runtime);
    case "Concurrent.step":
      return builtinConcurrentStep(expr, env, runtime);
    case "Concurrent.stop":
      return builtinConcurrentStop(expr, env, runtime);
    case "__negate":
      return builtinNegate(expr, env, runtime);
    case "__not":
      return builtinNot(expr, env, runtime);
    default:
      return callUserFunction(expr, env, runtime);
  }
}

export type BoundCallArguments = {
  alignment: ReturnType<typeof alignCallArguments>;
  values: Map<string, Value>;
};

export function bindCallArguments(
  expr: ast.CallExpr,
  paramNames: string[],
  env: Env,
  runtime: Runtime,
  options?: { skip?: Iterable<string> },
): BoundCallArguments {
  const alignment = alignCallArguments(expr, paramNames);
  if (alignment.issues.length > 0) {
    const message = describeCallArgIssue(expr.callee, alignment.issues[0]!);
    throw new RuntimeError(message);
  }

  const skipSet = new Set(options?.skip ?? []);
  const values = new Map<string, Value>();
  const argToParam = new Map<ast.CallArg, string>();

  alignment.ordered.forEach((arg, index) => {
    if (arg) {
      argToParam.set(arg, paramNames[index]!);
    }
  });

  for (const arg of expr.args) {
    const paramName = argToParam.get(arg);
    if (!paramName) {
      continue;
    }
    if (skipSet.has(paramName) || values.has(paramName)) {
      continue;
    }
    values.set(paramName, evalExpr(arg.expr, env, runtime));
  }

  return { alignment, values };
}

export function describeCallArgIssue(callee: string, issue: CallArgIssue): string {
  switch (issue.kind) {
    case "TooManyArguments":
      return `Call to '${callee}' has too many arguments`;
    case "UnknownParameter":
      return `Call to '${callee}' has no parameter named '${issue.name}'`;
    case "DuplicateParameter":
      return `Parameter '${issue.name}' was provided multiple times when calling '${callee}'`;
    case "MissingParameter":
      return `Call to '${callee}' is missing an argument for parameter '${issue.name}'`;
    case "PositionalAfterNamed":
      return `Positional arguments must come before named arguments when calling '${callee}'`;
    default:
      return `Invalid arguments supplied to '${callee}'`;
  }
}

export function getArgumentByName(
  alignment: ReturnType<typeof alignCallArguments>,
  paramNames: string[],
  name: string,
): ast.CallArg | null {
  const index = paramNames.indexOf(name);
  if (index === -1) {
    return null;
  }
  return alignment.ordered[index] ?? null;
}

export function expectValue(values: Map<string, Value>, name: string, callee: string): Value {
  const value = values.get(name);
  if (value === undefined) {
    throw new RuntimeError(`Call to '${callee}' is missing argument '${name}'`);
  }
  return value;
}

function builtinLength(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.len"), env, runtime);
  const list = expectValue(values, "list", expr.callee);
  if (list.kind !== "List") {
    throw new RuntimeError("list.len expects a list argument");
  }
  return { kind: "Int", value: list.elements.length };
}

function builtinListAppend(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.append"), env, runtime);
  const list = expectValue(values, "list", expr.callee);
  const item = expectValue(values, "item", expr.callee);
  if (list.kind !== "List") {
    throw new RuntimeError("list.append expects a list as first argument");
  }
  return { kind: "List", elements: [...list.elements, item] };
}

function builtinListConcat(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.concat"), env, runtime);
  const left = expectValue(values, "left", expr.callee);
  const right = expectValue(values, "right", expr.callee);
  if (left.kind !== "List") {
    throw new RuntimeError("list.concat expects a list as first argument");
  }
  if (right.kind !== "List") {
    throw new RuntimeError("list.concat expects a list as second argument");
  }
  return { kind: "List", elements: [...left.elements, ...right.elements] };
}

function builtinAssertEqual(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("test.assert_equal"), env, runtime);
  const expected = expectValue(values, "expected", expr.callee);
  const actual = expectValue(values, "actual", expr.callee);

  if (!valueEquals(expected, actual)) {
    throw new RuntimeError("test.assert_equal failed");
  }

  return { kind: "Unit" };
}

function builtinAssert(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("assert"), env, runtime);
  const condition = expectValue(values, "condition", expr.callee);
  if (condition.kind !== "Bool" || !condition.value) {
    throw new RuntimeError("assertion failed");
  }
  return { kind: "Unit" };
}

function builtinStrConcat(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.concat"), env, runtime);
  const left = expectValue(values, "left", expr.callee);
  const right = expectValue(values, "right", expr.callee);
  if (left.kind !== "String" || right.kind !== "String") {
    throw new RuntimeError("str.concat expects two string arguments");
  }
  return { kind: "String", value: left.value + right.value };
}

function builtinNegate(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("__negate"), env, runtime);
  const value = expectValue(values, "value", expr.callee);
  if (value.kind !== "Int") {
    throw new RuntimeError("negation expects an integer argument");
  }
  return { kind: "Int", value: -value.value };
}

function builtinNot(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("__not"), env, runtime);
  const value = expectValue(values, "value", expr.callee);
  if (value.kind !== "Bool") {
    throw new RuntimeError("logical not expects a boolean argument");
  }
  return { kind: "Bool", value: !value.value };
}

function builtinStrLen(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.len"), env, runtime);
  const str = expectValue(values, "text", expr.callee);
  if (str.kind !== "String") {
    throw new RuntimeError("str.len expects a string argument");
  }
  return { kind: "Int", value: str.value.length };
}

function builtinStrSlice(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.slice"), env, runtime);
  const str = expectValue(values, "text", expr.callee);
  const start = expectValue(values, "start", expr.callee);
  const end = expectValue(values, "end", expr.callee);

  if (str.kind !== "String") {
    throw new RuntimeError("str.slice expects a string as first argument");
  }
  if (start.kind !== "Int" || end.kind !== "Int") {
    throw new RuntimeError("str.slice expects integer start and end positions");
  }

  return { kind: "String", value: str.value.slice(start.value, end.value) };
}

function builtinStrAt(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.at"), env, runtime);
  const str = expectValue(values, "text", expr.callee);
  const index = expectValue(values, "index", expr.callee);

  if (str.kind !== "String") {
    throw new RuntimeError("str.at expects a string as first argument");
  }
  if (index.kind !== "Int") {
    throw new RuntimeError("str.at expects an integer index");
  }

  const idx = index.value;
  if (idx < 0 || idx >= str.value.length) {
    return { kind: "Ctor", name: "None", fields: new Map() };
  }

  const char = str.value.charAt(idx);
  const fields = new Map<string, Value>();
  fields.set("value", { kind: "String", value: char });
  return {
    kind: "Ctor",
    name: "Some",
    fields,
  };
}

// === New String Builtins ===

function builtinStrSplit(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.split"), env, runtime);
  const text = expectValue(values, "text", expr.callee);
  const delimiter = expectValue(values, "delimiter", expr.callee);

  if (text.kind !== "String" || delimiter.kind !== "String") {
    throw new RuntimeError("str.split expects string arguments");
  }

  const parts = text.value.split(delimiter.value);
  return { kind: "List", elements: parts.map((s) => ({ kind: "String", value: s }) as Value) };
}

function builtinStrJoin(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.join"), env, runtime);
  const list = expectValue(values, "list", expr.callee);
  const delimiter = expectValue(values, "delimiter", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("str.join expects a list as first argument");
  }
  if (delimiter.kind !== "String") {
    throw new RuntimeError("str.join expects a string delimiter");
  }

  const strings: string[] = [];
  for (const elem of list.elements) {
    if (elem.kind !== "String") {
      throw new RuntimeError("str.join expects a list of strings");
    }
    strings.push(elem.value);
  }

  return { kind: "String", value: strings.join(delimiter.value) };
}

function builtinStrContains(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.contains"), env, runtime);
  const text = expectValue(values, "text", expr.callee);
  const substring = expectValue(values, "substring", expr.callee);

  if (text.kind !== "String" || substring.kind !== "String") {
    throw new RuntimeError("str.contains expects string arguments");
  }

  return { kind: "Bool", value: text.value.includes(substring.value) };
}

function builtinStrStartsWith(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.starts_with"), env, runtime);
  const text = expectValue(values, "text", expr.callee);
  const prefix = expectValue(values, "prefix", expr.callee);

  if (text.kind !== "String" || prefix.kind !== "String") {
    throw new RuntimeError("str.starts_with expects string arguments");
  }

  return { kind: "Bool", value: text.value.startsWith(prefix.value) };
}

function builtinStrEndsWith(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.ends_with"), env, runtime);
  const text = expectValue(values, "text", expr.callee);
  const suffix = expectValue(values, "suffix", expr.callee);

  if (text.kind !== "String" || suffix.kind !== "String") {
    throw new RuntimeError("str.ends_with expects string arguments");
  }

  return { kind: "Bool", value: text.value.endsWith(suffix.value) };
}

function builtinStrTrim(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.trim"), env, runtime);
  const text = expectValue(values, "text", expr.callee);

  if (text.kind !== "String") {
    throw new RuntimeError("str.trim expects a string argument");
  }

  return { kind: "String", value: text.value.trim() };
}

function builtinStrToUpper(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.to_upper"), env, runtime);
  const text = expectValue(values, "text", expr.callee);

  if (text.kind !== "String") {
    throw new RuntimeError("str.to_upper expects a string argument");
  }

  return { kind: "String", value: text.value.toUpperCase() };
}

function builtinStrToLower(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.to_lower"), env, runtime);
  const text = expectValue(values, "text", expr.callee);

  if (text.kind !== "String") {
    throw new RuntimeError("str.to_lower expects a string argument");
  }

  return { kind: "String", value: text.value.toLowerCase() };
}

function builtinStrReplace(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.replace"), env, runtime);
  const text = expectValue(values, "text", expr.callee);
  const pattern = expectValue(values, "pattern", expr.callee);
  const replacement = expectValue(values, "replacement", expr.callee);

  if (text.kind !== "String" || pattern.kind !== "String" || replacement.kind !== "String") {
    throw new RuntimeError("str.replace expects string arguments");
  }

  // Replace all occurrences
  return { kind: "String", value: text.value.split(pattern.value).join(replacement.value) };
}

function builtinStrIndexOf(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("str.index_of"), env, runtime);
  const text = expectValue(values, "text", expr.callee);
  const substring = expectValue(values, "substring", expr.callee);

  if (text.kind !== "String" || substring.kind !== "String") {
    throw new RuntimeError("str.index_of expects string arguments");
  }

  const idx = text.value.indexOf(substring.value);
  if (idx === -1) {
    return { kind: "Ctor", name: "None", fields: new Map() };
  }

  const fields = new Map<string, Value>();
  fields.set("value", { kind: "Int", value: idx });
  return { kind: "Ctor", name: "Some", fields };
}

// === New List Builtins ===

function builtinListHead(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.head"), env, runtime);
  const list = expectValue(values, "list", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.head expects a list argument");
  }

  if (list.elements.length === 0) {
    return { kind: "Ctor", name: "None", fields: new Map() };
  }

  const fields = new Map<string, Value>();
  fields.set("value", list.elements[0]!);
  return { kind: "Ctor", name: "Some", fields };
}

function builtinListTail(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.tail"), env, runtime);
  const list = expectValue(values, "list", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.tail expects a list argument");
  }

  return { kind: "List", elements: list.elements.slice(1) };
}

function builtinListTake(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.take"), env, runtime);
  const list = expectValue(values, "list", expr.callee);
  const count = expectValue(values, "count", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.take expects a list as first argument");
  }
  if (count.kind !== "Int") {
    throw new RuntimeError("list.take expects an integer count");
  }

  return { kind: "List", elements: list.elements.slice(0, count.value) };
}

function builtinListDrop(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.drop"), env, runtime);
  const list = expectValue(values, "list", expr.callee);
  const count = expectValue(values, "count", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.drop expects a list as first argument");
  }
  if (count.kind !== "Int") {
    throw new RuntimeError("list.drop expects an integer count");
  }

  return { kind: "List", elements: list.elements.slice(count.value) };
}

function builtinListReverse(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.reverse"), env, runtime);
  const list = expectValue(values, "list", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.reverse expects a list argument");
  }

  return { kind: "List", elements: [...list.elements].reverse() };
}

function builtinListContains(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.contains"), env, runtime);
  const list = expectValue(values, "list", expr.callee);
  const item = expectValue(values, "item", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.contains expects a list as first argument");
  }

  // Deep equality check
  const found = list.elements.some((elem) => valueEquals(elem, item));
  return { kind: "Bool", value: found };
}

function builtinListFind(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const paramNames = getBuiltinParamNames("list.find");
  const { alignment, values } = bindCallArguments(expr, paramNames, env, runtime, { skip: ["predicate"] });
  const list = expectValue(values, "list", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.find expects a list as first argument");
  }

  const predicateArg = getArgumentByName(alignment, paramNames, "predicate");
  if (!predicateArg || predicateArg.expr.kind !== "VarRef") {
    throw new RuntimeError("list.find expects a function as second argument");
  }

  const fn = resolveFunctionReference(predicateArg.expr.name, runtime, "list.find");
  if (fn.params.length !== 1) {
    throw new RuntimeError("list.find expects a predicate that takes exactly one argument");
  }

  for (const elem of list.elements) {
    const callEnv: Env = new Map();
    callEnv.set(fn.params[0]!.name, elem);
    const result = evalBlock(fn.body!, callEnv, runtime);
    const boolVal = result.type === "return" ? result.value : result.value;
    if (boolVal.kind === "Bool" && boolVal.value) {
      const fields = new Map<string, Value>();
      fields.set("value", elem);
      return { kind: "Ctor", name: "Some", fields };
    }
  }

  return { kind: "Ctor", name: "None", fields: new Map() };
}

function builtinListFlatMap(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const paramNames = getBuiltinParamNames("list.flat_map");
  const { alignment, values } = bindCallArguments(expr, paramNames, env, runtime, { skip: ["mapper"] });
  const list = expectValue(values, "list", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.flat_map expects a list as first argument");
  }

  const mapperArg = getArgumentByName(alignment, paramNames, "mapper");
  if (!mapperArg || mapperArg.expr.kind !== "VarRef") {
    throw new RuntimeError("list.flat_map expects a function as second argument");
  }

  const fn = resolveFunctionReference(mapperArg.expr.name, runtime, "list.flat_map");
  if (fn.params.length !== 1) {
    throw new RuntimeError("list.flat_map expects a function that takes exactly one argument");
  }

  const result: Value[] = [];
  for (const elem of list.elements) {
    const callEnv: Env = new Map();
    callEnv.set(fn.params[0]!.name, elem);
    const mappedResult = evalBlock(fn.body!, callEnv, runtime);
    const mappedVal = mappedResult.type === "return" ? mappedResult.value : mappedResult.value;
    if (mappedVal.kind !== "List") {
      throw new RuntimeError("list.flat_map mapper must return a list");
    }
    result.push(...mappedVal.elements);
  }

  return { kind: "List", elements: result };
}

function builtinListZip(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.zip"), env, runtime);
  const left = expectValue(values, "left", expr.callee);
  const right = expectValue(values, "right", expr.callee);

  if (left.kind !== "List" || right.kind !== "List") {
    throw new RuntimeError("list.zip expects two list arguments");
  }

  const minLen = Math.min(left.elements.length, right.elements.length);
  const result: Value[] = [];
  for (let i = 0; i < minLen; i++) {
    const fields = new Map<string, Value>();
    fields.set("first", left.elements[i]!);
    fields.set("second", right.elements[i]!);
    result.push({ kind: "Ctor", name: "Pair", fields });
  }

  return { kind: "List", elements: result };
}

function builtinListEnumerate(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.enumerate"), env, runtime);
  const list = expectValue(values, "list", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.enumerate expects a list argument");
  }

  const result: Value[] = list.elements.map((elem, idx) => {
    const fields = new Map<string, Value>();
    fields.set("index", { kind: "Int", value: idx });
    fields.set("value", elem);
    return { kind: "Ctor", name: "Indexed", fields } as Value;
  });

  return { kind: "List", elements: result };
}

function builtinMathAbs(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("math.abs"), env, runtime);
  const value = expectValue(values, "value", expr.callee);
  if (value.kind !== "Int") {
    throw new RuntimeError("math.abs expects an integer argument");
  }
  return { kind: "Int", value: Math.abs(value.value) };
}

function builtinMathMin(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("math.min"), env, runtime);
  const left = expectValue(values, "left", expr.callee);
  const right = expectValue(values, "right", expr.callee);

  if (left.kind !== "Int" || right.kind !== "Int") {
    throw new RuntimeError("math.min expects integer arguments");
  }
  return { kind: "Int", value: Math.min(left.value, right.value) };
}

function builtinMathMax(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("math.max"), env, runtime);
  const left = expectValue(values, "left", expr.callee);
  const right = expectValue(values, "right", expr.callee);

  if (left.kind !== "Int" || right.kind !== "Int") {
    throw new RuntimeError("math.max expects integer arguments");
  }
  return { kind: "Int", value: Math.max(left.value, right.value) };
}

function ensurePureFunction(fn: ast.FnDecl, context: string): void {
  if (fn.effects.length > 0) {
    const effectList = fn.effects.join(", ");
    throw new RuntimeError(
      `'${context}' requires a pure function argument, but '${fn.name}' declares effects [${effectList}]`,
    );
  }
}

function builtinListMap(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const paramNames = getBuiltinParamNames("list.map");
  const { alignment, values } = bindCallArguments(expr, paramNames, env, runtime, { skip: ["mapper"] });
  const list = expectValue(values, "list", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.map expects a list as first argument");
  }

  const mapperArg = getArgumentByName(alignment, paramNames, "mapper");
  if (!mapperArg || mapperArg.expr.kind !== "VarRef") {
    throw new RuntimeError("list.map expects a function as second argument");
  }

  const fn = resolveFunctionReference(mapperArg.expr.name, runtime, "list.map");
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
  const paramNames = getBuiltinParamNames("list.filter");
  const { alignment, values } = bindCallArguments(expr, paramNames, env, runtime, { skip: ["predicate"] });
  const list = expectValue(values, "list", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.filter expects a list as first argument");
  }

  const predicateArg = getArgumentByName(alignment, paramNames, "predicate");
  if (!predicateArg || predicateArg.expr.kind !== "VarRef") {
    throw new RuntimeError("list.filter expects a function as second argument");
  }

  const fn = resolveFunctionReference(predicateArg.expr.name, runtime, "list.filter");
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
  const paramNames = getBuiltinParamNames("list.fold");
  const { alignment, values } = bindCallArguments(expr, paramNames, env, runtime, { skip: ["reducer"] });
  const list = expectValue(values, "list", expr.callee);
  const initial = expectValue(values, "initial", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("list.fold expects a list as first argument");
  }

  const reducerArg = getArgumentByName(alignment, paramNames, "reducer");
  if (!reducerArg || reducerArg.expr.kind !== "VarRef") {
    throw new RuntimeError("list.fold expects a function as third argument");
  }

  const fn = resolveFunctionReference(reducerArg.expr.name, runtime, "list.fold");
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

function builtinParallelMap(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const paramNames = getBuiltinParamNames("parallel_map");
  const { alignment, values } = bindCallArguments(expr, paramNames, env, runtime, { skip: ["mapper"] });
  const list = expectValue(values, "list", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("parallel_map expects a list as first argument");
  }

  const mapperArg = getArgumentByName(alignment, paramNames, "mapper");
  if (!mapperArg || mapperArg.expr.kind !== "VarRef") {
    throw new RuntimeError("parallel_map expects a function as second argument");
  }

  const fn = resolveFunctionReference(mapperArg.expr.name, runtime, "parallel_map");
  ensurePureFunction(fn, "parallel_map");
  if (fn.params.length !== 1) {
    throw new RuntimeError("parallel_map expects a function that takes exactly one argument");
  }

  const mapped = list.elements.map((element) => {
    const callEnv: Env = new Map();
    callEnv.set(fn.params[0]!.name, element);
    const result = evalBlock(fn.body, callEnv, runtime);
    return result.value;
  });

  return { kind: "List", elements: mapped };
}

function builtinParallelFold(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const paramNames = getBuiltinParamNames("parallel_fold");
  const { alignment, values } = bindCallArguments(expr, paramNames, env, runtime, { skip: ["reducer"] });
  const list = expectValue(values, "list", expr.callee);
  const initial = expectValue(values, "initial", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("parallel_fold expects a list as first argument");
  }

  const reducerArg = getArgumentByName(alignment, paramNames, "reducer");
  if (!reducerArg || reducerArg.expr.kind !== "VarRef") {
    throw new RuntimeError("parallel_fold expects a function as third argument");
  }

  const fn = resolveFunctionReference(reducerArg.expr.name, runtime, "parallel_fold");
  ensurePureFunction(fn, "parallel_fold");
  if (fn.params.length !== 2) {
    throw new RuntimeError("parallel_fold expects a function that takes exactly two arguments");
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

function builtinParallelForEach(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const paramNames = getBuiltinParamNames("parallel_for_each");
  const { alignment, values } = bindCallArguments(expr, paramNames, env, runtime, { skip: ["action"] });
  const list = expectValue(values, "list", expr.callee);

  if (list.kind !== "List") {
    throw new RuntimeError("parallel_for_each expects a list as first argument");
  }

  const actionArg = getArgumentByName(alignment, paramNames, "action");
  if (!actionArg || actionArg.expr.kind !== "VarRef") {
    throw new RuntimeError("parallel_for_each expects a function as second argument");
  }

  const fn = resolveFunctionReference(actionArg.expr.name, runtime, "parallel_for_each");
  ensurePureFunction(fn, "parallel_for_each");
  if (fn.params.length !== 1) {
    throw new RuntimeError("parallel_for_each expects a function that takes exactly one argument");
  }

  for (const element of list.elements) {
    const callEnv: Env = new Map();
    callEnv.set(fn.params[0]!.name, element);
    const result = evalBlock(fn.body, callEnv, runtime);
    if (result.value.kind !== "Unit") {
      throw new RuntimeError("parallel_for_each action must return unit");
    }
  }

  return { kind: "Unit" };
}

function builtinLog(level: "debug" | "trace", expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames(`Log.${level}`), env, runtime);
  const label = expectValue(values, "label", expr.callee);
  const payload = expectValue(values, "payload", expr.callee);

  if (label.kind !== "String") {
    throw new RuntimeError(`Log.${level} expects the first argument to be a string label`);
  }

  if (payload.kind !== "Ctor") {
    throw new RuntimeError(`Log.${level} expects the payload to be a record value`);
  }

  const payloadPretty = prettyValue(payload);

  if (runtime.outputFormat === "json" && runtime.logs) {
    const log = createLog(level, label.value, payloadPretty as Record<string, any>);
    runtime.logs.push(log);
  } else {
    const serializedPayload = JSON.stringify(payloadPretty);
    // eslint-disable-next-line no-console
    console.log(`[Log.${level}] ${label.value} ${serializedPayload}`);
  }

  return { kind: "Unit" };
}

function builtinJsonEncode(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("json.encode"), env, runtime);
  const value = expectValue(values, "value", expr.callee);
  return { kind: "String", value: JSON.stringify(valueToJsValue(value)) };
}

function builtinJsonDecode(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("json.decode"), env, runtime);
  const text = expectValue(values, "text", expr.callee);
  if (text.kind !== "String") {
    throw new RuntimeError("json.decode expects a string argument");
  }
  try {
    const parsed = JSON.parse(text.value);
    return jsValueToValue(parsed);
  } catch (error) {
    throw new RuntimeError(`json.decode failed: ${(error as Error).message}`);
  }
}

function builtinConcurrentFlush(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  bindCallArguments(expr, getBuiltinParamNames("Concurrent.flush"), env, runtime);
  const processed = processActorDeliveries(runtime);
  return { kind: "Int", value: processed };
}

function builtinConcurrentStep(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  bindCallArguments(expr, getBuiltinParamNames("Concurrent.step"), env, runtime);
  const processed = processActorDeliveries(runtime, 1);
  return makeBool(processed > 0);
}

function builtinConcurrentStop(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("Concurrent.stop"), env, runtime);
  const actorValue = expectValue(values, "actor", expr.callee);
  if (actorValue.kind !== "ActorRef") {
    throw new RuntimeError("Concurrent.stop expects an ActorRef argument");
  }
  const stopped = stopActor(runtime, actorValue.id);
  return makeBool(stopped);
}

function resolveFunctionReference(name: string, runtime: Runtime, context: string): ast.FnDecl {
  let resolvedName = name;
  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("../loader");
    resolvedName = resolveIdentifier(name, runtime.module, runtime.symbolTable);
  }
  const fn = runtime.functions.get(resolvedName);
  if (!fn) {
    throw new RuntimeError(`Unknown function '${name}' in ${context}`);
  }
  return fn;
}

function callUserFunction(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const actorSendResult = tryCallActorSend(expr, env, runtime);
  if (actorSendResult !== null) {
    return actorSendResult;
  }

  const actorSpecial = tryCallActorFunction(expr, env, runtime);
  if (actorSpecial !== null) {
    return actorSpecial;
  }

  let calleeName = expr.callee;

  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("../loader");
    calleeName = resolveIdentifier(expr.callee, runtime.module, runtime.symbolTable);
  }

  const fn = runtime.functions.get(calleeName);
  if (!fn) {
    throw new RuntimeError(`Unknown function '${expr.callee}'`);
  }
  const paramNames = fn.params.map((param) => param.name);
  const { values } = bindCallArguments(expr, paramNames, env, runtime);

  const callEnv: Env = new Map();
  for (const param of fn.params) {
    const value = expectValue(values, param.name, expr.callee);
    callEnv.set(param.name, value);
  }

  const result = evalBlock(fn.body, callEnv, runtime);
  return result.value;
}

function tryCallActorSend(expr: ast.CallExpr, env: Env, runtime: Runtime): Value | null {
  if (runtime.functions.has(expr.callee)) {
    return null;
  }

  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("../loader");
    const resolved = resolveIdentifier(expr.callee, runtime.module, runtime.symbolTable);
    if (runtime.functions.has(resolved)) {
      return null;
    }
  }

  const targetName = resolveActorSendTarget(expr.callee);
  if (!targetName) {
    return null;
  }

  const actorValue = env.get(targetName);
  if (!actorValue) {
    return null;
  }
  if (actorValue.kind !== "ActorRef") {
    throw new RuntimeError(`'${targetName}.send' expects an ActorRef but found ${actorValue.kind}`);
  }

  const instance = runtime.actorInstances.get(actorValue.id);
  if (!instance) {
    throw new RuntimeError(`Actor instance ${actorValue.id} is not running`);
  }

  const evaluated = bindCallArguments(expr, ["message"], env, runtime);
  if (evaluated.alignment.issues.length > 0) {
    const message = describeCallArgIssue(expr.callee, evaluated.alignment.issues[0]!);
    throw new RuntimeError(message);
  }

  const messageValue = expectValue(evaluated.values, "message", expr.callee);
  if (messageValue.kind !== "Ctor") {
    throw new RuntimeError(`Messages sent with '${expr.callee}' must be constructor values`);
  }

  const handler = instance.decl.handlers.find((candidate) => candidate.msgTypeName === messageValue.name);
  if (!handler) {
    throw new RuntimeError(`Actor '${instance.decl.name}' has no handler for message '${messageValue.name}'`);
  }

  const args = prepareActorHandlerArgs(handler, messageValue);
  instance.send(handler.msgTypeName, args);
  return { kind: "Unit" };
}

function resolveActorSendTarget(callee: string): string | null {
  if (!callee.endsWith(".send")) {
    return null;
  }
  const prefix = callee.slice(0, -".send".length);
  if (!prefix || prefix.includes(".")) {
    return null;
  }
  return prefix;
}

function tryCallActorFunction(expr: ast.CallExpr, env: Env, runtime: Runtime): Value | null {
  const spawnTarget = resolveActorSpawn(expr.callee, runtime);
  if (spawnTarget) {
    return executeActorSpawn(spawnTarget.actorName, expr, env, runtime);
  }

  const handlerTarget = resolveActorHandler(expr.callee, runtime);
  if (handlerTarget) {
    return executeActorHandler(handlerTarget.actorName, handlerTarget.handlerName, expr, env, runtime);
  }

  return null;
}

type ActorSpawnResolution = { actorName: string };
type ActorHandlerResolution = { actorName: string; handlerName: string };

function resolveActorSpawn(callee: string, runtime: Runtime): ActorSpawnResolution | null {
  if (!callee.endsWith(".spawn")) {
    return null;
  }
  const actorPart = callee.slice(0, -".spawn".length);
  if (!actorPart) {
    return null;
  }
  const actorName = resolveActorIdentifier(actorPart, runtime);
  if (!actorName) {
    return null;
  }
  return { actorName };
}

function resolveActorHandler(callee: string, runtime: Runtime): ActorHandlerResolution | null {
  const lastDot = callee.lastIndexOf(".");
  if (lastDot === -1) {
    return null;
  }
  const actorPart = callee.slice(0, lastDot);
  const handlerName = callee.slice(lastDot + 1);
  if (!actorPart || !handlerName || handlerName === "spawn") {
    return null;
  }
  const actorName = resolveActorIdentifier(actorPart, runtime);
  if (!actorName) {
    return null;
  }
  return { actorName, handlerName };
}

function resolveActorIdentifier(name: string, runtime: Runtime): string | null {
  if (runtime.actors.has(name)) {
    return name;
  }
  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("../loader");
    const resolved = resolveIdentifier(name, runtime.module, runtime.symbolTable);
    if (runtime.actors.has(resolved)) {
      return resolved;
    }
  }
  return null;
}

function executeActorSpawn(
  actorName: string,
  expr: ast.CallExpr,
  env: Env,
  runtime: Runtime,
): Value {
  const actorDecl = runtime.actors.get(actorName);
  if (!actorDecl) {
    throw new RuntimeError(`Unknown actor '${actorName}'`);
  }

  const paramNames = actorDecl.params.map((param) => param.name);
  const evaluated = bindCallArguments(expr, paramNames, env, runtime);
  if (evaluated.alignment.issues.length > 0) {
    const message = describeCallArgIssue(expr.callee, evaluated.alignment.issues[0]!);
    throw new RuntimeError(message);
  }

  const values = new Map<string, Value>();
  for (const param of actorDecl.params) {
    const value = expectValue(evaluated.values, param.name, expr.callee);
    values.set(param.name, value);
  }

  const id = runtime.nextActorId;
  runtime.nextActorId += 1;
  const supervisorId = runtime.currentActorStack.length > 0
    ? runtime.currentActorStack[runtime.currentActorStack.length - 1]!
    : null;
  const instance = new ActorInstance(id, actorDecl, values, runtime, evalBlock, supervisorId);
  runtime.actorInstances.set(id, instance);
  registerActorSupervision(runtime, id, supervisorId);
  return makeActorRefValue(id);
}

function executeActorHandler(
  actorName: string,
  handlerName: string,
  expr: ast.CallExpr,
  env: Env,
  runtime: Runtime,
): Value {
  const actorDecl = runtime.actors.get(actorName);
  if (!actorDecl) {
    throw new RuntimeError(`Unknown actor '${actorName}'`);
  }
  const handler = actorDecl.handlers.find((candidate) => candidate.msgTypeName === handlerName);
  if (!handler) {
    throw new RuntimeError(`Actor '${actorDecl.name}' has no handler named '${handlerName}'`);
  }

  const paramNames = ["actor", ...handler.msgParams.map((param) => param.name)];
  const evaluated = bindCallArguments(expr, paramNames, env, runtime);
  if (evaluated.alignment.issues.length > 0) {
    const message = describeCallArgIssue(expr.callee, evaluated.alignment.issues[0]!);
    throw new RuntimeError(message);
  }

  const actorValue = expectValue(evaluated.values, "actor", expr.callee);
  if (actorValue.kind !== "ActorRef") {
    throw new RuntimeError(`First argument to '${expr.callee}' must be an ActorRef`);
  }

  const instance = runtime.actorInstances.get(actorValue.id);
  if (!instance) {
    throw new RuntimeError(`Actor instance ${actorValue.id} is not running`);
  }

  const messageArgs = new Map<string, Value>();
  for (const param of handler.msgParams) {
    const value = expectValue(evaluated.values, param.name, expr.callee);
    messageArgs.set(param.name, value);
  }

  return instance.deliverMessage(handler.msgTypeName, messageArgs);
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

export function enforceContractClauses(
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
