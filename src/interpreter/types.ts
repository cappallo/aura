import * as ast from "../ast";
import { StructuredLog } from "../structured";

/** Actor message delivery scheduling mode */
export type SchedulerMode = "immediate" | "deterministic";

/** Runtime value representation covering all Lx value types */
export type Value =
  | { kind: "Int"; value: number }
  | { kind: "Bool"; value: boolean }
  | { kind: "String"; value: string }
  | { kind: "List"; elements: Value[] }
  | { kind: "Ctor"; name: string; fields: Map<string, Value> }
  | { kind: "ActorRef"; id: number }
  | { kind: "Unit" };

/** Actor message with type name and named arguments */
export type ActorMessage = {
  msgType: string;
  args: Map<string, Value>;
};

/** Supervision metadata for an actor instance */
export type ActorSupervisionNode = {
  /** Parent actor ID if supervised (null when rooted at system) */
  parentId: number | null;
  /** Child actor IDs supervised by this actor */
  children: Set<number>;
};

/** Configuration options for runtime execution */
export type RuntimeOptions = {
  /** How actor messages are scheduled */
  schedulerMode?: SchedulerMode;
  /** Seed for deterministic property testing */
  seed?: number;
};

/** Parsed function contract with preconditions and postconditions */
export type FnContract = {
  requires: ast.Expr[];
  ensures: ast.Expr[];
};

/** Global runtime context containing all declarations and execution state */
export type Runtime = {
  /** Module being executed */
  module: ast.Module;
  /** All function declarations indexed by name */
  functions: Map<string, ast.FnDecl>;
  /** Function contracts indexed by function name */
  contracts: Map<string, FnContract>;
  /** All test declarations */
  tests: ast.TestDecl[];
  /** All property test declarations */
  properties: ast.PropertyDecl[];
  /** All type declarations */
  typeDecls: Map<string, ast.TypeDecl>;
  /** All actor declarations indexed by name */
  actors: Map<string, ast.ActorDecl>;
  /** Running actor instances indexed by ID */
  actorInstances: Map<number, import("./actors").ActorInstance>;
  /** Counter for generating unique actor IDs */
  nextActorId: number;
  /** Supervision tree structure for all actors */
  actorSupervision: Map<number, ActorSupervisionNode>;
  /** Message delivery scheduling mode */
  schedulerMode: SchedulerMode;
  /** Queue of pending actor message deliveries */
  pendingActorDeliveries: { actorId: number }[];
  /** Flag to prevent re-entrant message processing */
  isProcessingActorMessages: boolean;
  /** Stack of currently executing actor IDs (for supervision context) */
  currentActorStack: number[];
  /** Symbol table for multi-module execution */
  symbolTable?: import("../loader").SymbolTable;
  /** Output format for structured logging */
  outputFormat?: "text" | "json";
  /** Accumulated structured logs */
  logs?: StructuredLog[];
  /** Accumulated execution traces */
  traces?: import("../structured").StructuredTrace[];
  /** Whether tracing is enabled */
  tracing?: boolean;
  /** Current trace nesting depth */
  traceDepth?: number;
  /** Seeded RNG for deterministic testing */
  rng: import("./rng").SeededRNG | null;
};

/** Environment mapping variable names to runtime values */
export type Env = Map<string, Value>;

/** Result of evaluating a block or statement */
export type EvalResult =
  | { type: "value"; value: Value }
  | { type: "return"; value: Value };

/** Outcome of running a test or property */
export type TestOutcome = {
  kind: "test" | "property";
  name: string;
  success: boolean;
  error?: unknown;
};
