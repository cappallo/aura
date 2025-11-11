import * as ast from "../ast";
import { RuntimeError } from "./errors";
import { Runtime, Value, ActorMessage, Env, EvalResult } from "./types";
import { defaultValueForType, makeActorRefValue, makeCtor, valueEquals } from "./values";

/** Function type for evaluating blocks (injected to avoid circular dependency) */
export type BlockEvaluator = (block: ast.Block, env: Env, runtime: Runtime) => EvalResult;

/** Internal type for actor message delivery scheduling */
type PendingActorDelivery = {
  actorId: number;
};

type MessageDeliveryKind = "async" | "sync";

type ActorFailureDetails = {
  actorId: number;
  actorName: string;
  handlerName: string;
  reason: string;
};

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

export function prepareActorHandlerArgs(handler: ast.ActorHandler, message: Value): Map<string, Value> {
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
  /** Supervisor actor ID (null when rooted at system) */
  supervisorId: number | null;
  /** Whether the actor has been terminated */
  terminated: boolean;
  /** Block evaluator function (injected) */
  private evaluateBlock: BlockEvaluator;

  constructor(
    id: number,
    decl: ast.ActorDecl,
    initParams: Map<string, Value>,
    runtime: Runtime,
    evaluateBlock: BlockEvaluator,
    supervisorId: number | null,
  ) {
    this.id = id;
    this.decl = decl;
    this.initParams = initParams;
    this.state = new Map();
    this.mailbox = [];
    this.runtime = runtime;
    this.evaluateBlock = evaluateBlock;
    this.supervisorId = supervisorId;
    this.terminated = false;

    for (const field of decl.stateFields) {
      this.state.set(field.name, defaultValueForType(field.type, runtime));
    }
  }

  /** Send message to this actor (queues for asynchronous delivery) */
  send(msgType: string, args: Map<string, Value>): void {
    if (this.terminated) {
      return;
    }
    this.mailbox.push({ msgType, args });
    scheduleActorDelivery(this.runtime, this.id);
  }

  /** Deliver and process message immediately (synchronous) */
  deliverMessage(msgType: string, args: Map<string, Value>): Value {
    if (this.terminated) {
      throw new RuntimeError(`Actor '${this.decl.name}' is not running`);
    }
    const message: ActorMessage = { msgType, args };
    return this.processMessage(message, "sync");
  }

  /** Process next message from mailbox if available */
  processNextQueuedMessage(): boolean {
    if (this.terminated) {
      this.mailbox = [];
      return false;
    }
    const msg = this.mailbox.shift();
    if (!msg) {
      return false;
    }
    this.processMessage(msg, "async");
    return true;
  }

  markTerminated(): void {
    this.terminated = true;
    this.mailbox = [];
  }

  private processMessage(msg: ActorMessage, deliveryKind: MessageDeliveryKind): Value {
    const handler = this.decl.handlers.find((h) => h.msgTypeName === msg.msgType);
    if (!handler) {
      throw new RuntimeError(
        `Actor '${this.decl.name}' has no handler for message type '${msg.msgType}'`,
      );
    }

    const env = new Map<string, Value>();
    const originalState = new Map(this.state);

    for (const [key, value] of this.initParams.entries()) {
      env.set(key, value);
    }

    for (const [key, value] of this.state.entries()) {
      env.set(key, value);
    }

    for (const [key, value] of msg.args.entries()) {
      env.set(key, value);
    }

    this.runtime.currentActorStack.push(this.id);
    try {
      const result = this.evaluateBlock(handler.body, env, this.runtime);

      for (const field of this.decl.stateFields) {
        const updatedValue = env.get(field.name);
        if (updatedValue === undefined) {
          continue;
        }
        const currentValue = this.state.get(field.name);
        const originalValue = originalState.get(field.name);
        if (
          originalValue !== undefined &&
          currentValue !== undefined &&
          !valueEquals(currentValue, originalValue)
        ) {
          continue;
        }
        this.state.set(field.name, updatedValue);
      }
      return result.value;
    } catch (error) {
      const runtimeError = toRuntimeError(error);
      const handled = handleActorFailure(this, handler, msg, runtimeError);
      if (deliveryKind === "sync" || !handled) {
        throw new RuntimeError(
          `Actor '${this.decl.name}' failed while handling '${msg.msgType}': ${runtimeError.message}`,
        );
      }
      return { kind: "Unit" };
    } finally {
      this.runtime.currentActorStack.pop();
    }
  }
}

/**
 * Schedule actor message delivery.
 * In immediate mode, processes deliveries immediately.
 * In deterministic mode, queues for later processing.
 */
export function scheduleActorDelivery(runtime: Runtime, actorId: number): void {
  const instance = runtime.actorInstances.get(actorId);
  if (!instance || instance.terminated) {
    return;
  }
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
      if (!instance || instance.terminated) {
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

function toRuntimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) {
    return error;
  }
  if (error instanceof Error) {
    return new RuntimeError(error.message);
  }
  return new RuntimeError(String(error));
}

function handleActorFailure(
  instance: ActorInstance,
  handler: ast.ActorHandler,
  msg: ActorMessage,
  error: RuntimeError,
): boolean {
  const { runtime } = instance;
  const node = runtime.actorSupervision.get(instance.id);
  const supervisorId = node ? node.parentId : instance.supervisorId;
  const failure: ActorFailureDetails = {
    actorId: instance.id,
    actorName: instance.decl.name,
    handlerName: handler.msgTypeName,
    reason: error.message,
  };

  destroyActorSubtree(runtime, instance.id);

  return notifySupervisorChain(runtime, supervisorId, failure);
}

function destroyActorSubtree(runtime: Runtime, actorId: number): void {
  const instance = runtime.actorInstances.get(actorId);
  if (instance) {
    instance.markTerminated();
    runtime.actorInstances.delete(actorId);
  }

  const node = runtime.actorSupervision.get(actorId);
  if (!node) {
    return;
  }

  runtime.actorSupervision.delete(actorId);

  if (node.parentId !== null) {
    const parentNode = runtime.actorSupervision.get(node.parentId);
    parentNode?.children.delete(actorId);
  }

  const childIds = Array.from(node.children);
  for (const childId of childIds) {
    destroyActorSubtree(runtime, childId);
  }
}

function notifySupervisorChain(
  runtime: Runtime,
  supervisorId: number | null,
  failure: ActorFailureDetails,
): boolean {
  if (supervisorId === null) {
    return false;
  }

  const supervisorInstance = runtime.actorInstances.get(supervisorId);
  const supervisorNode = runtime.actorSupervision.get(supervisorId);
  const nextSupervisor = supervisorNode ? supervisorNode.parentId : null;

  if (!supervisorInstance || supervisorInstance.terminated) {
    return notifySupervisorChain(runtime, nextSupervisor, failure);
  }

  const handler = supervisorInstance.decl.handlers.find((candidate) => candidate.msgTypeName === "ChildFailed");
  if (!handler) {
    return notifySupervisorChain(runtime, nextSupervisor, failure);
  }

  const failureValue = makeCtor("ChildFailed", [
    ["child", makeActorRefValue(failure.actorId)],
    ["reason", { kind: "String", value: failure.reason }],
    ["message", { kind: "String", value: failure.handlerName }],
    ["actor", { kind: "String", value: failure.actorName }],
  ]);

  const args = prepareActorHandlerArgs(handler, failureValue);
  supervisorInstance.send(handler.msgTypeName, args);
  return true;
}

export function registerActorSupervision(
  runtime: Runtime,
  actorId: number,
  supervisorId: number | null,
): void {
  runtime.actorSupervision.set(actorId, { parentId: supervisorId, children: new Set() });
  if (supervisorId !== null) {
    const parentNode = runtime.actorSupervision.get(supervisorId);
    if (parentNode) {
      parentNode.children.add(actorId);
    } else {
      runtime.actorSupervision.set(supervisorId, {
        parentId: null,
        children: new Set([actorId]),
      });
    }
  }
}

export function stopActor(runtime: Runtime, actorId: number): boolean {
  const existed = runtime.actorInstances.has(actorId) || runtime.actorSupervision.has(actorId);
  destroyActorSubtree(runtime, actorId);
  return existed;
}
