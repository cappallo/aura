const { parseModuleFromFile } = require('../dist/parser.js');
const { parseDocSpec, validateDocSpec } = require('../dist/docspec.js');

const filename = process.argv[2];
if (!filename) {
	console.error('Usage: node test-docspec.cjs <file.lx>');
	process.exit(1);
}

const mod = parseModuleFromFile(filename);
if (!mod) {
	console.error('Parse error');
	process.exit(1);
}

// Check for doc comments in declarations and parse them
for (const decl of mod.decls) {
	if (decl.docComment) {
		console.log(`\n${decl.kind} '${decl.name}':`);
		console.log('Raw doc comment:', decl.docComment);
		
		const spec = parseDocSpec(decl.docComment);
		if (spec) {
			console.log('Parsed spec:', JSON.stringify(spec, null, 2));
			
			const errors = validateDocSpec(spec, decl);
			if (errors.length > 0) {
				console.log('Validation errors:', errors);
			} else {
				console.log('Validation: OK');
			}
		} else {
			console.log('Not a structured spec comment');
		}
	}
}
