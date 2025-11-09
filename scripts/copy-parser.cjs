const fs = require("fs");
const path = require("path");

const src = path.resolve(__dirname, "../src/parser.generated.js");
const dest = path.resolve(__dirname, "../dist/parser.generated.js");

if (!fs.existsSync(src)) {
  console.error("Generated parser not found at", src);
  process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
