import * as ast from "./ast";
import { alignCallArguments, CallArgIssue } from "./callargs";
import {
  ActorMessage,
  AsyncGroupContext,
  AsyncTask,
  Env,
  EvalResult,
  FnContract,
  PendingActorDelivery,
  Runtime,
  RuntimeError,
  RuntimeOptions,
  SchedulerMode,
  SeededRNG,
  TestOutcome,
} from "./interpreter/context";
import { PropertyEvaluationHelpers, defaultValueForType, runProperty } from "./interpreter/properties";
import {
  Value,
  jsValueToValue,
  makeActorRefValue,
  makeCtor,
  prettyValue,
  valueEquals,
  valueToJsValue,
} from "./interpreter/values";

type MatchEnv = Env;

export type { Value } from "./interpreter/values";
export {
  prettyValue,
  valueEquals,
  makeCtor,
  makeActorRefValue,
  valueToJsValue,
  jsValueToValue,
} from "./interpreter/values";
export { RuntimeError, SeededRNG } from "./interpreter/context";
export type { SchedulerMode, RuntimeOptions, Runtime, TestOutcome, ActorMessage } from "./interpreter/context";
export { defaultValueForType } from "./interpreter/properties";

export class ActorInstance {
  id: number;
  decl: ast.ActorDecl;
  initParams: Map<string, Value>;
  state: Map<string, Value>;
  mailbox: ActorMessage[];
  runtime: Runtime;

  constructor(
    id: number,
    decl: ast.ActorDecl,
    initParams: Map<string, Value>,
    runtime: Runtime
  ) {
    this.id = id;
    this.decl = decl;
    this.initParams = initParams;
    this.state = new Map();
    this.mailbox = [];
    this.runtime = runtime;
    
    // Initialize state fields to default values
    for (const field of decl.stateFields) {
      this.state.set(field.name, defaultValueForType(field.type, runtime));
    }
  }

  send(msgType: string, args: Map<string, Value>): void {
    this.mailbox.push({ msgType, args });
    scheduleActorDelivery(this.runtime, this.id);
  }

  deliverMessage(msgType: string, args: Map<string, Value>): Value {
    const message: ActorMessage = { msgType, args };
    return this.processMessage(message);
  }

  processNextQueuedMessage(): boolean {
    const msg = this.mailbox.shift();
    if (!msg) {
      return false;
    }
    this.processMessage(msg);
    return true;
  }

  private processMessage(msg: ActorMessage): Value {
    // Find the handler for this message type
    const handler = this.decl.handlers.find(h => h.msgTypeName === msg.msgType);
    if (!handler) {
      throw new RuntimeError(`Actor '${this.decl.name}' has no handler for message type '${msg.msgType}'`);
    }

    // Build environment with init params, state fields, and message params
    const env = new Map<string, Value>();
    
    // Add init params
    for (const [key, value] of this.initParams.entries()) {
      env.set(key, value);
    }
    
    // Add state fields
    for (const [key, value] of this.state.entries()) {
      env.set(key, value);
    }
    
    // Add message params
    for (const [key, value] of msg.args.entries()) {
      env.set(key, value);
    }

    // Execute handler body
    const result = evalBlock(handler.body, env, this.runtime);
    
    // Update state after handler execution (state mutations should be captured)
    // For now, we assume state fields can be reassigned in the handler
    for (const field of this.decl.stateFields) {
      const updatedValue = env.get(field.name);
      if (updatedValue !== undefined) {
        this.state.set(field.name, updatedValue);
      }
    }

    return result.value;
  }
}

const BUILTIN_PARAM_NAMES: Record<string, string[]> = {
  "list.len": ["list"],
  "test.assert_equal": ["expected", "actual"],
  assert: ["condition"],
  "str.concat": ["left", "right"],
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
};

function getBuiltinParamNames(name: string): string[] {
  const names = BUILTIN_PARAM_NAMES[name];
  if (!names) {
    throw new RuntimeError(`Internal error: missing parameter metadata for builtin '${name}'`);
  }
  return names;
}

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
  modules: import("./loader").ResolvedModule[],
  symbolTable: import("./loader").SymbolTable,
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

function scheduleActorDelivery(runtime: Runtime, actorId: number): void {
  runtime.pendingActorDeliveries.push({ actorId });
  if (runtime.schedulerMode === "immediate") {
    processActorDeliveries(runtime);
  }
}

function processActorDeliveries(runtime: Runtime, limit?: number): number {
  if (runtime.isProcessingActorMessages) {
    return 0;
  }
  runtime.isProcessingActorMessages = true;
  let processed = 0;
  try {
    while (runtime.pendingActorDeliveries.length > 0) {
      const entry = runtime.pendingActorDeliveries.shift();
      if (!entry) {
        break;
      }
      const instance = runtime.actorInstances.get(entry.actorId);
      if (!instance) {
        continue;
      }
      const delivered = instance.processNextQueuedMessage();
      if (!delivered) {
        continue;
      }
      processed += 1;
      if (limit !== undefined && processed >= limit) {
        break;
      }
    }
  } finally {
    runtime.isProcessingActorMessages = false;
  }

  if (limit !== undefined && processed >= limit) {
    return processed;
  }

  if (runtime.pendingActorDeliveries.length > 0) {
    processed += processActorDeliveries(runtime, limit);
  }

  return processed;
}

export function runTests(runtime: Runtime): TestOutcome[] {
  const outcomes: TestOutcome[] = [];

  const propertyHelpers: PropertyEvaluationHelpers = {
    evalBlock,
    evalExpr,
  };

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
    outcomes.push(runProperty(property, runtime, propertyHelpers));
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
    case "__negate":
      return builtinNegate(expr, env, runtime);
    case "__not":
      return builtinNot(expr, env, runtime);
    default:
      return callUserFunction(expr, env, runtime);
  }
}

type BoundCallArguments = {
  alignment: ReturnType<typeof alignCallArguments>;
  values: Map<string, Value>;
};

function bindCallArguments(
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

function describeCallArgIssue(callee: string, issue: CallArgIssue): string {
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

function expectValue(values: Map<string, Value>, name: string, callee: string): Value {
  const value = values.get(name);
  if (value === undefined) {
    throw new RuntimeError(`Call to '${callee}' is missing argument '${name}'`);
  }
  return value;
}

function getArgumentByName(
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

function resolveFunctionReference(name: string, runtime: Runtime, context: string): ast.FnDecl {
  let resolvedName = name;
  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("./loader");
    resolvedName = resolveIdentifier(name, runtime.module, runtime.symbolTable);
  }
  const fn = runtime.functions.get(resolvedName);
  if (!fn) {
    throw new RuntimeError(`Unknown function '${name}' in ${context}`);
  }
  return fn;
}

function builtinLength(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("list.len"), env, runtime);
  const listValue = expectValue(values, "list", expr.callee);
  if (listValue.kind !== "List") {
    throw new RuntimeError("length expects a list argument");
  }
  return { kind: "Int", value: listValue.elements.length };
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
  if (condition.kind !== "Bool") {
    throw new RuntimeError("assert expects a boolean argument");
  }
  if (!condition.value) {
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

function builtinLog(level: "debug" | "trace", expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const paramNames = getBuiltinParamNames(level === "debug" ? "Log.debug" : "Log.trace");
  const { values } = bindCallArguments(expr, paramNames, env, runtime);
  const labelValue = expectValue(values, "label", expr.callee);
  const payloadValue = expectValue(values, "payload", expr.callee);
  if (labelValue.kind !== "String") {
    throw new RuntimeError(`Log.${level} expects the first argument to be a string label`);
  }
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

// String operations
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

// Math operations
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

// List operations
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

function ensurePureFunction(fn: ast.FnDecl, context: string): void {
  if (fn.effects.length > 0) {
    const effectList = fn.effects.join(", ");
    throw new RuntimeError(
      `'${context}' requires a pure function argument, but '${fn.name}' declares effects [${effectList}]`,
    );
  }
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
    evalBlock(fn.body, callEnv, runtime);
  }

  return { kind: "Unit" };
}

function builtinJsonEncode(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("json.encode"), env, runtime);
  const value = expectValue(values, "value", expr.callee);
  const jsValue = valueToJsValue(value);
  const jsonString = JSON.stringify(jsValue);
  
  return { kind: "String", value: jsonString };
}

function builtinJsonDecode(expr: ast.CallExpr, env: Env, runtime: Runtime): Value {
  const { values } = bindCallArguments(expr, getBuiltinParamNames("json.decode"), env, runtime);
  const jsonStringValue = expectValue(values, "text", expr.callee);
  if (jsonStringValue.kind !== "String") {
    throw new RuntimeError("json.decode expects a string argument");
  }
  
  try {
    const jsValue = JSON.parse(jsonStringValue.value);
    return jsValueToValue(jsValue);
  } catch (error) {
    throw new RuntimeError(
      `json.decode failed: ${error instanceof Error ? error.message : String(error)}`
    );
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
  
  // Resolve identifier if we have a symbol table
  if (runtime.symbolTable) {
    const { resolveIdentifier } = require("./loader");
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
    const { resolveIdentifier } = require("./loader");
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

  const args = buildActorMessageArgs(handler, messageValue);
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

function buildActorMessageArgs(handler: ast.ActorHandler, message: Value): Map<string, Value> {
  if (message.kind !== "Ctor") {
    throw new RuntimeError("Actor messages must be constructor values");
  }
  const args = new Map<string, Value>();
  if (handler.msgParams.length === 0) {
    return args;
  }

  if (shouldBindWholeMessage(handler)) {
    const param = handler.msgParams[0]!;
    args.set(param.name, message);
    return args;
  }

  for (const param of handler.msgParams) {
    const fieldValue = message.fields.get(param.name);
    if (fieldValue === undefined) {
      throw new RuntimeError(
        `Message '${message.name}' is missing field '${param.name}' required by handler 'on ${handler.msgTypeName}'`,
      );
    }
    args.set(param.name, fieldValue);
  }
  return args;
}

function shouldBindWholeMessage(handler: ast.ActorHandler): boolean {
  if (handler.msgParams.length !== 1) {
    return false;
  }
  const param = handler.msgParams[0]!;
  if (param.type.kind !== "TypeName") {
    return false;
  }
  return param.type.name === handler.msgTypeName && param.type.typeArgs.length === 0;
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
    const { resolveIdentifier } = require("./loader");
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
  const instance = new ActorInstance(id, actorDecl, values, runtime);
  runtime.actorInstances.set(id, instance);
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
