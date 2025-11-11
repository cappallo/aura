/**
 * Call argument alignment utilities.
 * Handles mixed positional and named arguments.
 */

import * as ast from "./ast";

/** Issues that can occur when aligning call arguments to parameters */
export type CallArgIssue =
  | { kind: "TooManyArguments"; arg: ast.CallArg }
  | { kind: "UnknownParameter"; arg: ast.CallArg; name: string }
  | { kind: "DuplicateParameter"; arg: ast.CallArg; name: string }
  | { kind: "MissingParameter"; name: string }
  | { kind: "PositionalAfterNamed"; arg: ast.CallArg };

/** Result of aligning call arguments to parameter positions */
export type CallArgAlignment = {
  /** Arguments in parameter order, null for missing */
  ordered: (ast.CallArg | null)[];
  /** Detected issues */
  issues: CallArgIssue[];
};

/**
 * Align call arguments to parameter positions.
 * Supports mixed positional and named arguments.
 * Positional args must come before named args.
 */
export function alignCallArguments(expr: ast.CallExpr, paramNames: string[]): CallArgAlignment {
  const ordered: (ast.CallArg | null)[] = paramNames.map(() => null);
  const issues: CallArgIssue[] = [];
  let positionalIndex = 0;
  let seenNamedArg = false;

  for (const arg of expr.args) {
    if (arg.kind === "PositionalArg") {
      if (seenNamedArg) {
        issues.push({ kind: "PositionalAfterNamed", arg });
        continue;
      }
      if (positionalIndex >= paramNames.length) {
        issues.push({ kind: "TooManyArguments", arg });
        continue;
      }
      ordered[positionalIndex] = arg;
      positionalIndex += 1;
      continue;
    }

    seenNamedArg = true;
    const targetIndex = paramNames.indexOf(arg.name);
    if (targetIndex === -1) {
      issues.push({ kind: "UnknownParameter", arg, name: arg.name });
      continue;
    }
    if (ordered[targetIndex]) {
      issues.push({ kind: "DuplicateParameter", arg, name: arg.name });
      continue;
    }
    ordered[targetIndex] = arg;
  }

  for (let i = 0; i < paramNames.length; i += 1) {
    if (!ordered[i]) {
      issues.push({ kind: "MissingParameter", name: paramNames[i]! });
    }
  }

  return { ordered, issues };
}
