import fs from "fs";
import path from "path";
import * as ast from "./ast";
import { parseModule } from "./parser";

/**
 * Resolved module with its AST and file path
 */
export type ResolvedModule = {
  moduleName: string[];
  filePath: string;
  ast: ast.Module;
};

/**
 * Global symbol table mapping qualified names to declarations
 */
export type SymbolTable = {
  types: Map<string, ast.TypeDecl>;
  functions: Map<string, ast.FnDecl>;
  effects: Map<string, ast.EffectDecl>;
  schemas: Map<string, ast.SchemaDecl>;
};

/**
 * Convert module name (e.g., ['examples', 'math']) to file path
 * Searches relative to the entry file's directory and common root directories
 */
export function resolveModulePath(
  moduleName: string[],
  fromFilePath: string,
  searchPaths: string[] = []
): string {
  const relativeModulePath = moduleName.join(path.sep) + ".lx";
  
  // Try relative to the importing file's directory
  const fromDir = path.dirname(fromFilePath);
  const searchDirs = [fromDir, ...searchPaths];
  
  for (const dir of searchDirs) {
    const candidatePath = path.join(dir, relativeModulePath);
    if (fs.existsSync(candidatePath)) {
      return path.resolve(candidatePath);
    }
  }
  
  // Also try looking for just the last component in the same directory
  // This handles cases where multifile.math imports multifile.util - both are in the same dir
  if (moduleName.length > 1) {
    const lastComponentPath = moduleName[moduleName.length - 1] + ".lx";
    const sameDirPath = path.join(fromDir, lastComponentPath);
    if (fs.existsSync(sameDirPath)) {
      return path.resolve(sameDirPath);
    }
  }
  
  // If module name starts with the same prefix as the current directory structure,
  // try to resolve from project root
  const projectRoot = findProjectRoot(fromDir);
  if (projectRoot) {
    const rootPath = path.join(projectRoot, relativeModulePath);
    if (fs.existsSync(rootPath)) {
      return path.resolve(rootPath);
    }
  }
  
  throw new Error(
    `Module not found: ${moduleName.join(".")} (searched: ${searchDirs.join(", ")})`
  );
}

/**
 * Find project root by looking for package.json
 */
function findProjectRoot(startDir: string): string | null {
  let current = startDir;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

/**
 * Load all modules starting from entry file, resolving imports recursively
 * Returns modules in topological order (dependencies before dependents)
 */
export function loadModules(
  entryFilePath: string,
  searchPaths: string[] = []
): ResolvedModule[] {
  const resolved = new Map<string, ResolvedModule>();
  const visiting = new Set<string>();
  const order: ResolvedModule[] = [];
  
  function visit(filePath: string, importedFrom?: string): void {
    const absolutePath = path.resolve(filePath);
    const key = absolutePath;
    
    // Already processed
    if (resolved.has(key)) {
      return;
    }
    
    // Cycle detection
    if (visiting.has(key)) {
      const chain = importedFrom ? ` (imported from ${importedFrom})` : "";
      throw new Error(`Circular dependency detected: ${absolutePath}${chain}`);
    }
    
    visiting.add(key);
    
    // Parse the module
    const code = fs.readFileSync(absolutePath, "utf8");
    const module = parseModule(code, absolutePath);
    
    // Recursively visit imports
    for (const imp of module.imports) {
      try {
        const importPath = resolveModulePath(
          imp.moduleName,
          absolutePath,
          searchPaths
        );
        visit(importPath, absolutePath);
      } catch (err) {
        throw new Error(
          `Failed to resolve import ${imp.moduleName.join(".")} in ${absolutePath}: ${err}`
        );
      }
    }
    
    visiting.delete(key);
    
    // Add to resolved set and order
    const resolvedModule: ResolvedModule = {
      moduleName: module.name,
      filePath: absolutePath,
      ast: module,
    };
    resolved.set(key, resolvedModule);
    order.push(resolvedModule);
  }
  
  visit(entryFilePath);
  return order;
}

/**
 * Build global symbol table from loaded modules
 */
export function buildSymbolTable(modules: ResolvedModule[]): SymbolTable {
  const types = new Map<string, ast.TypeDecl>();
  const functions = new Map<string, ast.FnDecl>();
  const effects = new Map<string, ast.EffectDecl>();
  const schemas = new Map<string, ast.SchemaDecl>();
  
  for (const mod of modules) {
    const modulePrefix = mod.moduleName.join(".");
    
    for (const decl of mod.ast.decls) {
      switch (decl.kind) {
        case "AliasTypeDecl":
        case "RecordTypeDecl":
        case "SumTypeDecl": {
          const qualifiedName = `${modulePrefix}.${decl.name}`;
          if (types.has(qualifiedName)) {
            throw new Error(
              `Duplicate type declaration: ${qualifiedName} in ${mod.filePath}`
            );
          }
          types.set(qualifiedName, decl);
          break;
        }
        
        case "FnDecl": {
          const qualifiedName = `${modulePrefix}.${decl.name}`;
          if (functions.has(qualifiedName)) {
            throw new Error(
              `Duplicate function declaration: ${qualifiedName} in ${mod.filePath}`
            );
          }
          functions.set(qualifiedName, decl);
          break;
        }
        
        case "EffectDecl": {
          const qualifiedName = `${modulePrefix}.${decl.name}`;
          if (effects.has(qualifiedName)) {
            throw new Error(
              `Duplicate effect declaration: ${qualifiedName} in ${mod.filePath}`
            );
          }
          effects.set(qualifiedName, decl);
          break;
        }
        
        case "SchemaDecl": {
          const qualifiedName = `${modulePrefix}.${decl.name}`;
          if (schemas.has(qualifiedName)) {
            throw new Error(
              `Duplicate schema declaration: ${qualifiedName} in ${mod.filePath}`
            );
          }
          schemas.set(qualifiedName, decl);
          // Also add versioned name
          const versionedName = `${qualifiedName}@${decl.version}`;
          schemas.set(versionedName, decl);
          break;
        }
        
        case "FnContractDecl":
        case "TestDecl":
        case "PropertyDecl":
        case "ActorDecl":
          // Contracts, tests, properties, and actors are not part of the symbol table (yet)
          break;
        
        default:
          const _exhaustive: never = decl;
          throw new Error(`Unexpected declaration kind: ${(_exhaustive as any).kind}`);
      }
    }
  }
  
  return { types, functions, effects, schemas };
}

/**
 * Generate internal types from schema declarations
 * For each schema UserRecord@2, creates a RecordTypeDecl named UserRecord@2
 */
export function generateTypesFromSchemas(symbolTable: SymbolTable): void {
  for (const [qualifiedName, schema] of symbolTable.schemas.entries()) {
    // Only generate for versioned names (e.g., UserRecord@2, not UserRecord)
    if (!qualifiedName.includes("@")) {
      continue;
    }
    
    // Skip if type already exists (manually defined)
    if (symbolTable.types.has(qualifiedName)) {
      continue;
    }
    
    // Generate RecordTypeDecl from SchemaDecl
    const fields = schema.fields.map((field) => ({
      name: field.name,
      type: field.optional
        ? { kind: "OptionalType" as const, inner: field.type }
        : field.type,
    }));
    
    const recordType: ast.RecordTypeDecl = {
      kind: "RecordTypeDecl",
      name: qualifiedName,
      typeParams: [],
      fields,
      ...(schema.docComment ? { docComment: schema.docComment } : {}),
    };
    
    symbolTable.types.set(qualifiedName, recordType);
  }
}

/**
 * Resolve a potentially qualified identifier to its full qualified name
 * Takes into account module imports and aliases
 */
export function resolveIdentifier(
  identifier: string,
  currentModule: ast.Module,
  symbolTable: SymbolTable
): string {
  // Check if it's already qualified (contains a dot)
  if (identifier.includes(".")) {
    // Check if first part is an alias
    const parts = identifier.split(".");
    const firstPart = parts[0];
    
    // Look for import alias
    for (const imp of currentModule.imports) {
      if (imp.alias === firstPart) {
        // Replace alias with full module name
        const fullModuleName = imp.moduleName.join(".");
        return `${fullModuleName}.${parts.slice(1).join(".")}`;
      }
      
      // Check if first part matches the last component of the module name
      // E.g., "math.add" when we imported "multifile.math"
      const lastComponent = imp.moduleName[imp.moduleName.length - 1];
      if (lastComponent === firstPart) {
        const fullModuleName = imp.moduleName.join(".");
        return `${fullModuleName}.${parts.slice(1).join(".")}`;
      }
    }
    
    // Check if it's a direct module reference (no alias)
    // e.g., "examples.math.add" where we imported "examples.math"
    return identifier;
  }
  
  // Unqualified identifier - first try current module
  const currentModuleName = currentModule.name.join(".");
  const localName = `${currentModuleName}.${identifier}`;
  
  // Check if it exists in current module
  if (
    symbolTable.types.has(localName) ||
    symbolTable.functions.has(localName) ||
    symbolTable.effects.has(localName)
  ) {
    return localName;
  }
  
  // Check imports for unqualified access
  for (const imp of currentModule.imports) {
    const importedModuleName = imp.moduleName.join(".");
    const qualifiedName = `${importedModuleName}.${identifier}`;
    
    if (
      symbolTable.types.has(qualifiedName) ||
      symbolTable.functions.has(qualifiedName) ||
      symbolTable.effects.has(qualifiedName)
    ) {
      return qualifiedName;
    }
  }
  
  // Not found - return as-is and let caller handle error
  return identifier;
}
