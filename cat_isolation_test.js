// Requirement 15: one unusable OCR region must not fail the page.
// Exercises the REAL catReadPage / catOcrOnceStrips / catCropCanvas from
// index.html with a stubbed engine, so the isolation behaviour is the
// production behaviour and not a re-implementation of it.
const fs = require("fs");
const vm = require("vm");
const { extractFns, consts } = require("./cat_extract.js");

const HTML = process.argv[2] ||
  "D:\\COMPLETED PROJECTS\\SEATING PROJECT\\ExamSeatPro_v66_secure\\index.html";
const src = fs.readFileSync(HTML, "utf8");

const FN_NAMES = [
  "catDebugOn", "catLog", "catReadPage", "catOcrOnceStrips", "catCropCanvas",
  "catRotateCanvas", "catOcrOffsetWords", "catOcrMergeWords", "catOcrStripBox",
  "catOcrFrameOf", "catOcrFrameRoot", "catOcrFrameDerive",
  "catOcrRectPageToImage", "catOcrRectImageToPage", "catOcrRectRotate",
  "catNormalizeOcrRect", "catOcrRectText", "catOcrRectBad", "catOcrRectDrift",
];
const CONST_NAMES = [
  "CAT_OCR_RECT_DRIFT", "CAT_OCR_STRIP_OVERLAP", "CAT_OCR_STRIP_PAD",
  "CAT_OCR_REGION_MIN", "CAT_OCR_STRIP_MIN", "CAT_OCR_MAX_ATTEMPTS",
  "CAT_OCR_ORIENTATIONS", "CAT_OCR_MODES_FIRST", "CAT_OCR_MODES_FALLBACK",
];

const fns = extractFns(src, FN_NAMES);
const cs = consts(src, CONST_NAMES);
const missing = FN_NAMES.filter((n) => !fns[n]).concat(CONST_NAMES.filter((n) => !cs[n]));
if (missing.length) { console.log("FAIL: could not extract ->", missing.join(", ")); process.exit(1); }

// A fake engine: returns a word for every row of whatever image it is given,
// but FAILS outright for images whose tag matches the fail predicate.
function makeCtx(failTags) {
  const logs = [];
  const reads = [];
  const ctx = {
    console, Math, JSON, Object, Array, String, Number, Boolean, isFinite,
    Promise, Error, parseInt, parseFloat,
    logs, reads, failTags,
    document: { createElement: () => mkCanvas(1, 1) },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}
function mkCanvas(w, h) {
  const c = {
    width: w, height: h,
    getContext: () => ({
      fillRect() {}, drawImage() {}, save() {}, restore() {},
      translate() {}, rotate() {},
    }),
  };
  return c;
}

let pass = 0, fail = 0; const failures = [];
function ok(c, name, d) { if (c) pass++; else { fail++; failures.push(name + (d ? "\n    " + d : "")); } }

async function run(failPredicate) {
  const ctx = makeCtx();
  let boot = "";
  for (const n of CONST_NAMES) boot += "const " + n + " = " + cs[n] + ";\n";
  boot += "var __debug=false;\n";
  boot += "function catDebugOn(){return __debug;}\n";
  boot += "function catLog(tag,msg){logs.push(tag+': '+msg);}\n";
  for (const n of FN_NAMES) if (fns[n] && n !== "catDebugOn" && n !== "catLog") boot += fns[n] + "\n";

  // Stubs for everything catReadPage needs that is not under test here.
  boot += "function __mk(w,h){return {width:w,height:h,getContext:function(){return {fillRect:function(){},drawImage:function(){},save:function(){},restore:function(){},translate:function(){},rotate:function(){}};}};}\n";
  boot += `
var __failTags = ${failPredicate ? JSON.stringify(failPredicate) : "null"};
function catClean(s){ return String(s).replace(/\\s+/g," ").trim(); }
function catOcrAttemptGood(r){ return !!(r && r.words && r.words.length); }
function catOcrHealth(words,text,o){ return { chars:text.length, words:words.length, meanConf:80, healthy:words.length>0, reasons:[] }; }
function catOcrAttemptStructure(){ return { cols:1, dates:1, cells:words0.length }; }
function catOcrAttemptScore(){ return 1; }
var words0=[];
async function catOcrOnce(canvas, psm, dpi, tag){
  if(canvas.__fail || (__failTags && __failTags.some(function(t){ return String(tag).indexOf(t)>=0; })))
    throw new Error("CAT_OCR_SKIP: engine refused "+tag);
  reads.push({tag:tag, w:canvas.width, h:canvas.height});
  var ws=[];
  for(var y=0; y<canvas.height; y+=20) for(var x=0; x<canvas.width; x+=60)
    ws.push({text:"R"+(y/20)+"C"+(x/60), confidence:80, bbox:{x0:x,y0:y,x1:x+50,y1:y+16}});
  return { words:ws, text:ws.map(function(w){return w.text;}).join(" "), health:{chars:10,words:ws.length,meanConf:80,healthy:true,reasons:[]},
           structure:{cols:1,dates:1,cells:ws.length}, psm:psm, dpi:dpi, ms:1, canvas:canvas, tag:tag, score:1 };
}
globalThis.__api={ catReadPage, catOcrOnceStrips, catCropCanvas, mk:__mk, logs:logs, reads:reads };
`;
  vm.runInContext(boot, ctx);
  return ctx.__api;
}

(async () => {
  // ---- A: all strips healthy -> every strip is read ----
  {
    const api = await run(null);
    const page = api.mk(1000, 1000);
    page.__catFrame = { x: 0, y: 0, w: 1000, h: 1000, rot: 0, scale: 1, pw: 1000, ph: 1000, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
    const r = await api.catOcrOnceStrips(page, 3, 300, "strips3", 3);
    ok(api.reads.length === 3, "A all 3 strips were read", "reads=" + api.reads.length);
    ok(r.words.length > 0, "A produced words");
    ok(!r.failedStrips, "A no failed strips");
  }

  // ---- B: ONE strip fails -> the other two still produce text ----
  {
    const api = await run(["#1"]);
    const page = api.mk(1000, 1000);
    page.__catFrame = { x: 0, y: 0, w: 1000, h: 1000, rot: 0, scale: 1, pw: 1000, ph: 1000, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
    const r = await api.catOcrOnceStrips(page, 3, 300, "strips3", 3);
    ok(api.reads.length === 2, "B the two healthy strips were still read", "reads=" + api.reads.length);
    ok(r.failedStrips === 1, "B exactly one strip reported failed", "failed=" + r.failedStrips);
    ok(r.words.length > 0, "B words still returned", "words=" + r.words.length);
    ok(r.text.length > 0, "B text still returned");
  }

  // ---- C: EVERY strip fails -> no throw, zero words, all accounted for ----
  {
    const api = await run(["strips"]);
    const page = api.mk(1000, 1000);
    page.__catFrame = { x: 0, y: 0, w: 1000, h: 1000, rot: 0, scale: 1, pw: 1000, ph: 1000, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
    let threw = null, r = null;
    try { r = await api.catOcrOnceStrips(page, 3, 300, "strips3", 3); } catch (e) { threw = e; }
    ok(!threw, "C a fully failed strip sweep does not throw", threw && threw.message);
    ok(r && r.failedStrips === 3, "C all three strips accounted for", r && String(r.failedStrips));
  }

  // ---- D: catReadPage survives a failing attempt and reports uncertainty ----
  {
    const api = await run(["rot90"]);
    const page = api.mk(1000, 1000);
    page.__catFrame = { x: 0, y: 0, w: 1000, h: 1000, rot: 0, scale: 1, pw: 1000, ph: 1000, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
    const ink = { x0: 0, y0: 0, x1: 1000, y1: 1000, w: 1000, h: 1000, coverage: 0.2, samples: 1, ink: 1 };
    let threw = null, r = null;
    try { r = await api.catReadPage(page, { dpi: 300, scale: 1 }, ink, null); } catch (e) { threw = e; }
    ok(!threw, "D catReadPage does not throw when one attempt fails", threw && threw.message);
    ok(r && r.best, "D a best read still exists", r && String(r.best));
    ok(api.reads.length > 0, "D other attempts were still performed", "reads=" + api.reads.length);
  }

  // ---- E: a crop too small to read is rejected, never silently widened ----
  {
    const api = await run(null);
    const page = api.mk(1000, 1000);
    page.__catFrame = { x: 0, y: 0, w: 1000, h: 1000, rot: 0, scale: 1, pw: 1000, ph: 1000, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
    const tiny = api.catCropCanvas(page, { x0: 10, y0: 10, x1: 12, y1: 12, w: 1000, h: 1000 }, 0);
    ok(tiny === null, "E a degenerate crop returns null instead of the whole page", String(tiny));
    const good = api.catCropCanvas(page, { x0: 100, y0: 100, x1: 500, y1: 500, w: 1000, h: 1000 }, 0);
    ok(good !== null && good.width === 400 && good.height === 400, "E a real crop has the right size",
      good && (good.width + "x" + good.height));
  }

  // ---- F: the strip offset is the PADDED origin, not the requested one ----
  {
    const api = await run(null);
    const page = api.mk(1000, 1000);
    page.__catFrame = { x: 0, y: 0, w: 1000, h: 1000, rot: 0, scale: 1, pw: 1000, ph: 1000, ptW: 0, ptH: 0, pt0x: 0, pt0y: 0 };
    const box = api.catCropCanvas(page, { x0: 0, y0: 300, x1: 1000, y1: 640, w: 1000, h: 1000 }, 0.05);
    // padY = 5% of 1000 = 50, so the crop actually starts at 300-50 = 250
    ok(box.__catOffset.y === 250, "F crop origin includes the 5% padding", "y=" + box.__catOffset.y);
    ok(box.__catFrame.y === 250, "F frame origin matches the crop origin", "y=" + box.__catFrame.y);
    ok(box.height === 440, "F crop height includes the padding on both sides", "h=" + box.height);
    ok(box.__catOffset.y + box.height === 690, "F crop spans 250..690", String(box.__catOffset.y + box.height));
  }

  console.log("isolation: " + pass + " passed, " + fail + " failed");
  if (failures.length) { console.log("\nFAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})();