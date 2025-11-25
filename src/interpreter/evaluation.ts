import * as ast from "../ast";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as net from "net";
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
  // File I/O builtins
  "io.read_file": ["path"],
  "io.write_file": ["path", "content"],
  "io.file_exists": ["path"],
  "io.read_lines": ["path"],
  "io.append_file": ["path", "content"],
  "io.delete_file": ["path"],
  // System builtins
  "sys.args": [],
  "sys.env": ["name"],
  "sys.cwd": [],
  // Time builtins
  "time.now": [],
  "time.format": ["timestamp", "format"],
  "time.parse": ["date_string", "format"],
  "time.add_seconds": ["timestamp", "seconds"],
  "time.add_minutes": ["timestamp", "minutes"],
  "time.add_hours": ["timestamp", "hours"],
  "time.add_days": ["timestamp", "days"],
  "time.diff_seconds": ["t1", "t2"],
  "time.year": ["timestamp"],
  "time.month": ["timestamp"],
  "time.day": ["timestamp"],
  "time.hour": ["timestamp"],
  "time.minute": ["timestamp"],
  "time.second": ["timestamp"],
  // Random builtins
  "random.int": ["min", "max"],
  "random.bool": [],
  "random.choice": ["list"],
  "random.shuffle": ["list"],
  "random.float": [],
  // HTTP networking builtins
  "http.get": ["url"],
  "http.post": ["url", "body", "content_type"],
  "http.request": ["method", "url", "body", "headers"],
  // TCP socket builtins
  "tcp.connect": ["host", "port"],
  "tcp.send": ["socket", "data"],
  "tcp.receive": ["socket"],
  "tcp.close": ["socket"],
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
    // File I/O builtins
    case "io.read_file":
      return builtinIoReadFile(expr, env, runtime);
    case "io.write_file":
      return builtinIoWriteFile(expr, env, runtime);
    case "io.file_exists":
      return builtinIoFileExists(expr, env, runtime);
    case "io.read_lines":
      return builtinIoReadLines(expr, env, runtime);
    case "io.append_file":
      return builtinIoAppendFile(expr, env, runtime);
    case "io.delete_file":
      return builtinIoDeleteFile(expr, env, runtime);
    // System builtins
    case "sys.args":
      return builtinSysArgs(expr, env, runtime);
    case "sys.env":
      return builtinSysEnv(expr, env, runtime);
    case "sys.cwd":
      return builtinSysCwd(expr, env, runtime);
    // Time builtins
    case "time.now":
      return builtinTimeNow(expr, env, runtime);
    case "time.format":
      return builtinTimeFormat(expr, env, runtime);
    case "time.parse":
      return builtinTimeParse(expr, env, runtime);
    case "time.add_seconds":
      return builtinTimeAddSeconds(expr, env, runtime);
    case "time.add_minutes":
      return builtinTimeAddMinutes(expr, env, runtime);
    case "time.add_hours":
      return builtinTimeAddHours(expr, env, runtime);
    case "time.add_days":
      return builtinTimeAddDays(expr, env, runtime);
    case "time.diff_seconds":
      return builtinTimeDiffSeconds(expr, env, runtime);
    case "time.year":
      return builtinTimeYear(expr, env, runtime);
    case "time.month":
      return builtinTimeMonth(expr, env, runtime);
    case "time.day":
      return builtinTimeDay(expr, env, runtime);
    case "time.hour":
      return builtinTimeHour(expr, env, runtime);
    case "time.minute":
      return builtinTimeMinute(expr, env, runtime);
    case "time.second":
      return builtinTimeSecond(expr, env, runtime);
    // Random builtins
    case "random.int":
      return builtinRandomInt(expr, env, runtime);
    case "random.bool":
      return builtinRandomBool(expr, env, runtime);
    case "random.choice":
      return builtinRandomChoice(expr, env, runtime);
    case "random.shuffle":
      return builtinRandomShuffle(expr, env, runtime);
    case "random.float":
      return builtinRandomFloat(expr, env, runtime);
    // HTTP networking builtins
    case "http.get":
      return builtinHttpGet(expr, env, runtime);
    case "http.post":
      return builtinHttpPost(expr, env, runtime);
    case "http.request":
      return builtinHttpRequest(expr, env, runtime);
    // TCP socket builtins
    case "tcp.connect":
      return builtinTcpConnect(expr, env, runtime);
    case "tcp.send":
      return builtinTcpSend(expr, env, runtime);
    case "tcp.receive":
      return builtinTcpReceive(expr, env, runtime);
    case "tcp.close":
      return builtinTcpClose(expr, env, runtime);
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

// ============================================================================
// File I/O Builtins
// ============================================================================

function builtinIoReadFile(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("io.read_file"), env, runtime);
  const pathValue = expectValue(values, "path", expr.callee);
  if (pathValue.kind !== "String") {
    throw new RuntimeError("io.read_file expects a string path argument");
  }
  try {
    const content = fs.readFileSync(pathValue.value, "utf-8");
    return makeCtor("Some", [["value", { kind: "String", value: content }]]);
  } catch {
    return makeCtor("None");
  }
}

function builtinIoWriteFile(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("io.write_file"), env, runtime);
  const pathValue = expectValue(values, "path", expr.callee);
  const contentValue = expectValue(values, "content", expr.callee);
  if (pathValue.kind !== "String") {
    throw new RuntimeError("io.write_file expects a string path argument");
  }
  if (contentValue.kind !== "String") {
    throw new RuntimeError("io.write_file expects a string content argument");
  }
  try {
    fs.writeFileSync(pathValue.value, contentValue.value, "utf-8");
    return makeBool(true);
  } catch {
    return makeBool(false);
  }
}

function builtinIoFileExists(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("io.file_exists"), env, runtime);
  const pathValue = expectValue(values, "path", expr.callee);
  if (pathValue.kind !== "String") {
    throw new RuntimeError("io.file_exists expects a string path argument");
  }
  return makeBool(fs.existsSync(pathValue.value));
}

function builtinIoReadLines(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("io.read_lines"), env, runtime);
  const pathValue = expectValue(values, "path", expr.callee);
  if (pathValue.kind !== "String") {
    throw new RuntimeError("io.read_lines expects a string path argument");
  }
  try {
    const content = fs.readFileSync(pathValue.value, "utf-8");
    const lines = content.split("\n");
    const lineValues: Value[] = lines.map((line) => ({ kind: "String" as const, value: line }));
    return makeCtor("Some", [["value", { kind: "List", elements: lineValues }]]);
  } catch {
    return makeCtor("None");
  }
}

function builtinIoAppendFile(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("io.append_file"), env, runtime);
  const pathValue = expectValue(values, "path", expr.callee);
  const contentValue = expectValue(values, "content", expr.callee);
  if (pathValue.kind !== "String") {
    throw new RuntimeError("io.append_file expects a string path argument");
  }
  if (contentValue.kind !== "String") {
    throw new RuntimeError("io.append_file expects a string content argument");
  }
  try {
    fs.appendFileSync(pathValue.value, contentValue.value, "utf-8");
    return makeBool(true);
  } catch {
    return makeBool(false);
  }
}

function builtinIoDeleteFile(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("io.delete_file"), env, runtime);
  const pathValue = expectValue(values, "path", expr.callee);
  if (pathValue.kind !== "String") {
    throw new RuntimeError("io.delete_file expects a string path argument");
  }
  try {
    fs.unlinkSync(pathValue.value);
    return makeBool(true);
  } catch {
    return makeBool(false);
  }
}

// ============================================================================
// System Builtins
// ============================================================================

function builtinSysArgs(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  bindCallArguments(expr, getBuiltinParamNames("sys.args"), env, runtime);
  // Skip node executable and script path
  const args = process.argv.slice(2);
  const argValues: Value[] = args.map((arg) => ({ kind: "String" as const, value: arg }));
  return { kind: "List", elements: argValues };
}

function builtinSysEnv(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("sys.env"), env, runtime);
  const nameValue = expectValue(values, "name", expr.callee);
  if (nameValue.kind !== "String") {
    throw new RuntimeError("sys.env expects a string name argument");
  }
  const value = process.env[nameValue.value];
  if (value !== undefined) {
    return makeCtor("Some", [["value", { kind: "String", value }]]);
  }
  return makeCtor("None");
}

function builtinSysCwd(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  bindCallArguments(expr, getBuiltinParamNames("sys.cwd"), env, runtime);
  return { kind: "String", value: process.cwd() };
}

// ============================================================================
// Time Builtins
// ============================================================================

function builtinTimeNow(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  bindCallArguments(expr, getBuiltinParamNames("time.now"), env, runtime);
  return { kind: "Int", value: Date.now() };
}

function builtinTimeFormat(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.format"), env, runtime);
  const timestamp = expectValue(values, "timestamp", expr.callee);
  const format = expectValue(values, "format", expr.callee);
  
  if (timestamp.kind !== "Int") {
    throw new RuntimeError("time.format expects an integer timestamp");
  }
  if (format.kind !== "String") {
    throw new RuntimeError("time.format expects a string format");
  }
  
  const date = new Date(timestamp.value);
  const formatStr = format.value;
  
  // Simple format string substitution
  // Supported: %Y (year), %m (month), %d (day), %H (hour), %M (minute), %S (second)
  const result = formatStr
    .replace(/%Y/g, date.getFullYear().toString())
    .replace(/%m/g, (date.getMonth() + 1).toString().padStart(2, "0"))
    .replace(/%d/g, date.getDate().toString().padStart(2, "0"))
    .replace(/%H/g, date.getHours().toString().padStart(2, "0"))
    .replace(/%M/g, date.getMinutes().toString().padStart(2, "0"))
    .replace(/%S/g, date.getSeconds().toString().padStart(2, "0"));
  
  return { kind: "String", value: result };
}

function builtinTimeParse(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.parse"), env, runtime);
  const dateString = expectValue(values, "date_string", expr.callee);
  const format = expectValue(values, "format", expr.callee);
  
  if (dateString.kind !== "String") {
    throw new RuntimeError("time.parse expects a string date_string");
  }
  if (format.kind !== "String") {
    throw new RuntimeError("time.parse expects a string format");
  }
  
  // Simple ISO date parsing (format parameter guides which parts to extract)
  // For now, we support ISO-8601 format strings
  try {
    const date = new Date(dateString.value);
    if (isNaN(date.getTime())) {
      return makeCtor("None");
    }
    return makeCtor("Some", [["value", { kind: "Int", value: date.getTime() }]]);
  } catch {
    return makeCtor("None");
  }
}

function builtinTimeAddSeconds(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.add_seconds"), env, runtime);
  const timestamp = expectValue(values, "timestamp", expr.callee);
  const seconds = expectValue(values, "seconds", expr.callee);
  
  if (timestamp.kind !== "Int" || seconds.kind !== "Int") {
    throw new RuntimeError("time.add_seconds expects integer arguments");
  }
  
  return { kind: "Int", value: timestamp.value + seconds.value * 1000 };
}

function builtinTimeAddMinutes(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.add_minutes"), env, runtime);
  const timestamp = expectValue(values, "timestamp", expr.callee);
  const minutes = expectValue(values, "minutes", expr.callee);
  
  if (timestamp.kind !== "Int" || minutes.kind !== "Int") {
    throw new RuntimeError("time.add_minutes expects integer arguments");
  }
  
  return { kind: "Int", value: timestamp.value + minutes.value * 60 * 1000 };
}

function builtinTimeAddHours(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.add_hours"), env, runtime);
  const timestamp = expectValue(values, "timestamp", expr.callee);
  const hours = expectValue(values, "hours", expr.callee);
  
  if (timestamp.kind !== "Int" || hours.kind !== "Int") {
    throw new RuntimeError("time.add_hours expects integer arguments");
  }
  
  return { kind: "Int", value: timestamp.value + hours.value * 60 * 60 * 1000 };
}

function builtinTimeAddDays(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.add_days"), env, runtime);
  const timestamp = expectValue(values, "timestamp", expr.callee);
  const days = expectValue(values, "days", expr.callee);
  
  if (timestamp.kind !== "Int" || days.kind !== "Int") {
    throw new RuntimeError("time.add_days expects integer arguments");
  }
  
  return { kind: "Int", value: timestamp.value + days.value * 24 * 60 * 60 * 1000 };
}

function builtinTimeDiffSeconds(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.diff_seconds"), env, runtime);
  const t1 = expectValue(values, "t1", expr.callee);
  const t2 = expectValue(values, "t2", expr.callee);
  
  if (t1.kind !== "Int" || t2.kind !== "Int") {
    throw new RuntimeError("time.diff_seconds expects integer arguments");
  }
  
  return { kind: "Int", value: Math.floor((t2.value - t1.value) / 1000) };
}

function builtinTimeYear(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.year"), env, runtime);
  const timestamp = expectValue(values, "timestamp", expr.callee);
  
  if (timestamp.kind !== "Int") {
    throw new RuntimeError("time.year expects an integer timestamp");
  }
  
  return { kind: "Int", value: new Date(timestamp.value).getFullYear() };
}

function builtinTimeMonth(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.month"), env, runtime);
  const timestamp = expectValue(values, "timestamp", expr.callee);
  
  if (timestamp.kind !== "Int") {
    throw new RuntimeError("time.month expects an integer timestamp");
  }
  
  // Return 1-indexed month (January = 1)
  return { kind: "Int", value: new Date(timestamp.value).getMonth() + 1 };
}

function builtinTimeDay(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.day"), env, runtime);
  const timestamp = expectValue(values, "timestamp", expr.callee);
  
  if (timestamp.kind !== "Int") {
    throw new RuntimeError("time.day expects an integer timestamp");
  }
  
  return { kind: "Int", value: new Date(timestamp.value).getDate() };
}

function builtinTimeHour(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.hour"), env, runtime);
  const timestamp = expectValue(values, "timestamp", expr.callee);
  
  if (timestamp.kind !== "Int") {
    throw new RuntimeError("time.hour expects an integer timestamp");
  }
  
  return { kind: "Int", value: new Date(timestamp.value).getHours() };
}

function builtinTimeMinute(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.minute"), env, runtime);
  const timestamp = expectValue(values, "timestamp", expr.callee);
  
  if (timestamp.kind !== "Int") {
    throw new RuntimeError("time.minute expects an integer timestamp");
  }
  
  return { kind: "Int", value: new Date(timestamp.value).getMinutes() };
}

function builtinTimeSecond(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("time.second"), env, runtime);
  const timestamp = expectValue(values, "timestamp", expr.callee);
  
  if (timestamp.kind !== "Int") {
    throw new RuntimeError("time.second expects an integer timestamp");
  }
  
  return { kind: "Int", value: new Date(timestamp.value).getSeconds() };
}

// ============================================================================
// Random Builtins
// ============================================================================

function builtinRandomInt(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("random.int"), env, runtime);
  const minVal = expectValue(values, "min", expr.callee);
  const maxVal = expectValue(values, "max", expr.callee);
  
  if (minVal.kind !== "Int" || maxVal.kind !== "Int") {
    throw new RuntimeError("random.int expects integer arguments");
  }
  
  const min = minVal.value;
  const max = maxVal.value;
  
  // Use seeded RNG if available, otherwise use Math.random
  if (runtime.rng) {
    const random = runtime.rng.next();
    return { kind: "Int", value: Math.floor(random * (max - min + 1)) + min };
  } else {
    return { kind: "Int", value: Math.floor(Math.random() * (max - min + 1)) + min };
  }
}

function builtinRandomBool(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  bindCallArguments(expr, getBuiltinParamNames("random.bool"), env, runtime);
  
  if (runtime.rng) {
    return { kind: "Bool", value: runtime.rng.next() < 0.5 };
  } else {
    return { kind: "Bool", value: Math.random() < 0.5 };
  }
}

function builtinRandomChoice(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("random.choice"), env, runtime);
  const list = expectValue(values, "list", expr.callee);
  
  if (list.kind !== "List") {
    throw new RuntimeError("random.choice expects a list argument");
  }
  
  if (list.elements.length === 0) {
    return makeCtor("None");
  }
  
  let index: number;
  if (runtime.rng) {
    index = Math.floor(runtime.rng.next() * list.elements.length);
  } else {
    index = Math.floor(Math.random() * list.elements.length);
  }
  
  return makeCtor("Some", [["value", list.elements[index]!]]);
}

function builtinRandomShuffle(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("random.shuffle"), env, runtime);
  const list = expectValue(values, "list", expr.callee);
  
  if (list.kind !== "List") {
    throw new RuntimeError("random.shuffle expects a list argument");
  }
  
  // Fisher-Yates shuffle
  const shuffled = [...list.elements];
  for (let i = shuffled.length - 1; i > 0; i--) {
    let j: number;
    if (runtime.rng) {
      j = Math.floor(runtime.rng.next() * (i + 1));
    } else {
      j = Math.floor(Math.random() * (i + 1));
    }
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  
  return { kind: "List", elements: shuffled };
}

function builtinRandomFloat(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  bindCallArguments(expr, getBuiltinParamNames("random.float"), env, runtime);
  
  // Return as integer * 1000000 since we don't have float type
  // This gives 6 decimal places of precision
  let random: number;
  if (runtime.rng) {
    random = runtime.rng.next();
  } else {
    random = Math.random();
  }
  
  return { kind: "Int", value: Math.floor(random * 1000000) };
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

// ============================================================================
// HTTP Networking Builtins
// ============================================================================

/** Global storage for TCP sockets */
const tcpSockets = new Map<number, net.Socket>();
let nextSocketId = 1;

/** Helper to make an HttpResponse value */
function makeHttpResponse(status: number, body: string, headers: [string, string][]): Value {
  const fields = new Map<string, Value>();
  fields.set("status", makeInt(status));
  fields.set("body", { kind: "String", value: body });
  
  // Convert headers to List<Pair<String, String>>
  const headerPairs: Value[] = headers.map(([key, value]) => {
    const pairFields = new Map<string, Value>();
    pairFields.set("first", { kind: "String", value: key });
    pairFields.set("second", { kind: "String", value: value });
    return { kind: "Ctor" as const, name: "Pair", fields: pairFields };
  });
  fields.set("headers", { kind: "List", elements: headerPairs });
  
  return { kind: "Ctor", name: "HttpResponse", fields };
}

/** Perform a synchronous HTTP request using Node.js http/https modules */
function performHttpRequest(
  method: string,
  url: string,
  body: string | null,
  headers: Record<string, string>
): { status: number; body: string; headers: [string, string][] } | null {
  // Use synchronous execution via child_process.spawnSync with curl
  // This is a workaround since Node.js http is async
  const { spawnSync } = require("child_process");
  
  const args = ["-s", "-i", "-X", method, url];
  
  // Add headers
  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  
  // Add body if present
  if (body && body.length > 0) {
    args.push("-d", body);
  }
  
  try {
    const result = spawnSync("curl", args, {
      encoding: "utf-8",
      timeout: 30000, // 30 second timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB max response
    });
    
    if (result.error || result.status !== 0) {
      return null;
    }
    
    const output = result.stdout as string;
    
    // Parse the response - HTTP header section ends with \r\n\r\n
    const headerBodySplit = output.indexOf("\r\n\r\n");
    if (headerBodySplit === -1) {
      return null;
    }
    
    const headerSection = output.substring(0, headerBodySplit);
    const responseBody = output.substring(headerBodySplit + 4);
    
    // Parse status line and headers
    const headerLines = headerSection.split("\r\n");
    const statusLine = headerLines[0];
    if (!statusLine) {
      return null;
    }
    
    // Parse status code from "HTTP/1.1 200 OK"
    const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
    if (!statusMatch) {
      return null;
    }
    const status = parseInt(statusMatch[1]!, 10);
    
    // Parse headers
    const responseHeaders: [string, string][] = [];
    for (let i = 1; i < headerLines.length; i++) {
      const line = headerLines[i]!;
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        responseHeaders.push([key, value]);
      }
    }
    
    return { status, body: responseBody, headers: responseHeaders };
  } catch {
    return null;
  }
}

function builtinHttpGet(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("http.get"), env, runtime);
  const urlValue = expectValue(values, "url", expr.callee);
  
  if (urlValue.kind !== "String") {
    throw new RuntimeError("http.get expects a string URL argument");
  }
  
  const response = performHttpRequest("GET", urlValue.value, null, {});
  if (response === null) {
    return makeCtor("None");
  }
  
  return makeCtor("Some", [["value", makeHttpResponse(response.status, response.body, response.headers)]]);
}

function builtinHttpPost(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("http.post"), env, runtime);
  const urlValue = expectValue(values, "url", expr.callee);
  const bodyValue = expectValue(values, "body", expr.callee);
  const contentTypeValue = expectValue(values, "content_type", expr.callee);
  
  if (urlValue.kind !== "String") {
    throw new RuntimeError("http.post expects a string URL argument");
  }
  if (bodyValue.kind !== "String") {
    throw new RuntimeError("http.post expects a string body argument");
  }
  if (contentTypeValue.kind !== "String") {
    throw new RuntimeError("http.post expects a string content_type argument");
  }
  
  const headers: Record<string, string> = {
    "Content-Type": contentTypeValue.value,
  };
  
  const response = performHttpRequest("POST", urlValue.value, bodyValue.value, headers);
  if (response === null) {
    return makeCtor("None");
  }
  
  return makeCtor("Some", [["value", makeHttpResponse(response.status, response.body, response.headers)]]);
}

function builtinHttpRequest(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("http.request"), env, runtime);
  const methodValue = expectValue(values, "method", expr.callee);
  const urlValue = expectValue(values, "url", expr.callee);
  const bodyValue = expectValue(values, "body", expr.callee);
  const headersValue = expectValue(values, "headers", expr.callee);
  
  if (methodValue.kind !== "String") {
    throw new RuntimeError("http.request expects a string method argument");
  }
  if (urlValue.kind !== "String") {
    throw new RuntimeError("http.request expects a string URL argument");
  }
  if (bodyValue.kind !== "String") {
    throw new RuntimeError("http.request expects a string body argument");
  }
  if (headersValue.kind !== "List") {
    throw new RuntimeError("http.request expects a list of header pairs");
  }
  
  // Parse headers from List<Pair<String, String>>
  const headers: Record<string, string> = {};
  for (const elem of headersValue.elements) {
    if (elem.kind !== "Ctor" || elem.name !== "Pair") {
      throw new RuntimeError("http.request headers must be Pair<String, String>");
    }
    const first = elem.fields.get("first");
    const second = elem.fields.get("second");
    if (!first || !second || first.kind !== "String" || second.kind !== "String") {
      throw new RuntimeError("http.request headers must be Pair<String, String>");
    }
    headers[first.value] = second.value;
  }
  
  const response = performHttpRequest(
    methodValue.value,
    urlValue.value,
    bodyValue.value.length > 0 ? bodyValue.value : null,
    headers
  );
  
  if (response === null) {
    return makeCtor("None");
  }
  
  return makeCtor("Some", [["value", makeHttpResponse(response.status, response.body, response.headers)]]);
}

// ============================================================================
// TCP Socket Builtins
// ============================================================================

function builtinTcpConnect(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("tcp.connect"), env, runtime);
  const hostValue = expectValue(values, "host", expr.callee);
  const portValue = expectValue(values, "port", expr.callee);
  
  if (hostValue.kind !== "String") {
    throw new RuntimeError("tcp.connect expects a string host argument");
  }
  if (portValue.kind !== "Int") {
    throw new RuntimeError("tcp.connect expects an integer port argument");
  }
  
  // For TCP, we need to do synchronous-ish connection
  // Since Node.js sockets are async, we'll create a socket and store it
  // The socket ID will be stored and used for send/receive/close
  try {
    const socket = new net.Socket();
    const socketId = nextSocketId++;
    
    // Set a flag to track connection state
    let connected = false;
    let connectionError = false;
    
    socket.on("connect", () => {
      connected = true;
    });
    
    socket.on("error", () => {
      connectionError = true;
    });
    
    // Attempt connection (will be async in reality)
    socket.connect(portValue.value, hostValue.value);
    
    // Store the socket
    tcpSockets.set(socketId, socket);
    
    // Create the TcpSocket value
    const fields = new Map<string, Value>();
    fields.set("id", makeInt(socketId));
    fields.set("host", { kind: "String", value: hostValue.value });
    fields.set("port", makeInt(portValue.value));
    
    return makeCtor("Some", [["value", { kind: "Ctor", name: "TcpSocket", fields }]]);
  } catch {
    return makeCtor("None");
  }
}

function builtinTcpSend(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("tcp.send"), env, runtime);
  const socketValue = expectValue(values, "socket", expr.callee);
  const dataValue = expectValue(values, "data", expr.callee);
  
  if (socketValue.kind !== "Ctor" || socketValue.name !== "TcpSocket") {
    throw new RuntimeError("tcp.send expects a TcpSocket argument");
  }
  if (dataValue.kind !== "String") {
    throw new RuntimeError("tcp.send expects a string data argument");
  }
  
  const socketIdValue = socketValue.fields.get("id");
  if (!socketIdValue || socketIdValue.kind !== "Int") {
    throw new RuntimeError("Invalid TcpSocket value");
  }
  
  const socket = tcpSockets.get(socketIdValue.value);
  if (!socket) {
    return makeBool(false);
  }
  
  try {
    socket.write(dataValue.value);
    return makeBool(true);
  } catch {
    return makeBool(false);
  }
}

function builtinTcpReceive(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("tcp.receive"), env, runtime);
  const socketValue = expectValue(values, "socket", expr.callee);
  
  if (socketValue.kind !== "Ctor" || socketValue.name !== "TcpSocket") {
    throw new RuntimeError("tcp.receive expects a TcpSocket argument");
  }
  
  const socketIdValue = socketValue.fields.get("id");
  if (!socketIdValue || socketIdValue.kind !== "Int") {
    throw new RuntimeError("Invalid TcpSocket value");
  }
  
  const socket = tcpSockets.get(socketIdValue.value);
  if (!socket) {
    return makeCtor("None");
  }
  
  // TCP receive is inherently async in Node.js
  // For a synchronous API, we'd need to buffer data
  // For now, we'll return whatever is available in the buffer or None
  try {
    const data = socket.read();
    if (data === null) {
      return makeCtor("None");
    }
    return makeCtor("Some", [["value", { kind: "String", value: data.toString() }]]);
  } catch {
    return makeCtor("None");
  }
}

function builtinTcpClose(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("tcp.close"), env, runtime);
  const socketValue = expectValue(values, "socket", expr.callee);
  
  if (socketValue.kind !== "Ctor" || socketValue.name !== "TcpSocket") {
    throw new RuntimeError("tcp.close expects a TcpSocket argument");
  }
  
  const socketIdValue = socketValue.fields.get("id");
  if (!socketIdValue || socketIdValue.kind !== "Int") {
    throw new RuntimeError("Invalid TcpSocket value");
  }
  
  const socket = tcpSockets.get(socketIdValue.value);
  if (socket) {
    try {
      socket.destroy();
    } catch {
      // Ignore errors on close
    }
    tcpSockets.delete(socketIdValue.value);
  }
  
  return { kind: "Unit" };
}
