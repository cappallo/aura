/**
 * Utilities for type checking function calls.
 * Handles effect checking and call argument validation.
 */

import * as ast from "../ast";
import { alignCallArguments, CallArgIssue } from "../callargs";
import { makeError, TypeCheckError } from "./types";

/**
 * Verify that caller has all effects required by callee.
 * Reports errors for missing effects.
 */
export function verifyEffectSubset(
  calleeEffects: Set<string>,
  callerEffects: string[],
  calleeName: string,
  callerName: string,
  errors: TypeCheckError[],
): void {
  if (calleeEffects.size === 0) {
    return;
  }
  const callerEffectSet = new Set(callerEffects);
  for (const effect of calleeEffects) {
    if (!callerEffectSet.has(effect)) {
      errors.push({
        message: `Function '${callerName}' cannot call '${calleeName}' because it is missing effect '${effect}'`,
      });
    }
  }
}

/**
 * Report call argument alignment issues as type errors.
 * Handles too many args, unknown parameters, duplicates, and missing required parameters.
 */
export function reportCallArgIssues(
  expr: ast.CallExpr,
  callee: string,
  issues: CallArgIssue[],
  errors: TypeCheckError[],
  filePath?: string,
): void {
  for (const issue of issues) {
    switch (issue.kind) {
      case "TooManyArguments":
        errors.push(makeError(`Call to '${callee}' has too many arguments`, issue.arg.expr.loc, filePath));
        break;
      case "UnknownParameter":
        errors.push(makeError(
          `Call to '${callee}' has no parameter named '${issue.name}'`,
          issue.arg.expr.loc,
          filePath,
        ));
        break;
      case "DuplicateParameter":
        errors.push(makeError(
          `Parameter '${issue.name}' is provided multiple times in call to '${callee}'`,
          issue.arg.expr.loc,
          filePath,
        ));
        break;
      case "MissingParameter":
        errors.push(makeError(
          `Call to '${callee}' is missing an argument for parameter '${issue.name}'`,
          expr.loc,
          filePath,
        ));
        break;
      case "PositionalAfterNamed":
        errors.push(makeError(
          `Positional arguments must appear before named arguments when calling '${callee}'`,
          issue.arg.expr.loc,
          filePath,
        ));
        break;
      default:
        break;
    }
  }
}

export function getAlignedArgument(
  alignment: ReturnType<typeof alignCallArguments>,
  paramNames: string[],
  name: string,
): ast.CallArg | null {
  const index = paramNames.indexOf(name);
  if (index === -1) {
    return null;
  }
  return alignment.ordered[index] ?? null;
}
