const { parseModuleFromFile } = require('../dist/parser.js');

const filename = process.argv[2];
if (!filename) {
	console.error('Usage: node check-doc.cjs <file.lx>');
	process.exit(1);
}

const mod = parseModuleFromFile(filename);
if (!mod) {
	console.error('Parse error');
	process.exit(1);
}

// Check for doc comments in declarations
for (const decl of mod.decls) {
	if (decl.docComment) {
		console.log(`${decl.kind} '${decl.name}' has doc comment:`);
		console.log(decl.docComment);
		console.log();
	}
}
