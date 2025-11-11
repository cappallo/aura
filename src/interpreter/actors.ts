import * as ast from "../ast";
import { RuntimeError } from "./errors";
import { Runtime, Value, ActorMessage, Env, EvalResult } from "./types";
import { defaultValueForType } from "./values";

/** Function type for evaluating blocks (injected to avoid circular dependency) */
export type BlockEvaluator = (block: ast.Block, env: Env, runtime: Runtime) => EvalResult;

/** Internal type for actor message delivery scheduling */
type PendingActorDelivery = {
  actorId: number;
};

/**
 * Actor instance with state, mailbox, and message handlers.
 * Actors process messages asynchronously with isolated mutable state.
 */
export class ActorInstance {
  /** Unique actor ID */
  id: number;
  /** Actor declaration from AST */
  decl: ast.ActorDecl;
  /** Immutable constructor parameters */
  initParams: Map<string, Value>;
  /** Mutable state fields */
  state: Map<string, Value>;
  /** Queued messages waiting to be processed */
  mailbox: ActorMessage[];
  /** Runtime context */
  runtime: Runtime;
  /** Block evaluator function (injected) */
  private evaluateBlock: BlockEvaluator;

  constructor(
    id: number,
    decl: ast.ActorDecl,
    initParams: Map<string, Value>,
    runtime: Runtime,
    evaluateBlock: BlockEvaluator,
  ) {
    this.id = id;
    this.decl = decl;
    this.initParams = initParams;
    this.state = new Map();
    this.mailbox = [];
    this.runtime = runtime;
    this.evaluateBlock = evaluateBlock;

    for (const field of decl.stateFields) {
      this.state.set(field.name, defaultValueForType(field.type, runtime));
    }
  }

  /** Send message to this actor (queues for asynchronous delivery) */
  send(msgType: string, args: Map<string, Value>): void {
    this.mailbox.push({ msgType, args });
    scheduleActorDelivery(this.runtime, this.id);
  }

  /** Deliver and process message immediately (synchronous) */
  deliverMessage(msgType: string, args: Map<string, Value>): Value {
    const message: ActorMessage = { msgType, args };
    return this.processMessage(message);
  }

  /** Process next message from mailbox if available */
  processNextQueuedMessage(): boolean {
    const msg = this.mailbox.shift();
    if (!msg) {
      return false;
    }
    this.processMessage(msg);
    return true;
  }

  private processMessage(msg: ActorMessage): Value {
    const handler = this.decl.handlers.find((h) => h.msgTypeName === msg.msgType);
    if (!handler) {
      throw new RuntimeError(
        `Actor '${this.decl.name}' has no handler for message type '${msg.msgType}'`,
      );
    }

    const env = new Map<string, Value>();

    for (const [key, value] of this.initParams.entries()) {
      env.set(key, value);
    }

    for (const [key, value] of this.state.entries()) {
      env.set(key, value);
    }

    for (const [key, value] of msg.args.entries()) {
      env.set(key, value);
    }

    const result = this.evaluateBlock(handler.body, env, this.runtime);

    for (const field of this.decl.stateFields) {
      const updatedValue = env.get(field.name);
      if (updatedValue !== undefined) {
        this.state.set(field.name, updatedValue);
      }
    }

    return result.value;
  }
}

/**
 * Schedule actor message delivery.
 * In immediate mode, processes deliveries immediately.
 * In deterministic mode, queues for later processing.
 */
export function scheduleActorDelivery(runtime: Runtime, actorId: number): void {
  runtime.pendingActorDeliveries.push({ actorId });
  if (runtime.schedulerMode === "immediate") {
    processActorDeliveries(runtime);
  }
}

/**
 * Process pending actor message deliveries.
 * Processes up to `limit` messages (all if limit is undefined).
 * Returns number of messages processed.
 * Re-entrance guard prevents nested processing.
 */
export function processActorDeliveries(runtime: Runtime, limit?: number): number {
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
