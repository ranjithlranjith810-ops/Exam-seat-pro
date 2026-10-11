// Extracts named top-level declarations from the app block of index.html.
//
// Uses the real Babel parser and slices exact source ranges from the AST. An
// earlier hand-rolled brace matcher was replaced by this because a regex
// quantifier such as \d{1,2} looks exactly like a block brace pair: the matcher
// ended catParseTimetable in the middle of a character class, and the leftover
// text silently pulled in unrelated const declarations. Parsing removes the
// whole class of guesswork.
const fs = require("fs");

// @babel/parser is the tests' only dependency, and it is deliberately NOT
// installed inside this project: netlify.toml publishes this whole folder, so a
// package.json and a node_modules tree here would ship to production.
//
// Install it anywhere outside the project and point NODE_PATH at it:
//
//   npm install --prefix C:\Temp\catdeps @babel/parser
//   set NODE_PATH=C:\Temp\catdeps\node_modules
//   node run.js
//
// The same NODE_PATH is needed for cat_parse_check.js, which reuses the parser
// from here so there is only one place that resolves it.
let parser;
try {
  parser = require("@babel/parser");
} catch (e) {
  console.error(
    "\n  The CAT tests need @babel/parser, and it is not bundled with this project.\n\n" +
    "    npm install --prefix C:\\Temp\\catdeps @babel/parser\n" +
    "    set NODE_PATH=C:\\Temp\\catdeps\\node_modules\n" +
    "    node run.js\n\n" +
    "  It is kept out of the project on purpose: this folder is deployed as-is,\n" +
    "  and the app itself has no build step and no dependencies.\n");
  process.exit(1);
}

function appBlock(html) {
  const re = /<script([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const start = m.index + m[0].length;
    const end = html.toLowerCase().indexOf("</script", start);
    if (end < 0) continue;
    const content = html.slice(start, end);
    if (/catNormalizeOcrRect/.test(content)) return content;
  }
  return null;
}

function parseApp(html) {
  const block = appBlock(html);
  if (!block) throw new Error("app block not found in index.html");
  return { block, ast: parseBlock(block) };
}

function parseBlock(block) {
  try {
    return parser.parse(block, {
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      plugins: ["jsx", "optionalChaining", "nullishCoalescingOperator",
        "objectRestSpread", "classProperties", "dynamicImport"],
    });
  } catch (e) {
    throw new Error("script block failed to parse: " + e.message);
  }
}

// The app is split across several <script> blocks, and a CAT function routinely
// calls a helper declared in an earlier one (SCHED_MONTHS is used by the date
// parser but lives in the scheduling block). Parsing only the CAT block therefore
// produced "SCHED_MONTHS is not defined" at call time, long after the sandbox had
// loaded cleanly. Every block is parsed and the declarations merged.
function parseAll(html) {
  const blocks = [];
  const re = /<script([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const start = m.index + m[0].length;
    const end = html.toLowerCase().indexOf("</script", start);
    if (end < 0) continue;
    const text = html.slice(start, end);
    if (!text.trim()) continue;
    let ast;
    try { ast = parseBlock(text); } catch (_) { continue; }
    blocks.push({ text, ast });
  }
  if (!blocks.length) throw new Error("no parsable script block found in index.html");
  return blocks;
}

function collect(ast) {
  return collectFrom([{ text: ast.__text || "", ast }]);
}

// Declarations are collected across every block, tagged with the block they came
// from so the caller can slice the exact original source.
function collectFrom(blocks) {
  const fns = Object.create(null);
  const consts = Object.create(null);
  const flat = [];
  const push = (n) => { if (n && n.type === "BlockStatement") n.body.forEach(push); };
  for (const b of blocks) {
    for (const n of b.ast.program.body) {
      flat.push({ n, b });
      if (n.type === "ExpressionStatement" && n.expression &&
          (n.expression.type === "FunctionExpression" || n.expression.type === "ArrowFunctionExpression")) {
        push(n.expression.body);
      }
    }
  }
  for (const { n, b } of flat) {
    if (n.type === "FunctionDeclaration" && n.id && !fns[n.id.name])
      fns[n.id.name] = { text: b.text, node: n };
    if (n.type === "VariableDeclaration") {
      for (const d of n.declarations) {
        if (d.id && d.id.type === "Identifier" && !consts[d.id.name])
          consts[d.id.name] = { text: b.text, node: d };
      }
    }
  }
  return { fns, consts };
}

function extractFns(html, names) {
  const { fns } = collectFrom(parseAll(html));
  const out = {};
  for (const name of names) {
    const e = fns[name];
    out[name] = e ? e.text.slice(e.node.start, e.node.end) : null;
  }
  return out;
}

function constsOf(html, names) {
  const { consts } = collectFrom(parseAll(html));
  const out = {};
  for (const name of names) {
    const e = consts[name];
    out[name] = e ? e.text.slice(e.node.start, e.node.end) : null;
  }
  return out;
}

// Kept for callers that want the raw value without the `const NAME =` wrapper.
// Slicing the declarator's `init` node gives the value directly, and avoids
// depending on the exact spelling of the declaration - stripping
// `const NAME =` with a regex failed for `let`/`var` and for a declaration whose
// value referenced its own name, which produced a self-referential sandbox.
function consts(html, names) {
  const { consts } = collectFrom(parseAll(html));
  const out = {};
  for (const name of names) {
    const e = consts[name];
    const init = e && e.node.init;
    out[name] = init ? e.text.slice(init.start, init.end) : null;
  }
  return out;
}

module.exports = { extractFns, consts, constsOf, parseApp, parseAll, collectFrom, collect, appBlock, __parser: parser };