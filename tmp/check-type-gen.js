const { buildSymbolTable, loadModules, generateTypesFromSchemas } = require('../dist/loader');
const path = require('path');

const filePath = path.resolve('examples/schema_codecs.lx');
const modules = [{
  moduleName: ['examples', 'schema_codecs'],
  filePath,
  ast: require('../dist/parser').parseModule(
    require('fs').readFileSync(filePath, 'utf8'),
    filePath
  )
}];

const symbolTable = buildSymbolTable(modules);

console.log('Schemas in symbol table:', Array.from(symbolTable.schemas.keys()));
console.log('Types before generation:', Array.from(symbolTable.types.keys()));

generateTypesFromSchemas(symbolTable);

console.log('Types after generation:', Array.from(symbolTable.types.keys()));

// Check if the generated type is there
const userRecordType = symbolTable.types.get('examples.schema_codecs.UserRecord@1');
if (userRecordType) {
  console.log('\nGenerated type UserRecord@1:');
  console.log(JSON.stringify(userRecordType, null, 2));
}
