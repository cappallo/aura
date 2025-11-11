import * as ast from "../ast";
import { StructuredLog } from "../structured";

export type SchedulerMode = "immediate" | "deterministic";

export type Value =
  | { kind: "Int"; value: number }
  | { kind: "Bool"; value: boolean }
  | { kind: "String"; value: string }
  | { kind: "List"; elements: Value[] }
  | { kind: "Ctor"; name: string; fields: Map<string, Value> }
  | { kind: "ActorRef"; id: number }
  | { kind: "Unit" };

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

export type Runtime = {
  module: ast.Module;
  functions: Map<string, ast.FnDecl>;
  contracts: Map<string, FnContract>;
  tests: ast.TestDecl[];
  properties: ast.PropertyDecl[];
  typeDecls: Map<string, ast.TypeDecl>;
  actors: Map<string, ast.ActorDecl>;
  actorInstances: Map<number, import("./actors").ActorInstance>;
  nextActorId: number;
  schedulerMode: SchedulerMode;
  pendingActorDeliveries: { actorId: number }[];
  isProcessingActorMessages: boolean;
  symbolTable?: import("../loader").SymbolTable;
  outputFormat?: "text" | "json";
  logs?: StructuredLog[];
  traces?: import("../structured").StructuredTrace[];
  tracing?: boolean;
  traceDepth?: number;
  rng: import("./rng").SeededRNG | null;
};

export type Env = Map<string, Value>;

export type EvalResult =
  | { type: "value"; value: Value }
  | { type: "return"; value: Value };

export type TestOutcome = {
  kind: "test" | "property";
  name: string;
  success: boolean;
  error?: unknown;
};
