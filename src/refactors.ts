import * as ast from "./ast";
import { ResolvedModule, SymbolTable, resolveIdentifier } from "./loader";
import { parseModule } from "./parser";

export class RefactorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefactorError";
  }
}

export type RefactorOperationSummary =
  | {
      kind: "rename_type";
      from: string;
      to: string;
      typeReferencesUpdated: number;
      recordConstructorsUpdated: number;
    }
  | {
      kind: "rename_function";
      from: string;
      to: string;
      callSitesUpdated: number;
      contractsRenamed: number;
    }
  | {
      kind: "move_type";
      symbol: string;
      fromModule: string;
      toModule: string;
      referencesUpdated: number;
    }
  | {
      kind: "move_function";
      symbol: string;
      fromModule: string;
      toModule: string;
      callSitesUpdated: number;
    }
  | {
      kind: "update_param_list";
      symbol: string;
      callSitesUpdated: number;
    }
  | {
      kind: "replace_pattern";
      pattern: string;
      replacement: string;
      occurrencesReplaced: number;
    };

export type ModuleChangeSummary = {
  module: string;
  filePath: string;
  changes: string[];
};

export type ApplyRefactorResult = {
  refactorName: string;
  operationSummaries: RefactorOperationSummary[];
  moduleChanges: ModuleChangeSummary[];
};

type RenameContext = {
  fromQualified: string;
  toQualified: string;
  fromModule: string;
  toModule: string;
  fromSymbol: string;
  newSymbol: string;
};

type ModuleNaming = {
  localModule: string;
  aliasToModule: Map<string, string>;
  shortNameToModule: Map<string, string>;
};

type CtorPattern = Extract<ast.Pattern, { kind: "CtorPattern" }>;

type VisitorCallbacks = {
  onTypeExpr?: (typeExpr: ast.TypeExpr) => void;
  onCallExpr?: (call: ast.CallExpr) => void;
  onRecordExpr?: (expr: ast.RecordExpr) => void;
  onPatternCtor?: (pattern: CtorPattern) => void;
  onPattern?: (pattern: ast.Pattern) => void;
};

export function findRefactorDecl(
  modules: ResolvedModule[],
  name: string,
): { decl: ast.RefactorDecl; module: ResolvedModule } | null {
  let found: { decl: ast.RefactorDecl; module: ResolvedModule } | null = null;
  for (const mod of modules) {
    for (const decl of mod.ast.decls) {
      if (decl.kind !== "RefactorDecl") {
        continue;
      }
      if (decl.name !== name) {
        continue;
      }
      if (found) {
        throw new RefactorError(`Multiple refactor declarations named '${name}' found`);
      }
      found = { decl, module: mod };
    }
  }
  return found;
}

export function applyRefactor(
  refactor: ast.RefactorDecl,
  modules: ResolvedModule[],
  symbolTable: SymbolTable,
): ApplyRefactorResult {
  const applier = new RefactorApplier(refactor, modules, symbolTable);
  applier.apply();
  return applier.result();
}

class RefactorApplier {
  private readonly moduleByName: Map<string, ResolvedModule>;
  private readonly moduleChanges = new Map<string, ModuleChangeSummary>();
  private readonly operationSummaries: RefactorOperationSummary[] = [];
  private readonly namingCache = new Map<ast.Module, ModuleNaming>();

  constructor(
    private readonly decl: ast.RefactorDecl,
    private readonly modules: ResolvedModule[],
    private readonly symbolTable: SymbolTable,
  ) {
    this.moduleByName = new Map(
      modules.map((mod) => [mod.moduleName.join("."), mod]),
    );
  }

  apply(): void {
    for (const operation of this.decl.operations) {
      switch (operation.kind) {
        case "RenameTypeOperation":
          this.operationSummaries.push(this.applyRenameType(operation));
          break;
        case "RenameFunctionOperation":
          this.operationSummaries.push(this.applyRenameFunction(operation));
          break;
        case "MoveTypeOperation":
          this.operationSummaries.push(this.applyMoveType(operation));
          break;
        case "MoveFunctionOperation":
          this.operationSummaries.push(this.applyMoveFunction(operation));
          break;
        case "UpdateParamListOperation":
          this.operationSummaries.push(this.applyUpdateParamList(operation));
          break;
        case "ReplacePatternOperation":
          this.operationSummaries.push(this.applyReplacePattern(operation));
          break;
        default:
          const _exhaustive: never = operation;
          throw new RefactorError(`Unsupported refactor operation ${(operation as ast.RefactorOperation).kind}`);
      }
    }
  }

  result(): ApplyRefactorResult {
    return {
      refactorName: this.decl.name,
      operationSummaries: this.operationSummaries,
      moduleChanges: Array.from(this.moduleChanges.values()),
    };
  }

  private applyRenameType(operation: ast.RenameTypeOperation): RefactorOperationSummary {
    const fromParts = splitQualified(operation.from);
    const toParts = splitQualified(operation.to);
    if (fromParts.module !== toParts.module) {
      throw new RefactorError(
        `Cannot rename type across modules (${operation.from} -> ${operation.to}). Use a move refactor.`,
      );
    }
    if (!this.symbolTable.types.has(operation.from)) {
      throw new RefactorError(`Unknown type '${operation.from}'`);
    }
    if (this.symbolTable.types.has(operation.to)) {
      throw new RefactorError(`Target type '${operation.to}' already exists`);
    }

    const moduleInfo = this.getModule(fromParts.module);
    const typeDecl = moduleInfo.ast.decls.find(
      (decl): decl is ast.TypeDecl => isTypeDeclNamed(decl, fromParts.symbol),
    );
    if (!typeDecl) {
      throw new RefactorError(`Type declaration for '${operation.from}' not found in module ${fromParts.module}`);
    }
    typeDecl.name = toParts.symbol;
    this.recordModuleChange(moduleInfo, `renamed type ${operation.from} -> ${operation.to}`);

    const context: RenameContext = {
      fromQualified: operation.from,
      toQualified: operation.to,
      fromModule: fromParts.module,
      toModule: toParts.module,
      fromSymbol: fromParts.symbol,
      newSymbol: toParts.symbol,
    };
    const typeRefs = this.renameTypeReferences(context);
    let constructorUpdates = 0;
    if (typeDecl.kind === "RecordTypeDecl") {
      constructorUpdates = this.renameRecordConstructors(context);
    }

    this.symbolTable.types.delete(operation.from);
    this.symbolTable.types.set(operation.to, typeDecl);

    return {
      kind: "rename_type",
      from: operation.from,
      to: operation.to,
      typeReferencesUpdated: typeRefs,
      recordConstructorsUpdated: constructorUpdates,
    };
  }

  private applyRenameFunction(operation: ast.RenameFunctionOperation): RefactorOperationSummary {
    const fromParts = splitQualified(operation.from);
    const toParts = splitQualified(operation.to);
    if (fromParts.module !== toParts.module) {
      throw new RefactorError(
        `Cannot rename function across modules (${operation.from} -> ${operation.to}). Use a move refactor.`,
      );
    }

    const moduleInfo = this.getModule(fromParts.module);
    const fnDecl = moduleInfo.ast.decls.find(
      (decl): decl is ast.FnDecl => decl.kind === "FnDecl" && decl.name === fromParts.symbol,
    );
    if (!fnDecl) {
      throw new RefactorError(`Function declaration '${operation.from}' not found`);
    }
    if (this.symbolTable.functions.has(operation.to)) {
      throw new RefactorError(`Target function '${operation.to}' already exists`);
    }

    fnDecl.name = toParts.symbol;
    this.recordModuleChange(moduleInfo, `renamed function ${operation.from} -> ${operation.to}`);
    const contractRenamed = this.renameContract(moduleInfo.ast, fromParts.symbol, toParts.symbol);
    if (contractRenamed) {
      this.recordModuleChange(moduleInfo, `renamed contract ${operation.from} -> ${operation.to}`);
    }

    const context: RenameContext = {
      fromQualified: operation.from,
      toQualified: operation.to,
      fromModule: fromParts.module,
      toModule: toParts.module,
      fromSymbol: fromParts.symbol,
      newSymbol: toParts.symbol,
    };
    const callSites = this.renameCallSites(context);

    this.symbolTable.functions.delete(operation.from);
    this.symbolTable.functions.set(operation.to, fnDecl);

    return {
      kind: "rename_function",
      from: operation.from,
      to: operation.to,
      callSitesUpdated: callSites,
      contractsRenamed: contractRenamed ? 1 : 0,
    };
  }

  private renameContract(module: ast.Module, oldName: string, newName: string): boolean {
    const contract = module.decls.find(
      (decl): decl is ast.FnContractDecl => decl.kind === "FnContractDecl" && decl.name === oldName,
    );
    if (!contract) {
      return false;
    }
    contract.name = newName;
    return true;
  }

  private renameTypeReferences(context: RenameContext): number {
    let total = 0;
    for (const mod of this.modules) {
      let moduleCount = 0;
      walkModule(mod.ast, {
        onTypeExpr: (typeExpr) => {
          moduleCount += this.renameTypeExprIfNeeded(typeExpr, mod.ast, context);
        },
      });
      if (moduleCount > 0) {
        total += moduleCount;
        this.recordModuleChange(mod, `updated ${moduleCount} type reference(s) for ${context.fromQualified}`);
      }
    }
    return total;
  }

  private renameRecordConstructors(context: RenameContext): number {
    let total = 0;
    for (const mod of this.modules) {
      let moduleCount = 0;
      walkModule(mod.ast, {
        onRecordExpr: (expr) => {
          const resolved = resolveIdentifier(expr.typeName, mod.ast, this.symbolTable);
          if (resolved !== context.fromQualified) {
            return;
          }
            expr.typeName = this.rewriteIdentifier(expr.typeName, mod.ast, context);
          moduleCount += 1;
        },
        onPatternCtor: (pattern) => {
          if (pattern.ctorName === context.fromSymbol) {
            pattern.ctorName = context.newSymbol;
            moduleCount += 1;
          }
        },
      });
      if (moduleCount > 0) {
        total += moduleCount;
        this.recordModuleChange(mod, `updated ${moduleCount} record constructor(s) for ${context.fromQualified}`);
      }
    }
    return total;
  }

  private renameCallSites(context: RenameContext): number {
    let total = 0;
    for (const mod of this.modules) {
      let moduleCount = 0;
      walkModule(mod.ast, {
        onCallExpr: (expr) => {
          moduleCount += this.renameCallExprIfNeeded(expr, mod.ast, context);
        },
      });
      if (moduleCount > 0) {
        total += moduleCount;
        this.recordModuleChange(mod, `updated ${moduleCount} call site(s) for ${context.fromQualified}`);
      }
    }
    return total;
  }

  private renameTypeExprIfNeeded(typeExpr: ast.TypeExpr, module: ast.Module, context: RenameContext): number {
    if (typeExpr.kind !== "TypeName") {
      return 0;
    }
    const resolved = resolveIdentifier(typeExpr.name, module, this.symbolTable);
    if (resolved !== context.fromQualified) {
      return 0;
    }
    typeExpr.name = this.rewriteIdentifier(typeExpr.name, module, context);
    return 1;
  }

  private renameCallExprIfNeeded(call: ast.CallExpr, module: ast.Module, context: RenameContext): number {
    const resolved = resolveIdentifier(call.callee, module, this.symbolTable);
    if (resolved !== context.fromQualified) {
      return 0;
    }
    call.callee = this.rewriteIdentifier(call.callee, module, context);
    return 1;
  }

  private recordModuleChange(module: ResolvedModule, reason: string): void {
    const moduleName = module.moduleName.join(".");
    const entry =
      this.moduleChanges.get(moduleName) ||
      {
        module: moduleName,
        filePath: module.filePath,
        changes: [],
      };
    entry.changes.push(reason);
    this.moduleChanges.set(moduleName, entry);
  }

  private getModule(name: string): ResolvedModule {
    const module = this.moduleByName.get(name);
    if (!module) {
      throw new RefactorError(`Module '${name}' is not loaded`);
    }
    return module;
  }

  private rewriteIdentifier(original: string, module: ast.Module, context: RenameContext): string {
    const naming = this.getNaming(module);
    const currentModule = module.name.join(".");
    const isMove = context.fromModule !== context.toModule;

    if (isMove) {
      if (currentModule === context.toModule) {
        return context.newSymbol;
      }
      // For cross-module moves, ensure target is imported and use qualified name
      const alias = this.ensureImport(module, context.toModule);
      return `${alias}.${context.newSymbol}`;
    }

    if (!original.includes(".")) {
      return context.newSymbol;
    }
    if (original.startsWith(`${context.fromModule}.`)) {
      const parts = original.split(".");
      parts[parts.length - 1] = context.newSymbol;
      return parts.join(".");
    }
    const parts = original.split(".");
    const first = parts[0]!;
    const aliasTarget = naming.aliasToModule.get(first);
    if (aliasTarget === context.fromModule) {
      parts[parts.length - 1] = context.newSymbol;
      return parts.join(".");
    }
    const shortTarget = naming.shortNameToModule.get(first);
    if (shortTarget === context.fromModule) {
      parts[parts.length - 1] = context.newSymbol;
      return parts.join(".");
    }
    return context.toQualified;
  }

  private ensureImport(module: ast.Module, targetModule: string): string {
    const naming = this.getNaming(module);

    // Check if already imported via alias
    for (const [alias, modName] of naming.aliasToModule) {
      if (modName === targetModule) {
        return alias;
      }
    }
    // Check if already imported via short name
    for (const [short, modName] of naming.shortNameToModule) {
      if (modName === targetModule) {
        return short;
      }
    }

    // Not imported, add import
    const parts = targetModule.split(".");
    const shortName = parts[parts.length - 1]!;
    
    let alias = shortName;
    let counter = 1;
    while (this.isNameConflict(module, alias)) {
      alias = `${shortName}_${counter}`;
      counter++;
    }

    const newImport: ast.ImportDecl = {
      kind: "ImportDecl",
      moduleName: parts,
      ...(alias !== shortName ? { alias } : {}),
    };
    
    // Insert import (at the end of imports for simplicity, or sorted?)
    // AST doesn't enforce order, but usually imports are at top.
    // module.imports is an array.
    module.imports.push(newImport);

    // Update naming cache
    if (alias === shortName) {
      naming.shortNameToModule.set(shortName, targetModule);
    } else {
      naming.aliasToModule.set(alias, targetModule);
    }

    const resolvedModule = this.getResolvedModule(module);
    this.recordModuleChange(resolvedModule, `added import ${targetModule} as ${alias}`);

    return alias;
  }

  private isNameConflict(module: ast.Module, name: string): boolean {
    const naming = this.getNaming(module);
    if (naming.aliasToModule.has(name) || naming.shortNameToModule.has(name)) {
      return true;
    }
    
    return module.decls.some((d) => {
      if (
        d.kind === "AliasTypeDecl" ||
        d.kind === "RecordTypeDecl" ||
        d.kind === "SumTypeDecl" ||
        d.kind === "FnDecl" ||
        d.kind === "ActorDecl" ||
        d.kind === "SchemaDecl" ||
        d.kind === "RefactorDecl" ||
        d.kind === "TestDecl" ||
        d.kind === "PropertyDecl" ||
        d.kind === "FnContractDecl"
      ) {
        return d.name === name;
      }
      return false;
    });
  }

  private getResolvedModule(module: ast.Module): ResolvedModule {
    const name = module.name.join(".");
    const resolved = this.moduleByName.get(name);
    if (!resolved) {
      throw new RefactorError(`Module '${name}' not found in loaded modules`);
    }
    return resolved;
  }

  private getNaming(module: ast.Module): ModuleNaming {
    const cached = this.namingCache.get(module);
    if (cached) {
      return cached;
    }
    const aliasToModule = new Map<string, string>();
    const shortNameToModule = new Map<string, string>();
    for (const imp of module.imports) {
      const full = imp.moduleName.join(".");
      if (imp.alias) {
        aliasToModule.set(imp.alias, full);
      }
      const shortName = imp.moduleName[imp.moduleName.length - 1];
      if (shortName) {
        shortNameToModule.set(shortName, full);
      }
    }
    const naming: ModuleNaming = {
      localModule: module.name.join("."),
      aliasToModule,
      shortNameToModule,
    };
    this.namingCache.set(module, naming);
    return naming;
  }

  private applyMoveType(operation: ast.MoveTypeOperation): RefactorOperationSummary {
    const sourceModule = this.getModule(operation.fromModule);
    const targetModule = this.getModule(operation.toModule);

    const declIndex = sourceModule.ast.decls.findIndex((decl) => isTypeDeclNamed(decl, operation.symbol));
    if (declIndex === -1) {
      throw new RefactorError(`Type '${operation.symbol}' not found in module '${operation.fromModule}'`);
    }
    const decl = sourceModule.ast.decls[declIndex] as ast.TypeDecl;

    if (targetModule.ast.decls.some((d) => isTypeDeclNamed(d, operation.symbol))) {
      throw new RefactorError(`Type '${operation.symbol}' already exists in module '${operation.toModule}'`);
    }

    sourceModule.ast.decls.splice(declIndex, 1);
    targetModule.ast.decls.push(decl);

    this.recordModuleChange(sourceModule, `moved type ${operation.symbol} to ${operation.toModule}`);
    this.recordModuleChange(targetModule, `received type ${operation.symbol} from ${operation.fromModule}`);

    const context: RenameContext = {
      fromQualified: `${operation.fromModule}.${operation.symbol}`,
      toQualified: `${operation.toModule}.${operation.symbol}`,
      fromModule: operation.fromModule,
      toModule: operation.toModule,
      fromSymbol: operation.symbol,
      newSymbol: operation.symbol,
    };

    const refs = this.renameTypeReferences(context);
    let constructorUpdates = 0;
    if (decl.kind === "RecordTypeDecl") {
      constructorUpdates = this.renameRecordConstructors(context);
    }

    this.symbolTable.types.delete(context.fromQualified);
    this.symbolTable.types.set(context.toQualified, decl);

    return {
      kind: "move_type",
      symbol: operation.symbol,
      fromModule: operation.fromModule,
      toModule: operation.toModule,
      referencesUpdated: refs,
    };
  }

  private applyMoveFunction(operation: ast.MoveFunctionOperation): RefactorOperationSummary {
    const sourceModule = this.getModule(operation.fromModule);
    const targetModule = this.getModule(operation.toModule);

    const declIndex = sourceModule.ast.decls.findIndex(
      (decl) => decl.kind === "FnDecl" && decl.name === operation.symbol,
    );
    if (declIndex === -1) {
      throw new RefactorError(`Function '${operation.symbol}' not found in module '${operation.fromModule}'`);
    }
    const decl = sourceModule.ast.decls[declIndex] as ast.FnDecl;

    if (targetModule.ast.decls.some((d) => d.kind === "FnDecl" && d.name === operation.symbol)) {
      throw new RefactorError(`Function '${operation.symbol}' already exists in module '${operation.toModule}'`);
    }

    sourceModule.ast.decls.splice(declIndex, 1);
    targetModule.ast.decls.push(decl);

    this.recordModuleChange(sourceModule, `moved function ${operation.symbol} to ${operation.toModule}`);
    this.recordModuleChange(targetModule, `received function ${operation.symbol} from ${operation.fromModule}`);

    // Move contract if exists
    const contractIndex = sourceModule.ast.decls.findIndex(
      (d) => d.kind === "FnContractDecl" && d.name === operation.symbol,
    );
    if (contractIndex !== -1) {
      const contract = sourceModule.ast.decls[contractIndex]!;
      sourceModule.ast.decls.splice(contractIndex, 1);
      targetModule.ast.decls.push(contract);
      this.recordModuleChange(sourceModule, `moved contract for ${operation.symbol}`);
    }

    const context: RenameContext = {
      fromQualified: `${operation.fromModule}.${operation.symbol}`,
      toQualified: `${operation.toModule}.${operation.symbol}`,
      fromModule: operation.fromModule,
      toModule: operation.toModule,
      fromSymbol: operation.symbol,
      newSymbol: operation.symbol,
    };

    const callSites = this.renameCallSites(context);

    this.symbolTable.functions.delete(context.fromQualified);
    this.symbolTable.functions.set(context.toQualified, decl);

    return {
      kind: "move_function",
      symbol: operation.symbol,
      fromModule: operation.fromModule,
      toModule: operation.toModule,
      callSitesUpdated: callSites,
    };
  }

  private applyUpdateParamList(operation: ast.UpdateParamListOperation): RefactorOperationSummary {
    const { module: moduleName, symbol: functionName } = splitQualified(operation.symbol);
    const mod = this.getModule(moduleName);

    const fnDecl = mod.ast.decls.find(
      (d): d is ast.FnDecl => d.kind === "FnDecl" && d.name === functionName,
    );

    if (!fnDecl) {
      throw new RefactorError(`Function '${functionName}' not found in module '${moduleName}'`);
    }

    const oldParams = [...fnDecl.params]; // Copy old params

    // Update function declaration
    fnDecl.params = operation.params.map((p) => ({ name: p.name, type: p.type }));
    this.recordModuleChange(mod, `Updated parameters of function '${functionName}'`);

    // Update call sites
    const callSitesUpdated = this.updateCallSites(operation.symbol, oldParams, operation.params);

    return {
      kind: "update_param_list",
      symbol: operation.symbol,
      callSitesUpdated,
    };
  }

  private applyReplacePattern(operation: ast.ReplacePatternOperation): RefactorOperationSummary {
    const { pattern, replacement } = operation;

    let targetPattern: ast.Pattern;
    let replacementPattern: ast.Pattern;
    try {
      targetPattern = parsePattern(pattern);
      replacementPattern = parsePattern(replacement);
    } catch (e: any) {
      throw new RefactorError(`Invalid pattern or replacement: ${e.message}`);
    }

    let occurrencesReplaced = 0;

    for (const mod of this.modules) {
      walkModule(mod.ast, {
        onPattern: (p) => {
          if (patternsEqual(p, targetPattern)) {
            // Mutate p to match replacementPattern
            // We can't assign to 'p' directly to change the reference, but we can modify its properties.
            // Since Pattern is a discriminated union, we need to be careful.
            // We'll cast to any to overwrite properties.
            const pAny = p as any;
            
            // Clear existing properties
            for (const key in pAny) {
              if (Object.prototype.hasOwnProperty.call(pAny, key)) {
                delete pAny[key];
              }
            }
            
            // Copy new properties
            Object.assign(pAny, replacementPattern);
            
            occurrencesReplaced++;
            this.recordModuleChange(mod, `replaced pattern '${pattern}' with '${replacement}'`);
          }
        },
      });
    }

    return {
      kind: "replace_pattern",
      pattern,
      replacement,
      occurrencesReplaced,
    };
  }

  private updateCallSites(
    targetSymbol: string,
    oldParams: ast.Param[],
    newParams: ast.RefactorParam[],
  ): number {
    let total = 0;
    for (const mod of this.modules) {
      let moduleCount = 0;
      walkModule(mod.ast, {
        onCallExpr: (call) => {
          const resolved = resolveIdentifier(call.callee, mod.ast, this.symbolTable);
          if (resolved === targetSymbol) {
            this.updateCallArgs(call, oldParams, newParams);
            moduleCount++;
          }
        },
      });
      if (moduleCount > 0) {
        total += moduleCount;
        this.recordModuleChange(mod, `updated ${moduleCount} call site(s) for ${targetSymbol}`);
      }
    }
    return total;
  }

  private updateCallArgs(
    call: ast.CallExpr,
    oldParams: ast.Param[],
    newParams: ast.RefactorParam[],
  ): void {
    const argsMap = new Map<string, ast.Expr>();

    // Map existing arguments
    call.args.forEach((arg, index) => {
      if (arg.kind === "NamedArg") {
        argsMap.set(arg.name, arg.expr);
      } else {
        const oldParam = oldParams[index];
        if (oldParam) {
          argsMap.set(oldParam.name, arg.expr);
        }
      }
    });

    const newArgs: ast.CallArg[] = [];

    for (const param of newParams) {
      if (argsMap.has(param.name)) {
        newArgs.push({
          kind: "NamedArg",
          name: param.name,
          expr: argsMap.get(param.name)!,
        });
      } else if (param.defaultValue) {
        newArgs.push({
          kind: "NamedArg",
          name: param.name,
          expr: param.defaultValue,
        });
      } else {
        throw new RefactorError(
          `Cannot update call to '${call.callee}': Parameter '${param.name}' is missing and has no default value.`,
        );
      }
    }

    call.args = newArgs;
  }
}

function splitQualified(identifier: string): { module: string; symbol: string } {
  const index = identifier.lastIndexOf(".");
  if (index === -1) {
    throw new RefactorError(`Expected fully qualified name but found '${identifier}'`);
  }
  return {
    module: identifier.slice(0, index),
    symbol: identifier.slice(index + 1),
  };
}

function isTypeDeclNamed(decl: ast.TopLevelDecl, name: string): decl is ast.TypeDecl {
  return (
    (decl.kind === "AliasTypeDecl" ||
      decl.kind === "RecordTypeDecl" ||
      decl.kind === "SumTypeDecl") &&
    decl.name === name
  );
}

function walkModule(module: ast.Module, visitors: VisitorCallbacks): void {
  const visitTypeExpr = (typeExpr: ast.TypeExpr) => {
    visitors.onTypeExpr?.(typeExpr);
    if (typeExpr.kind === "TypeName") {
      for (const arg of typeExpr.typeArgs) {
        visitTypeExpr(arg);
      }
    } else if (typeExpr.kind === "OptionalType") {
      visitTypeExpr(typeExpr.inner);
    }
  };

  const visitPattern = (pattern: ast.Pattern) => {
    visitors.onPattern?.(pattern);
    if (pattern.kind === "CtorPattern") {
      visitors.onPatternCtor?.(pattern);
      for (const field of pattern.fields) {
        visitPattern(field.pattern);
      }
    }
  };

  const visitExpr = (expr: ast.Expr) => {
    switch (expr.kind) {
      case "CallExpr":
        visitors.onCallExpr?.(expr);
        for (const arg of expr.args) {
          visitExpr(arg.expr);
        }
        break;
      case "ListLiteral":
        for (const element of expr.elements) {
          visitExpr(element);
        }
        break;
      case "BinaryExpr":
        visitExpr(expr.left);
        visitExpr(expr.right);
        break;
      case "MatchExpr":
        visitExpr(expr.scrutinee);
        for (const matchCase of expr.cases) {
          visitPattern(matchCase.pattern);
          visitBlock(matchCase.body);
        }
        break;
      case "RecordExpr":
        visitors.onRecordExpr?.(expr);
        for (const field of expr.fields) {
          visitExpr(field.expr);
        }
        break;
      case "FieldAccessExpr":
        visitExpr(expr.target);
        break;
      case "IndexExpr":
        visitExpr(expr.target);
        visitExpr(expr.index);
        break;
      case "IfExpr":
        visitExpr(expr.cond);
        visitBlock(expr.thenBranch);
        if (expr.elseBranch) {
          visitBlock(expr.elseBranch);
        }
        break;
      case "VarRef":
      case "HoleExpr":
      case "IntLiteral":
      case "BoolLiteral":
      case "StringLiteral":
        break;
      default:
        const _exhaustive: never = expr;
        throw new RefactorError(`Unsupported expression kind ${(expr as ast.Expr).kind}`);
    }
  };

  const visitBlock = (block: ast.Block) => {
    for (const stmt of block.stmts) {
      switch (stmt.kind) {
        case "LetStmt":
          if (stmt.typeAnnotation) {
            visitTypeExpr(stmt.typeAnnotation);
          }
          visitExpr(stmt.expr);
          break;
        case "ReturnStmt":
          visitExpr(stmt.expr);
          break;
        case "ExprStmt":
          visitExpr(stmt.expr);
          break;
        case "MatchStmt":
          visitExpr(stmt.scrutinee);
          for (const matchCase of stmt.cases) {
            visitPattern(matchCase.pattern);
            visitBlock(matchCase.body);
          }
          break;
        case "AsyncGroupStmt":
          visitBlock(stmt.body);
          break;
        case "AsyncStmt":
          visitBlock(stmt.body);
          break;
        default:
          const _exhaustive: never = stmt;
          throw new RefactorError(`Unsupported statement kind ${(stmt as ast.Stmt).kind}`);
      }
    }
  };

  for (const decl of module.decls) {
    switch (decl.kind) {
      case "AliasTypeDecl":
        visitTypeExpr(decl.target);
        break;
      case "RecordTypeDecl":
        for (const field of decl.fields) {
          visitTypeExpr(field.type);
        }
        break;
      case "SumTypeDecl":
        for (const variant of decl.variants) {
          for (const field of variant.fields) {
            visitTypeExpr(field.type);
          }
        }
        break;
      case "SchemaDecl":
        for (const field of decl.fields) {
          visitTypeExpr(field.type);
        }
        break;
      case "FnDecl":
        for (const param of decl.params) {
          visitTypeExpr(param.type);
        }
        visitTypeExpr(decl.returnType);
        visitBlock(decl.body);
        break;
      case "FnContractDecl":
        for (const param of decl.params) {
          visitTypeExpr(param.type);
        }
        if (decl.returnType) {
          visitTypeExpr(decl.returnType);
        }
        for (const req of decl.requires) {
          visitExpr(req);
        }
        for (const ens of decl.ensures) {
          visitExpr(ens);
        }
        break;
      case "TestDecl":
        visitBlock(decl.body);
        break;
      case "PropertyDecl":
        for (const param of decl.params) {
          visitTypeExpr(param.type);
          if (param.predicate) {
            visitExpr(param.predicate);
          }
        }
        visitBlock(decl.body);
        break;
      case "ActorDecl":
        for (const param of decl.params) {
          visitTypeExpr(param.type);
        }
        for (const field of decl.stateFields) {
          visitTypeExpr(field.type);
        }
        for (const handler of decl.handlers) {
          for (const param of handler.msgParams) {
            visitTypeExpr(param.type);
          }
          visitTypeExpr(handler.returnType);
          visitBlock(handler.body);
        }
        break;
      case "EffectDecl":
      case "RefactorDecl":
        break;
      default:
        const _exhaustive: never = decl;
        throw new RefactorError(`Unsupported declaration kind ${(decl as ast.TopLevelDecl).kind}`);
    }
  }
}

function parsePattern(code: string): ast.Pattern {
  const dummyCode = `
    module dummy
    fn dummy() -> Unit {
      match x {
        case ${code} => {}
      }
    }
  `;
  const mod = parseModule(dummyCode);
  const fn = mod.decls.find((d) => d.kind === "FnDecl") as ast.FnDecl;
  const matchStmt = fn.body.stmts[0] as ast.MatchStmt;
  if (!matchStmt || !matchStmt.cases || matchStmt.cases.length === 0) {
      throw new Error("Failed to parse pattern");
  }
  return matchStmt.cases[0]!.pattern;
}

function patternsEqual(a: ast.Pattern, b: ast.Pattern): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "WildcardPattern") {
    return true;
  }
  if (a.kind === "VarPattern") {
    return a.name === (b as typeof a).name;
  }
  if (a.kind === "CtorPattern") {
    const bCtor = b as typeof a;
    if (a.ctorName !== bCtor.ctorName) {
      return false;
    }
    if (a.fields.length !== bCtor.fields.length) {
      return false;
    }
    for (let i = 0; i < a.fields.length; i++) {
      const fieldA = a.fields[i]!;
      const fieldB = bCtor.fields[i]!;
      if (fieldA.name !== fieldB.name) {
        return false;
      }
      if (!patternsEqual(fieldA.pattern, fieldB.pattern)) {
        return false;
      }
    }
    return true;
  }
  return false;
}
