import * as ast from "../ast";
import { RuntimeError } from "./errors";
import {
  ActorMessage,
  Env,
  EvalResult,
  PendingActorDelivery,
  Runtime,
  Value,
} from "./types";
import { defaultValueForType } from "./values";

export type EvaluateBlock = (block: ast.Block, env: Env, runtime: Runtime) => EvalResult;

export class ActorInstance {
  readonly id: number;
  readonly decl: ast.ActorDecl;
  readonly initParams: Map<string, Value>;
  readonly state: Map<string, Value>;
  readonly mailbox: ActorMessage[];
  readonly runtime: Runtime;
  private readonly evaluateBlock: EvaluateBlock;

  constructor(
    id: number,
    decl: ast.ActorDecl,
    initParams: Map<string, Value>,
    runtime: Runtime,
    evaluateBlock: EvaluateBlock,
  ) {
    this.id = id;
    this.decl = decl;
    this.initParams = initParams;
    this.state = new Map();
    this.mailbox = [];
    this.runtime = runtime;
    this.evaluateBlock = evaluateBlock;

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
    const handler = this.decl.handlers.find((h) => h.msgTypeName === msg.msgType);
    if (!handler) {
      throw new RuntimeError(
        `Actor '${this.decl.name}' has no handler for message type '${msg.msgType}'`,
      );
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
    const result = this.evaluateBlock(handler.body, env, this.runtime);

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

export function scheduleActorDelivery(runtime: Runtime, actorId: number): void {
  runtime.pendingActorDeliveries.push({ actorId });
  if (runtime.schedulerMode === "immediate") {
    processActorDeliveries(runtime);
  }
}

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
