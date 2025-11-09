# Concurrency Model Specification for the LLM-Native Language

This document defines the recommended concurrency model to be implemented in the language runtime and core libraries. The design is centered on:

- **Typed actors** as the units of mutable state and concurrency.
- **Structured async tasks** inside actors for concurrent work and I/O.
- **Pure data-parallel primitives** for CPU-bound parallelism.
- **Explicit effects** for all concurrency and I/O.

The goal is to provide a model that is safe, testable, and easy for an LLM to reason about and use correctly.

---

## 1. Design Goals

1. **No shared mutable state across concurrent units.**  
   All mutable state must belong to a single actor.

2. **Local reasoning inside an actor.**  
   Code that handles a message within an actor must be logically single-threaded and sequential.

3. **Explicit concurrency and effects.**  
   All concurrency (actors, tasks, parallel operations) must be visible in types or function signatures.

4. **Deterministic, reproducible testing.**  
   The runtime must support deterministic scheduling and structured traces to replay and debug concurrent behavior.

5. **Small, orthogonal primitives.**  
   Prefer a small set of composable concurrency primitives over many ad-hoc features.

---

## 2. Actors

### 2.1 Overview

- An **actor** is the fundamental unit of:
  - Mutable state
  - Message handling
  - Concurrency control

- Each actor:
  - Owns its state exclusively.
  - Processes one message at a time.
  - Interacts with other actors only via messages.

### 2.2 Properties

- **Single-threaded semantics inside an actor**
  - At most one message handler runs at a time per actor.
  - There is no concurrent mutation of an actor’s state.

- **Private state**
  - Actor state is not directly accessible from outside.
  - State can only be observed or modified via message handlers.

- **Typed handlers**
  - Each actor declares the set of message types it can handle.
  - Handlers are statically associated with message types.

### 2.3 Example (pseudo-syntax)

```text
actor ChatRoom(id: RoomId) {
  state {
    users: Map<UserId, UserHandle>
    history: List<Message>
  }

  on Join(user: UserHandle) -> Effect<Concurrent, JoinResult> {
    // handle join request
  }

  on SendMessage(from: UserId, text: String) -> Effect<Concurrent, Unit> {
    // handle new message
  }
}
````

---

## 3. Messages and Protocols

### 3.1 Typed messages

* Messages must be strongly typed.
* Each actor declares the complete set of message types it accepts.

Example:

```text
enum ChatRoomMsg {
  Join(user: UserHandle)
  Leave(userId: UserId)
  SendMessage(from: UserId, text: String)
  Heartbeat
}
```

### 3.2 Protocols (optional but recommended)

* Actors can define **protocol states** (e.g., `Initial`, `Active`, `Closed`).
* Certain messages may only be valid in certain states.
* This can be encoded in types (e.g., via phantom types, sum types, or dedicated protocol constructs).

Goal: make message validity and ordering constraints explicit and machine-checkable where possible.

---

## 4. Structured Async Tasks Inside Actors

### 4.1 Concept

* Within a message handler, an actor may:

  * Perform synchronous operations.
  * Spawn **async tasks** for concurrent work.
  * Await results in a structured way (task trees).

* Async tasks are **scoped**:

  * Tasks belong to the actor and to a specific logical scope (e.g., per request).
  * When the scope ends, tasks must either complete or be cancelled.

### 4.2 Requirements

* No global, unstructured “fire-and-forget” tasks.

  * Every spawned task is:

    * Awaited, or
    * Attached to a supervised scope that controls its lifetime.

* Cancellation and errors:

  * If a parent scope fails or is cancelled, child tasks are also cancelled.
  * Errors in child tasks must be propagated or handled explicitly.

### 4.3 Example (pseudo-syntax)

```text
on SendMessage(from: UserId, text: String) -> Effect<Concurrent, Unit> {
  let msg = Message { from, text, ts: now() }
  history = history.append(msg)

  async_group {
    for (uid, handle) in users {
      async {
        handle.send(NewMessage(msg))
      }
    }
  }

  return ()
}
```

* `async_group { ... }`:

  * Spawns child tasks.
  * Waits for all of them to complete or fail.
  * Ensures no tasks leak beyond the group’s scope.

---

## 5. Data-Parallel Primitives (Pure Parallelism)

### 5.1 Goals

* Provide parallelism for CPU-bound work without exposing concurrency primitives.
* Restrict these operations to **pure functions** to avoid data races and side effects.

### 5.2 Core primitives

At minimum:

* `parallel_map(f, collection) -> collection'`
* `parallel_fold(f, init, collection) -> result`
* `parallel_for_each(f, collection) -> Unit`

Constraints:

* `f` must be pure: no side effects, no dependence on external mutable state.

Example:

```text
fn compute_scores(users: List<User>) -> List<Score> {
  return parallel_map(score_user, users)
}
```

---

## 6. Effects and Type System Integration

### 6.1 Concurrency as an effect

* Concurrency must be reflected in function signatures via an effect type (or equivalent mechanism), e.g.:

```text
fn spawn_room(id: RoomId) -> Effect<Concurrent, ChatRoomHandle>
```

* Pure functions must not be able to:

  * Spawn actors.
  * Create tasks.
  * Perform I/O.

### 6.2 Common effects

Suggested built-in effects (names are illustrative):

* `Pure` (implicit for functions with no effects)
* `IO`
* `Concurrent`
* Possibly more fine-grained (e.g., `Timer`, `Random`, `Database`) if needed.

---

## 7. Supervision and Lifetimes

### 7.1 Supervision trees

* Actors are arranged in a **supervision hierarchy**:

  * A supervisor actor is responsible for starting, stopping, and restarting its child actors.
  * Failures in a child actor are reported to its supervisor.

### 7.2 Requirements

* When a supervisor terminates, its children must be:

  * Stopped, or
  * Transferred to a new supervisor via an explicit mechanism.

* The runtime should provide:

  * Common strategies (restart on failure, stop on failure, etc.).
  * A way to configure per-child or per-group policies.

---

## 8. Deterministic Testing and Debugging

### 8.1 Deterministic scheduler for tests

* The runtime must expose a **deterministic scheduling mode** for tests:

  * Message deliveries and task scheduling should follow a reproducible strategy.
  * Tests must be able to:

    * Step through message queues in a defined order.
    * Inject messages and observe resulting state.

### 8.2 Structured traces

* On failure (e.g., assertion failure, unexpected exception), the runtime should emit a structured trace including:

  * Actor identifiers.
  * Message types and payload summaries.
  * Timestamps or logical sequence numbers.
  * Task hierarchy (actor → handler → async tasks).

* The trace format should be machine-readable (e.g., JSON) and compact enough to be passed back to an LLM.

Example schema (informal):

```text
{
  "error": "...",
  "actors": [
    {
      "id": "ChatRoom(123)",
      "events": [
        {"seq": 1, "type": "Received", "message": "Join(...)"},
        {"seq": 2, "type": "Sent", "to": "UserSession(42)", "message": "Joined(...)"},
        ...
      ]
    }
  ]
}
```

---

## 9. Forbidden / Discouraged Features

To preserve safety and LLM-friendliness, **do not** provide:

* Raw shared-memory threads as a first-class API.
* User-level locks, mutexes, or condition variables as the primary synchronization mechanism.
* Unstructured “fire-and-forget” tasks that are not tied to a scope.
* Implicit global mutable state accessible from multiple actors concurrently.

These may be allowed in low-level, explicitly marked “unsafe” modules for expert use, but must not form the default concurrency model.

---

## 10. Summary

Implement the concurrency model with the following pillars:

1. **Actors**

   * Single-threaded, own their state, communicate only via typed messages.

2. **Structured async**

   * Scoped task trees inside actors, with explicit lifetime and cancellation.

3. **Pure data-parallel primitives**

   * For CPU-bound parallelism on pure functions.

4. **Effects**

   * All concurrency and I/O exposed as explicit effects in function signatures.

5. **Supervision + deterministic testing**

   * Supervision trees for robustness, deterministic scheduler and structured traces for testing and debugging.

This model should form the foundation of the language’s concurrency semantics and standard library.