import fs from "fs";
import path from "path";
import * as ast from "./ast";
import { parseActiveComments, ActiveComments } from "./ast";

type GeneratedParser = {
  parse(input: string, options?: { grammarSource?: string }): ast.Module;
};

let cachedParser: GeneratedParser | null = null;

function loadParser(): GeneratedParser {
  if (!cachedParser) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedParser = require("./parser.generated") as GeneratedParser;
  }
  return cachedParser;
}

const DEFAULT_SOURCE_NAME = "<input>";

/**
 * Post-process parsed AST to populate activeComments from docComment strings.
 */
function populateActiveComments(module: ast.Module): ast.Module {
  // Process module-level docComment
  if (module.docComment) {
    const parsed = parseActiveComments(module.docComment);
    if (parsed) {
      module.activeComments = parsed;
    }
  }

  // Process all declarations
  for (const decl of module.decls) {
    if ("docComment" in decl && decl.docComment) {
      const parsed = parseActiveComments(decl.docComment);
      if (parsed) {
        (decl as { activeComments?: ActiveComments }).activeComments = parsed;
      }
    }
  }

  return module;
}

export function parseModule(code: string, filePath?: string): ast.Module {
  const parser = loadParser();
  const sourceName = filePath ?? DEFAULT_SOURCE_NAME;
  try {
    const module = parser.parse(code, { grammarSource: sourceName });
    return populateActiveComments(module);
  } catch (err) {
    throw formatParserError(err, sourceName, code);
  }
}

export function parseModuleFromFile(filePath: string): ast.Module {
  const absolute = path.resolve(filePath);
  const contents = fs.readFileSync(absolute, "utf8");
  return parseModule(contents, absolute);
}

type PeggySyntaxError = Error & {
  location?: {
    source?: string;
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  format?: (sources: Array<{ source: string; text: string }>) => string;
};

function isPeggySyntaxError(err: unknown): err is PeggySyntaxError {
  return Boolean(
    err &&
      typeof err === "object" &&
      "location" in err &&
      "message" in err
  );
}

function formatParserError(err: unknown, sourceName: string, code: string): Error {
  if (isPeggySyntaxError(err)) {
    if (typeof err.format === "function") {
      const formatted = err.format([{ source: sourceName, text: code }]);
      return new Error(formatted);
    }
    const location = err.location;
    if (location) {
      const { start, end } = location;
      const lines = code.split(/\r?\n/);
      const lineText = lines[start.line - 1] ?? "";
      const caretSpacing = " ".repeat(Math.max(start.column - 1, 0));
      const caretLength =
        start.line === end.line
          ? Math.max(end.column - start.column, 1)
          : 1;
      const caret = caretSpacing + "^".repeat(caretLength);
      const header = `${sourceName}:${start.line}:${start.column}`;
      const message = `${header}: ${err.message}\n${lineText}\n${caret}`;
      return new Error(message);
    }
  }

  const fallbackMessage =
    err instanceof Error ? err.message : String(err);
  return new Error(`${sourceName}: ${fallbackMessage}`);
}
