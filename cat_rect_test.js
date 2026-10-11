const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { extractFns, consts } = require("./cat_extract.js");

const HTML = process.argv[2] ||
  "D:\\COMPLETED PROJECTS\\SEATING PROJECT\\ExamSeatPro_v66_secure\\index.html";
const src = fs.readFileSync(HTML, "utf8");

const FN_NAMES = [
  "catDebugOn", "catLog",
  "catNormalizeOcrRect", "catOcrRectText", "catOcrRectBad", "catOcrRectDrift",
  "catOcrRectRotate", "catOcrFrameOf", "catOcrFrameRoot", "catOcrFrameDerive",
  "catOcrRectPageToImage", "catOcrRectImageToPage", "catOcrStripBox",
  "catCropCanvas", "catRotateCanvas",
];
const CONST_NAMES = [
  "CAT_OCR_RECT_DRIFT", "CAT_OCR_STRIP_OVERLAP", "CAT_OCR_STRIP_PAD",
  "CAT_OCR_REGION_MIN", "CAT_OCR_STRIP_MIN",
];

const fns = extractFns(src, FN_NAMES);
const cs = consts(src, CONST_NAMES);
const missing = FN_NAMES.filter((n) => !fns[n]).concat(CONST_NAMES.filter((n) => !cs[n]));
if (missing.length) {
  console.log("FAIL: could not extract ->", missing.join(", "));
  process.exit(1);
}

const logs = [];
const sandbox = {
  console,
  Math, JSON, Object, Array, String, Number, isFinite, parseInt, parseFloat,
  document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({
    fillRect() {}, drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {},
  }) }) },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let boot = "";
for (const n of CONST_NAMES) boot += "const " + n + " = " + cs[n] + ";\n";
boot += "var __debug = false;\n";
boot += "function catDebugOn(){ return __debug; }\n";
boot += "function catLog(tag, msg){ logs.push(tag + ': ' + msg); }\n";
for (const n of FN_NAMES) if (fns[n] && n !== "catDebugOn" && n !== "catLog") boot += fns[n] + "\n";
boot += "globalThis.__t = { catNormalizeOcrRect, catOcrRectRotate, catOcrRectPageToImage, catOcrRectImageToPage, catOcrStripBox, catCropCanvas, catRotateCanvas, catOcrFrameOf, catOcrFrameDerive };";
sandbox.logs = logs;
vm.runInContext(boot, sandbox);
const T = sandbox.__t;

let pass = 0, fail = 0;
const failures = [];
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; }
  else { fail++; failures.push(name + "\n    expected " + b + "\n    actual   " + a); }
}
function ok(cond, name, detail) {
  if (cond) pass++; else { fail++; failures.push(name + (detail ? "\n    " + detail : "")); }
}

logs.length = 0;
const N = T.catNormalizeOcrRect;
const W = 1000, H = 800;

// 1. fully inside
eq(N({ x: 100, y: 100, width: 200, height: 200 }, W, H, "inside"), { x: 100, y: 100, width: 200, height: 200 }, "1 inside");
ok(logs.length === 0, "1 inside emits no diagnostic");

// 2. touching right edge
eq(N({ x: 800, y: 0, width: 200, height: 50 }, W, H, "right"), { x: 800, y: 0, width: 200, height: 50 }, "2 right edge");

// 3. touching bottom edge
eq(N({ x: 0, y: 700, width: 50, height: 100 }, W, H, "bottom"), { x: 0, y: 700, width: 50, height: 100 }, "3 bottom edge");

// 4. touching both edges
eq(N({ x: 800, y: 700, width: 200, height: 100 }, W, H, "both"), { x: 800, y: 700, width: 200, height: 100 }, "4 both edges");

// 5. slightly outside right
eq(N({ x: 800, y: 100, width: 250, height: 100 }, W, H, "or"), { x: 800, y: 100, width: 200, height: 100 }, "5 slight right overflow clipped");

// 6. slightly outside bottom
eq(N({ x: 10, y: 700, width: 100, height: 150 }, W, H, "ob"), { x: 10, y: 700, width: 100, height: 100 }, "6 slight bottom overflow clipped");

// 7. negative x
eq(N({ x: -40, y: 100, width: 200, height: 100 }, W, H, "nx"), { x: 0, y: 100, width: 160, height: 100 }, "7 negative x clipped");

// 8. negative y
eq(N({ x: 100, y: -30, width: 200, height: 100 }, W, H, "ny"), { x: 100, y: 0, width: 200, height: 70 }, "8 negative y clipped");

// 9. negative width
eq(N({ x: 300, y: 100, width: -100, height: 100 }, W, H, "nw"), { x: 200, y: 100, width: 100, height: 100 }, "9 negative width normalized");

// 10. negative height
eq(N({ x: 100, y: 300, width: 100, height: -100 }, W, H, "nh"), { x: 100, y: 200, width: 100, height: 100 }, "10 negative height normalized");

// 11. zero width
eq(N({ x: 100, y: 100, width: 0, height: 100 }, W, H, "zw"), null, "11 zero width rejected");

// 12. zero height
eq(N({ x: 100, y: 100, width: 100, height: 0 }, W, H, "zh"), null, "12 zero height rejected");

// 13. NaN
eq(N({ x: NaN, y: 0, width: 10, height: 10 }, W, H, "nan"), null, "13 NaN rejected");
eq(N({ x: 0, y: 0, width: NaN, height: 10 }, W, H, "nan2"), null, "13b NaN width rejected");

// 14. Infinity
eq(N({ x: 0, y: 0, width: Infinity, height: 10 }, W, H, "inf"), null, "14 Infinity rejected");
eq(N({ x: -Infinity, y: 0, width: 10, height: 10 }, W, H, "inf2"), null, "14b -Infinity rejected");

// 15. crop-local rectangle stays in image-local space
eq(N({ x: 0, y: 0, width: 800, height: 400 }, 800, 400, "crop"), { x: 0, y: 0, width: 800, height: 400 }, "15 crop-local full");

// 16. strip-local rectangle
eq(N({ x: 0, y: 0, width: 2480, height: 600 }, 2480, 600, "strip"), { x: 0, y: 0, width: 2480, height: 600 }, "16 strip-local full");

// 17. page -> crop conversion, documented in section 9
(function () {
  const page = { x: 500, y: 1000, width: 800, height: 400 };
  const parent = mkCanvas(2480, 3508);
  parent.__catFrame = { x: 0, y: 0, w: 2480, h: 3508, rot: 0, scale: 1, pw: 2480, ph: 3368, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
  const crop = T.catOcrFrameDerive(parent, mkCanvas(800, 400), { x: 500, y: 1000, rot: 0 });
  eq(T.catOcrRectPageToImage(page, crop), { x: 0, y: 0, width: 800, height: 400 }, "17 page->crop");
  eq(T.catOcrRectImageToPage({ x: 0, y: 0, width: 800, height: 400 }, crop), page, "17b crop->page");
})();

function mkCanvas(w, h) {
  return { width: w, height: h, getContext: () => ({ fillRect() {}, drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {} }) };
}

// 18. page -> strip conversion: a strip covering page rows 1200..1800 is image 0..600
(function () {
  const parent = mkCanvas(2480, 3368);
  parent.__catFrame = { x: 0, y: 0, w: 2480, h: 3368, rot: 0, scale: 1, pw: 2480, ph: 3368, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
  const strip = T.catCropCanvas(parent, { x0: 0, y0: 1200, x1: 2480, y1: 1800, w: 2480, h: 3368 }, 0);
  ok(strip !== null, "18 crop produced an image");
  const pageRect = { x: 0, y: 1200, width: 2480, height: 600 };
  eq(T.catOcrRectPageToImage(pageRect, strip), { x: 0, y: 0, width: 2480, height: strip.height }, "18 page->strip is image-local");
  const back = T.catOcrRectImageToPage({ x: 0, y: 0, width: 2480, height: strip.height }, strip);
  eq(back, pageRect, "18b strip->page restores the page row");
})();

// 19/20/21. rotation
eq(T.catOcrRectRotate({ x: 10, y: 20, width: 100, height: 50 }, 90, 400, 300), { x: 20, y: 400 - 10 - 100, width: 50, height: 100 }, "19 rot90");
eq(T.catOcrRectRotate({ x: 10, y: 20, width: 100, height: 50 }, 180, 400, 300), { x: 400 - 10 - 100, y: 300 - 20 - 50, width: 100, height: 50 }, "20 rot180");
eq(T.catOcrRectRotate({ x: 10, y: 20, width: 100, height: 50 }, 270, 400, 300), { x: 300 - 20 - 50, y: 10, width: 50, height: 100 }, "21 rot270");
eq(T.catOcrRectRotate({ x: 10, y: 20, width: 100, height: 50 }, 0, 400, 300), { x: 10, y: 20, width: 100, height: 50 }, "19b rot0 identity");

// rotation round-trip through the frame, measured in true PAGE space
(function () {
  const parent = mkCanvas(400, 300);
  parent.__catFrame = { x: 0, y: 0, w: 400, h: 300, rot: 0, scale: 1, pw: 400, ph: 300, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
  const rot = T.catRotateCanvas(parent, 90);
  eq([rot.width, rot.height], [300, 400], "22 rot90 image dims swapped");
  // page rect chosen so it lands inside the rotated image
  const pageRect = { x: 10, y: 20, width: 100, height: 50 };
  const inRot = T.catOcrRectPageToImage(pageRect, rot);
  ok(inRot !== null && inRot.x >= 0 && inRot.y >= 0 &&
     inRot.x + inRot.width <= rot.width && inRot.y + inRot.height <= rot.height,
    "22b rotated rect is inside the ROTATED image bounds",
    JSON.stringify(inRot) + " image " + rot.width + "x" + rot.height);
  const back = T.catOcrRectImageToPage(inRot, rot);
  eq(back, pageRect, "22c rotation round-trip restores page rect");
})();

// 23. rotation + crop
(function () {
  const parent = mkCanvas(400, 300);
  parent.__catFrame = { x: 0, y: 0, w: 400, h: 300, rot: 0, scale: 1, pw: 400, ph: 300, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
  const rot = T.catRotateCanvas(parent, 90);      // 300x400
  const crop = T.catCropCanvas(rot, { x0: 20, y0: 40, x1: 220, y1: 240, w: 300, h: 400 }, 0);
  ok(crop !== null, "23 rotation+crop produced an image");
  // find a page rect that lands inside the crop: crop image (10,10) -> rotated root (30,50) -> page
  const inCrop = T.catOcrRectImageToPage({ x: 10, y: 10, width: 40, height: 40 }, crop);
  const back = T.catOcrRectPageToImage(inCrop, crop);
  eq(back, { x: 10, y: 10, width: 40, height: 40 }, "23b rotation+crop round-trips");
  const reread = T.catOcrRectImageToPage(back, crop);
  eq(reread, inCrop, "23c stable");
})();

// 24. rotation + strip, and the strip-origin round trip
(function () {
  const parent = mkCanvas(800, 1200);
  parent.__catFrame = { x: 0, y: 0, w: 800, h: 1200, rot: 0, scale: 1, pw: 800, ph: 1200, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
  const rot = T.catRotateCanvas(parent, 90);   // 1200x800
  const box = T.catOcrStripBox(rot, 3, 1, 0);
  const strip = T.catCropCanvas(rot, box, 0);
  ok(strip !== null, "24 rotation+strip produced an image");
  // a rect at the very top-left of the strip image must land at 0,0 in image space
  const pageOfStripTopLeft = T.catOcrRectImageToPage({ x: 0, y: 0, width: 30, height: 30 }, strip);
  const inStrip = T.catOcrRectPageToImage(pageOfStripTopLeft, strip);
  eq(inStrip, { x: 0, y: 0, width: 30, height: 30 }, "24b strip rect is image-local at the strip origin");
  eq(T.catOcrRectImageToPage(inStrip, strip), pageOfStripTopLeft, "24c rotation+strip restores page rect");
})();

// 25. an unusable rectangle returns null and never throws
eq(N({ x: 0, y: 0, width: 10, height: 10 }, 0, 0, "zeroimage"), null, "25 zero-size image rejected");
eq(N(null, W, H, "nullrect"), null, "25b null rect rejected");
eq(N({ x: 0, y: 0, width: 10, height: 10 }, NaN, H, "nanimage"), null, "25c NaN image rejected");

// no function throws on hostile input
(function () {
  let threw = null;
  const hostile = [undefined, null, {}, [], "x", 0, NaN, Infinity,
    { x: -1e9, y: -1e9, width: 1e9, height: 1e9 },
    { x: 1e9, y: 1e9, width: -1e9, height: -1e9 }];
  for (const h of hostile) {
    try { N(h, W, H, "hostile"); } catch (e) { threw = e; }
  }
  ok(!threw, "25d validator never throws on hostile input", threw && threw.message);
})();

// strip geometry: overlap and padding are unchanged constants
(function () {
  const src2 = fs.readFileSync(HTML, "utf8");
  ok(/const\s+CAT_OCR_STRIP_OVERLAP\s*=\s*0\.12/.test(src2), "overlap remains 12%");
  ok(/const\s+CAT_OCR_STRIP_PAD\s*=\s*0\.05/.test(src2), "padding remains 5%");
  const parent = mkCanvas(2480, 3368);
  parent.__catFrame = { x: 0, y: 0, w: 2480, h: 3368, rot: 0, scale: 1, pw: 2480, ph: 3368, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
  const boxes = [0, 1, 2].map((i) => T.catOcrStripBox(parent, 3, i, 0));
  ok(boxes[1].y0 < boxes[1].y1, "strip box is well formed");
  const stripH = Math.ceil(3368 / 3);
  eq(boxes[0].y0, 0, "first strip starts at the page top");
  ok(boxes[1].y0 === stripH - Math.round(stripH * 0.12), "middle strip overlaps its neighbour by 12%");
})();

console.log("validator: " + pass + " passed, " + fail + " failed");
if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);