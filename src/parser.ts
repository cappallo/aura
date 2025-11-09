import fs from "fs";
import path from "path";
import * as ast from "./ast";

type GeneratedParser = {
  parse(input: string): ast.Module;
};

let cachedParser: GeneratedParser | null = null;

function loadParser(): GeneratedParser {
  if (!cachedParser) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedParser = require("./parser.generated") as GeneratedParser;
  }
  return cachedParser;
}

export function parseModule(code: string, filePath?: string): ast.Module {
  const parser = loadParser();
  try {
    return parser.parse(code);
  } catch (err) {
    if (filePath) {
      throw enhanceError(err, filePath);
    }
    throw err;
  }
}

export function parseModuleFromFile(filePath: string): ast.Module {
  const absolute = path.resolve(filePath);
  const contents = fs.readFileSync(absolute, "utf8");
  return parseModule(contents, absolute);
}

function enhanceError(err: unknown, filePath: string): unknown {
  if (err && typeof err === "object" && "message" in err) {
    const error = err as { message: string };
    return new Error(`${filePath}: ${error.message}`);
  }
  return err;
}
