// Structured error and log types for JSON serialization (LLM consumption)

import { SourceLocation } from "./ast";

/**
 * Structured error type that can be serialized to JSON.
 * Follows THOUGHTS.md §2.2 design for machine-readable errors.
 */
export type StructuredError = {
  kind: "error";
  errorType: string; // e.g., "TypeMismatch", "UnknownVariable", "EffectViolation"
  message: string; // Human-readable message
  location?: ErrorLocation;
  hint?: string; // Optional suggestion for fixing the error
  context?: Record<string, any>; // Additional contextual information
};

/**
 * Location information for errors, supporting both file paths and in-memory sources.
 */
export type ErrorLocation = {
  file?: string; // File path if available
  moduleName?: string[]; // Module name like ["app", "user"]
  line: number;
  column: number;
  snippet?: string; // Optional code snippet showing the error location
};

/**
 * Structured log entry that can be serialized to JSON.
 * Follows THOUGHTS.md §5.1 design for deterministic, machine-readable logs.
 */
export type StructuredLog = {
  kind: "log";
  level: "trace" | "debug" | "info" | "warn" | "error";
  timestamp?: string; // ISO8601 timestamp (optional for deterministic mode)
  message: string; // Log message/event name
  data?: Record<string, any>; // Structured data payload
  location?: ErrorLocation; // Where in code the log originated
};

/**
 * Structured trace entry for execution tracing.
 * Used for explain/debug functionality per THOUGHTS.md §5.2.
 */
export type StructuredTrace = {
  kind: "trace";
  stepType: "call" | "return" | "let" | "expr" | "match";
  description: string;
  value?: any; // The computed value (if applicable)
  location?: ErrorLocation;
  depth: number; // Nesting depth for visualization
};

/**
 * Output format for structured CLI output.
 */
export type StructuredOutput = {
  status: "success" | "error";
  errors?: StructuredError[];
  logs?: StructuredLog[];
  traces?: StructuredTrace[];
  result?: any; // Function execution result (if applicable)
};

/**
 * Helper to convert SourceLocation from parser to ErrorLocation.
 */
export function sourceLocationToErrorLocation(
  loc: SourceLocation | undefined,
  file?: string,
  moduleName?: string[]
): ErrorLocation | undefined {
  if (!loc) return undefined;
  const result: ErrorLocation = {
    line: loc.start.line,
    column: loc.start.column,
  };
  if (file !== undefined) result.file = file;
  if (moduleName !== undefined) result.moduleName = moduleName;
  return result;
}

/**
 * Format a structured output as JSON string.
 */
export function formatStructuredOutput(output: StructuredOutput): string {
  return JSON.stringify(output, null, 2);
}

/**
 * Create a structured error from simple string message.
 */
export function createError(
  errorType: string,
  message: string,
  location?: ErrorLocation,
  hint?: string,
  context?: Record<string, any>
): StructuredError {
  const error: StructuredError = {
    kind: "error",
    errorType,
    message,
  };
  if (location !== undefined) error.location = location;
  if (hint !== undefined) error.hint = hint;
  if (context !== undefined) error.context = context;
  return error;
}

/**
 * Create a structured log entry.
 */
export function createLog(
  level: "trace" | "debug" | "info" | "warn" | "error",
  message: string,
  data?: Record<string, any>,
  location?: ErrorLocation,
  timestamp?: string
): StructuredLog {
  const log: StructuredLog = {
    kind: "log",
    level,
    message,
  };
  if (data !== undefined) log.data = data;
  if (location !== undefined) log.location = location;
  if (timestamp !== undefined) log.timestamp = timestamp;
  return log;
}
