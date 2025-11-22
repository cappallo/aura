const fs = require("fs");
const parser = require("../src/parser.generated.js");

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/debug-parse.cjs <file>");
  process.exit(1);
}

try {
  const ast = parser.parse(fs.readFileSync(filePath, "utf8"));
  console.log(JSON.stringify(ast, null, 2));
} catch (error) {
  console.error(error.message);
  if (error.location) {
    console.error(error.location);
  }
  process.exit(1);
}
