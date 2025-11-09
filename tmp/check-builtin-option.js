const { typecheckModules, buildSymbolTable } = require('../dist/typecheck');
const { parseModule } = require('../dist/parser');
const fs = require('fs');
const path = require('path');

const filePath = path.resolve('examples/schema_codecs.lx');
const code = fs.readFileSync(filePath, 'utf8');
const mod = parseModule(code, filePath);

const modules = [{
  moduleName: mod.name,
  filePath,
  ast: mod
}];

const symbolTable = require('../dist/loader').buildSymbolTable(modules);
require('../dist/loader').generateTypesFromSchemas(symbolTable);

// Create a mock context to check what's available
console.log('Testing built-in Option type registration...\n');

const errors = typecheckModules(modules, symbolTable);
console.log('Type errors:', errors.length);
errors.forEach(err => console.log(' -', err.message));
