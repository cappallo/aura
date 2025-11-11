import * as ast from "../ast";
import type { StructuredLog } from "../structured";
import type { StructuredTrace } from "../structured";
import type { Value } from "./values";

export type SchedulerMode = "immediate" | "deterministic";

export type ActorMessage = {
  msgType: string;
  args: Map<string, Value>;
};

export type RuntimeOptions = {
  schedulerMode?: SchedulerMode;
  seed?: number;
};

export type FnContract = {
  requires: ast.Expr[];
  ensures: ast.Expr[];
};

export type Env = Map<string, Value>;

export type EvalResult =
  | { type: "value"; value: Value }
  | { type: "return"; value: Value };

export type AsyncTask = {
  env: Env;
  stmts: ast.Stmt[];
  nextIndex: number;
  completed: boolean;
  cancelled: boolean;
};

export type AsyncGroupContext = {
  tasks: AsyncTask[];
};

export type TestOutcome = {
  kind: "test" | "property";
  name: string;
  success: boolean;
  error?: unknown;
};

export class SeededRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed === 0 ? 1 : seed >>> 0;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }
}

export type PendingActorDelivery = {
  actorId: number;
};

export interface ActorInstance {
  id: number;
  decl: ast.ActorDecl;
  send(msgType: string, args: Map<string, Value>): void;
  deliverMessage(msgType: string, args: Map<string, Value>): Value;
  processNextQueuedMessage(): boolean;
}

export type Runtime = {
  module: ast.Module;
  functions: Map<string, ast.FnDecl>;
  contracts: Map<string, FnContract>;
  tests: ast.TestDecl[];
  properties: ast.PropertyDecl[];
  typeDecls: Map<string, ast.TypeDecl>;
  actors: Map<string, ast.ActorDecl>;
  actorInstances: Map<number, ActorInstance>;
  nextActorId: number;
  schedulerMode: SchedulerMode;
  pendingActorDeliveries: PendingActorDelivery[];
  isProcessingActorMessages: boolean;
  symbolTable?: import("../loader").SymbolTable;
  outputFormat?: "text" | "json";
  logs?: StructuredLog[];
  traces?: StructuredTrace[];
  tracing?: boolean;
  traceDepth?: number;
  rng: SeededRNG | null;
};

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}
