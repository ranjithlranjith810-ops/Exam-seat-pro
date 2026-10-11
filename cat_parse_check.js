const fs = require("fs");
const parser = require("./cat_extract.js").__parser;

const path = process.argv[2];
const html = fs.readFileSync(path, "utf8");
const re = /<script([^>]*)>/gi;
let m, target = null;
while ((m = re.exec(html)) !== null) {
  const start = m.index + m[0].length;
  const end = html.toLowerCase().indexOf("</script", start);
  if (end < 0) continue;
  const content = html.slice(start, end);
  if (/catNormalizeOcrRect/.test(content)) { target = content; break; }
}
if (!target) { console.log("FAIL: app block not found"); process.exit(1); }
console.log("app block length:", target.length, "at char", target.indexOf("catNormalizeOcrRect") >= 0);

try {
  parser.parse(target, {
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    plugins: ["jsx", "optionalChaining", "nullishCoalescingOperator", "objectRestSpread", "classProperties", "dynamicImport"],
  });
  console.log("PASS: app block parses cleanly");
} catch (e) {
  console.log("FAIL: " + e.message);
  process.exit(1);
}