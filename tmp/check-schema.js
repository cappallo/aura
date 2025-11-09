const {parseModule} = require('../dist/parser');
const fs = require('fs');

const code = fs.readFileSync('examples/schema_codecs.lx', 'utf8');
const mod = parseModule(code, 'examples/schema_codecs.lx');

const schemas = mod.decls.filter(d => d.kind === 'SchemaDecl');
console.log('Schemas found:', schemas.length);
schemas.forEach(s => {
  console.log(`Schema: ${s.name}@${s.version}`);
  console.log('Fields:', s.fields.map(f => `${f.name}: ${JSON.stringify(f.type)}`));
});
