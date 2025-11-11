export type Value =
  | { kind: "Int"; value: number }
  | { kind: "Bool"; value: boolean }
  | { kind: "String"; value: string }
  | { kind: "List"; elements: Value[] }
  | { kind: "Ctor"; name: string; fields: Map<string, Value> }
  | { kind: "ActorRef"; id: number }
  | { kind: "Unit" };

export function makeActorRefValue(id: number): Value {
  return { kind: "ActorRef", id };
}

export function makeCtor(name: string, entries?: Iterable<[string, Value]>): Value {
  const fields = new Map<string, Value>();
  if (entries) {
    for (const [fieldName, fieldValue] of entries) {
      fields.set(fieldName, fieldValue);
    }
  }
  return { kind: "Ctor", name, fields };
}

export function valueEquals(a: Value, b: Value): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "Int":
    case "Bool":
    case "String":
      return a.value === (b as typeof a).value;
    case "Unit":
      return true;
    case "List": {
      const bb = b as typeof a;
      if (a.elements.length !== bb.elements.length) {
        return false;
      }
      for (let i = 0; i < a.elements.length; i += 1) {
        const left = a.elements[i];
        const right = bb.elements[i];
        if (left === undefined || right === undefined || !valueEquals(left, right)) {
          return false;
        }
      }
      return true;
    }
    case "Ctor": {
      const bb = b as typeof a;
      if (a.name !== bb.name || a.fields.size !== bb.fields.size) {
        return false;
      }
      for (const [key, val] of a.fields.entries()) {
        const other = bb.fields.get(key);
        if (!other || !valueEquals(val, other)) {
          return false;
        }
      }
      return true;
    }
    case "ActorRef":
      return a.id === (b as typeof a).id;
    default:
      return false;
  }
}

export function prettyValue(value: Value): unknown {
  switch (value.kind) {
    case "Int":
    case "Bool":
    case "String":
      return value.value;
    case "Unit":
      return null;
    case "List":
      return value.elements.map((element) => prettyValue(element));
    case "Ctor": {
      const obj: Record<string, unknown> = {};
      for (const [key, fieldValue] of value.fields.entries()) {
        obj[key] = prettyValue(fieldValue);
      }
      return { [value.name]: obj };
    }
    case "ActorRef":
      return { ActorRef: value.id };
    default:
      return null;
  }
}

export function valueToJsValue(value: Value): unknown {
  switch (value.kind) {
    case "Int":
    case "Bool":
    case "String":
      return value.value;
    case "Unit":
      return null;
    case "List":
      return value.elements.map(valueToJsValue);
    case "Ctor": {
      const obj: Record<string, unknown> = { _constructor: value.name };
      for (const [fieldName, fieldValue] of value.fields.entries()) {
        obj[fieldName] = valueToJsValue(fieldValue);
      }
      return obj;
    }
    case "ActorRef":
      return { ActorRef: value.id };
  }
}

export function jsValueToValue(jsValue: unknown): Value {
  if (jsValue === null || jsValue === undefined) {
    return { kind: "Unit" };
  }
  if (typeof jsValue === "number") {
    return { kind: "Int", value: Math.floor(jsValue) };
  }
  if (typeof jsValue === "boolean") {
    return { kind: "Bool", value: jsValue };
  }
  if (typeof jsValue === "string") {
    return { kind: "String", value: jsValue };
  }
  if (Array.isArray(jsValue)) {
    return { kind: "List", elements: jsValue.map(jsValueToValue) };
  }
  if (typeof jsValue === "object") {
    const obj = jsValue as Record<string, unknown>;
    const constructor = obj._constructor;
    if (typeof constructor === "string") {
      const fields = new Map<string, Value>();
      for (const [key, val] of Object.entries(obj)) {
        if (key !== "_constructor") {
          fields.set(key, jsValueToValue(val));
        }
      }
      return { kind: "Ctor", name: constructor, fields };
    }
    const fields = new Map<string, Value>();
    for (const [key, val] of Object.entries(obj)) {
      fields.set(key, jsValueToValue(val));
    }
    return { kind: "Ctor", name: "Object", fields };
  }
  return { kind: "Unit" };
}
