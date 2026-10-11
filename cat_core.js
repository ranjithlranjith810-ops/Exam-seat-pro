/* =============================================================================
 * cat_core.js — layout-independent CAT timetable reader.
 *
 * Design rule for everything in this file: NOTHING is decided by position or by
 * a fixed list of strings from one college's sheet. Every value is recognised by
 * what the content IS, located by its coordinates, and carries a confidence. A
 * value we are not sure about is returned with low confidence and left for the
 * user — it is never defaulted, guessed or filled in.
 *
 * The pipeline is a sequence of pure stages. Each one takes the previous stage's
 * output and returns plain data, so any stage can be unit tested on its own and
 * a stage's input/output can be shown in the UI ("How I read this file").
 *
 *   1  extract words   text layer or OCR -> one word-with-box shape, either way
 *   2  detect grid     drawn borders first, whitespace clustering as fallback
 *   3  find header     by keyword + geometry, never by "row 0"
 *   4  classify cells  by content into DATE / YEAR / SESSION / SUBJECT / ...
 *   5  metadata        every field with a confidence, "not found" when absent
 *   6  department      normalised -> alias -> fuzzy -> ask the user
 *   7  sections        printed -> master -> ask the user
 *   8  reconcile       every cell accounted for, nothing dropped in silence
 *
 * Runs unchanged in the browser and in Node (tests). No DOM, no network, no
 * pdf.js reference: pdf.js and the OCR engine are injected by the caller.
 * ========================================================================== */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CATCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "2.0.0";

  /* ---------------------------------------------------------------- helpers */

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : (d || 0); }
  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function push(map, k, v) { (map[k] || (map[k] = [])).push(v); }

  // Collapse every kind of whitespace (incl. NBSP and the zero-width marks some
  // publishers emit) to a single space. Case is left alone on purpose.
  function clean(s) {
    return str(s)
      .replace(/[\u00a0\u2000-\u200b\ufeff]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function upper(s) { return clean(s).toUpperCase(); }

  function uniq(a) {
    var seen = Object.create(null), out = [];
    for (var i = 0; i < a.length; i++) {
      var k = String(a[i]);
      if (!seen[k]) { seen[k] = 1; out.push(a[i]); }
    }
    return out;
  }

  function median(list) {
    var a = arr(list).filter(isNum).slice().sort(function (x, y) { return x - y; });
    if (!a.length) return 0;
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // Robust spread. A single OCR speck must not widen a whole gap measurement.
  function mad(list) {
    var med = median(list);
    return median(arr(list).map(function (v) { return Math.abs(v - med); }));
  }

  function medianAbsDev(list) { return mad(list); }

  function rangeOf(list) {
    var a = arr(list).filter(isNum);
    if (!a.length) return { min: 0, max: 0 };
    return { min: Math.min.apply(null, a), max: Math.max.apply(null, a) };
  }

  // ---- roman numerals -------------------------------------------------------
  // Values are mapped through the standard subtract-parse, so VIII (8) and IX (9)
  // are right as well as the I..IV that happen to appear most often. A bare "I" is
  // 1; "IIII" is rejected rather than guessed at.
  var ROMAN_VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

  function romanToInt(raw) {
    var s = upper(raw).replace(/[^IVXLCDM]/g, "");
    if (!s) return null;
    var total = 0, i;
    for (i = 0; i < s.length; i++) {
      var a = ROMAN_VALUES[s[i]];
      var b = i + 1 < s.length ? ROMAN_VALUES[s[i + 1]] : 0;
      if (a === undefined) return null;
      total += (b && a < b) ? -a : a;
    }
    // A canonical roman numeral has total === its own subtract-parse; this catches
    // nonsense like "IIII" or "VX".
    if (total < 1 || total > 20) return null;
    if (!/^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(s)) return null;
    return total;
  }

  var ORDINAL_WORDS = {
    FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6,
    SEVENTH: 7, EIGHTH: 8, NINTH: 9, TENTH: 10,
  };

  /* -------------------------------------------------------- confidence model */
  /* Three levels, because the UI only needs to decide "offer this for editing".
   * A numeric score rides along so callers can rank two medium values.          */

  var CONF = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

  function confidence(level, score, why) {
    return { level: level, score: isNum(score) ? Math.max(0, Math.min(1, score)) : null, why: why || "" };
  }
  function confHigh(why) { return confidence(CONF.HIGH, 1, why); }
  function confMedium(why, score) { return confidence(CONF.MEDIUM, score === undefined ? 0.6 : score, why); }
  function confLow(why) { return confidence(CONF.LOW, 0.25, why); }
  // "not found" is its own answer and must never collapse into a default.
  function confNone(why) { return { level: "none", score: 0, why: why || "not found" }; }

  function confAtLeast(c, level) {
    var rank = { none: 0, low: 1, medium: 2, high: 3 };
    return rank[str(c && c.level)] >= rank[level];
  }
  function confOk(c) { return confAtLeast(c, CONF.MEDIUM); }

  /* ==========================================================================
   * STAGE 1 — WORDS
   * One shape for both sources. Coordinates are in "reading space": origin at the
   * top-left of the page as displayed, y increasing downward, rotation already
   * applied. Every later stage works in that space and never touches the PDF's
   * y-up coordinates again.
   * ========================================================================== */

  /* Apply a pdf.js viewport transform to a point. Injected so this file needs no
   * pdf.js reference of its own; in the browser the caller passes
   * pdfjsLib.Util.transform, in tests a 4x4-ish affine multiply is plenty. */
  function makeApplier(matrix) {
    // matrix = [a,b,c,d,e,f]
    return function (x, y) {
      return [matrix[0] * x + matrix[2] * y + matrix[4],
              matrix[1] * x + matrix[3] * y + matrix[5]];
    };
  }

  /* Rough per-character advance widths, as a fraction of the font size. Only used
   * to apportion a run's measured width across the words inside it, because pdf.js
   * hands back one box per show-text operation and a timetable cell is usually one
   * such operation. Getting this within a few percent is enough to find a column
   * gutter; it is never used for anything that has to be exact. */
  var W_NARROW = "ijltIfr.,;:'|!()[]{}/\\ ";
  var W_WIDE = "mwMW@%";
  function charWeight(ch) {
    if (W_NARROW.indexOf(ch) >= 0) return 0.34;
    if (W_WIDE.indexOf(ch) >= 0) return 0.92;
    if (ch >= "0" && ch <= "9") return 0.58;
    if (ch === " ") return 0.30;
    return 0.66; // capitals and most lowercase
  }

  /* splitRun(text, x0, x1) — one measured box becomes one box per WORD, with the
   * gaps between them left empty. A code and the name printed after it therefore
   * end up as separate words with separate boxes, which is what lets the later
   * stages say "the code is at the start of this cell" instead of guessing. */
  function splitRun(text, x0, x1) {
    var s = str(text);
    if (!s) return [];
    var toks = [], i = 0;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      var start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      toks.push({ str: s.slice(start, i), start: start, end: i });
    }
    if (toks.length <= 1) return [{ text: clean(s), x0: x0, x1: x1 }];
    var total = 0, k;
    for (k = 0; k < s.length; k++) total += charWeight(s[k]) * (/\s/.test(s[k]) ? 1 : 1);
    if (total <= 0) return [{ text: clean(s), x0: x0, x1: x1 }];
    var out = [], cursor = x0, span = x1 - x0;
    for (k = 0; k < toks.length; k++) {
      var w = 0, j;
      for (j = toks[k].start; j < toks[k].end; j++) w += charWeight(s[j]);
      var adv = (w / total) * span;
      out.push({ text: clean(toks[k].str), x0: cursor, x1: cursor + adv });
      cursor += adv;
    }
    return out;
  }

  /* wordsFromPdfPage(page, opts) — the text layer, in reading space.
   * opts.matrixFn  optional (x,y)->[x,y] for rotation; default identity.
   * opts.split      true (default) to break runs into per-word boxes.          */
  function wordsFromPdfPage(page, opts) {
    var o = opts || {};
    var apply = o.matrixFn || makeApplier([1, 0, 0, -1, 0, 0]);
    var scale = num(o.scale, 1);
    var items = arr(o.textItems);
    var doSplit = o.split !== false;
    /* pdf.js names fonts "g_d0_f3" and only says "Helvetica-Oblique" once you ask
       the font object itself, so italic and bold have to come from the caller. They
       are CORROBORATION for staff, never the test, so a caller that cannot supply
       this simply gets italic=false and the honorifics carry the reading. */
    var styleOf = o.fontStyleFn || function () { return null; };
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (typeof it.str !== "string") continue;
      var text = clean(it.str);
      if (!text) continue;
      var tr = it.transform || [1, 0, 0, 1, 0, 0];
      var p = apply(tr[4], tr[5]);
      var w = num(it.width, 0) * scale;
      var h = num(it.height, 0) * scale || num(o.fontSize, 10) * scale;
      // Text set at an angle needs the rotated extent, not the unrotated one.
      var angle = Math.atan2(tr[1], tr[0]);
      var ca = Math.abs(Math.cos(angle)), sa = Math.abs(Math.sin(angle));
      var bw = w * ca + h * sa;
      var bh = w * sa + h * ca;
      var fname = (str(it.fontName) || "").toLowerCase();
      var fs = null;
      try { fs = styleOf(it.fontName); } catch (e) { fs = null; }
      var italic = !!(it.italic || (fs && fs.italic) ||
        fname.indexOf("italic") >= 0 || fname.indexOf("oblique") >= 0);
      var bold = !!(it.bold || (fs && fs.bold) ||
        fname.indexOf("bold") >= 0 || fname.indexOf("black") >= 0);
      var shared = {
        page: num(o.page, 1), font: str(it.fontName) || "",
        size: h, angle: angle, bold: bold, italic: italic,
        source: "text", conf: confHigh("text layer"),
        top: p[1], bottom: p[1] + bh,
      };
      var runs = doSplit ? splitRun(text, p[0], p[0] + bw) : [{ text: text, x0: p[0], x1: p[0] + bw }];
      for (var r = 0; r < runs.length; r++) {
        var oo = Object.assign({}, shared);
        oo.text = runs[r].text;
        oo.x0 = runs[r].x0;
        oo.x1 = Math.max(runs[r].x1, runs[r].x0 + 0.5);
        out.push(oo);
      }
    }
    for (var k = 0; k < out.length; k++) {
      out[k].cx = (out[k].x0 + out[k].x1) / 2;
      out[k].cy = (out[k].top + out[k].bottom) / 2;
    }
    return out;
  }

  /* wordsFromOcrPage(ocrResult, page, opts) — an OCR engine's output in exactly
   * the same shape, so stages 2-8 are literally the same code for a scanned page.
   * ocrResult: { words:[{text|bbox:{x0,y0,x1,y1}, confidence}] } in PIXELS of the
   * rendered page; pageBox is the pixel size so it can be scaled to points.    */
  function wordsFromOcrPage(ocrResult, pageNo, opts) {
    var o = opts || {};
    var pw = num(o.pixelWidth, 0), ph = num(o.pixelHeight, 0);
    // Page size in the same unit the boxes are in. Without it we keep pixels as-is
    // and say so, because scaling by a guessed page size would move every box.
    var unit = (pw > 0 && o.pageWidth) ? (o.pageWidth / pw) : ((ph > 0 && o.pageHeight) ? (o.pageHeight / ph) : 1);
    var src = arr(ocrResult && ocrResult.words);
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var w = src[i];
      var text = clean(w.text !== undefined ? w.text : w.str);
      if (!text) continue;
      var b = w.bbox || w.box || w;
      var x0 = num(b.x0 !== undefined ? b.x0 : b.left, NaN);
      var y0 = num(b.y0 !== undefined ? b.y0 : b.top, NaN);
      var x1 = num(b.x1 !== undefined ? b.x1 : b.right, x0);
      var y1 = num(b.y1 !== undefined ? b.y1 : b.bottom, y0);
      if (!isNum(x0) || !isNum(y0)) continue;
      out.push({
        text: text,
        x0: x0 * unit, x1: x1 * unit,
        top: y0 * unit, bottom: y1 * unit,
        page: pageNo,
        font: "", size: (y1 - y0) * unit,
        angle: 0, bold: false, italic: false,
        source: "ocr",
        // OCR's own confidence is the floor; we never raise it.
        conf: isNum(w.confidence) ? confidence(levelForPct(w.confidence), w.confidence / 100, "engine reported " + Math.round(w.confidence))
                                  : confMedium("ocr box, engine gave no score"),
      });
    }
    for (var k = 0; k < out.length; k++) {
      out[k].cx = (out[k].x0 + out[k].x1) / 2;
      out[k].cy = (out[k].top + out[k].bottom) / 2;
    }
    return out;
  }

  function levelForPct(p) {
    if (p >= 85) return CONF.HIGH;
    if (p >= 60) return CONF.MEDIUM;
    return CONF.LOW;
  }

  /* ---- page-level word surgery -------------------------------------------- */

  function pageBoxOf(words, pageNo) {
    var ws = arr(words).filter(function (w) { return w.page === pageNo; });
    var xs = rangeOf(ws.map(function (w) { return w.x0; }));
    var ys = rangeOf(ws.map(function (w) { return w.top; }));
    return { x0: xs.min, x1: xs.max, top: ys.min, bottom: ys.max };
  }

  function pagesOf(words) {
    return uniq(arr(words).map(function (w) { return w.page; })).sort(function (a, b) { return a - b; });
  }

  /* ==========================================================================
   * STAGE 2 — TABLE GRID
   * Two strategies, in order of trust:
   *   (a) drawn borders — the sheet told us where the cells are
   *   (b) whitespace/alignment clustering — the sheet did not draw them
   * Both produce the SAME cell shape, so stage 4 never knows which ran.
   * ========================================================================== */

  /* rulesFromOperators(opList, pageNo, pageBox, OPS, opts)
   * Walks a pdf.js operator list and keeps only STROKED straight segments.
   * Filled paths (a logo, a shaded band) are dropped: a border is drawn, not
   * filled.
   *
   * opts.toReading  REQUIRED in practice: the operator list is in PDF user space
   *                  (y upward) while the words are in reading space (y downward,
   *                  rotation applied). Without this the two never line up and
   *                  every rule is rejected as being in the wrong place - which
   *                  is indistinguishable, from the outside, from a sheet with no
   *                  borders at all. In the browser pass
   *                  (x, y) => pdfjsLib.Util.applyTransform([x, y], viewport.transform).
   */
  function rulesFromOperators(opList, pageNo, pageBox, OPS, opts) {
    var o = opts || {};
    var out = { h: [], v: [], page: pageNo };
    if (!opList || !OPS) return out;
    var toReading = o.toReading || null;
    var fns = arr(opList.fnArray), args = arr(opList.argsArray);
    var ctm = [1, 0, 0, 1, 0, 0], stack = [], path = null;
    /* Segments are held here until the operator that PAINTS the path arrives.
       A pdf.js operator list describes a path first (constructPath) and paints it
       afterwards (stroke, fill, ...), so the paint is the only thing that can say
       whether those straight edges are borders or the outline of a filled shape.
       Emitting at the end of constructPath would answer the question before it
       was asked, and every shaded band on the sheet would become a rule. */
    var pending = [];
    var bx0 = num(pageBox && pageBox.x0, 0), bx1 = num(pageBox && pageBox.x1, 1e9);
    var by0 = num(pageBox && pageBox.top, 0), by1 = num(pageBox && pageBox.bottom, 1e9);

    function mul(a, b) {
      return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
              a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
              a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
    }
    function xf(x, y) {
      var p = [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
      return toReading ? toReading(p[0], p[1]) : p;
    }
    function inside(p) { return p[0] >= bx0 - 4 && p[0] <= bx1 + 4 && p[1] >= by0 - 4 && p[1] <= by1 + 4; }
    function seg(a, b) {
      if (!a || !b) return;
      if (!inside(a) || !inside(b)) return;
      var dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
      var len = Math.max(dx, dy);
      var span = Math.max(bx1 - bx0, by1 - by0) || 1;
      if (len < span * num(o.minLenRatio, 0.02)) return;   // too short to be a border
      var minSide = Math.min(dx, dy);
      var tol = Math.max(1.0, span * num(o.axisTolRatio, 0.004));
      if (minSide > tol) return;                            // not straight enough
      if (dy <= tol) pending.push({ d: "h", page: pageNo, y: (a[1] + b[1]) / 2, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), len: len });
      else pending.push({ d: "v", page: pageNo, x: (a[0] + b[0]) / 2, y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]), len: len });
    }
    /* Hands the finished path to the rule list - unless the path was only FILLED.
       A college logo, a shaded header band and a highlighted cell are all drawn as
       filled outlines, and every one of their four edges is a straight line long
       enough to pass the "is this a border" test. Reading them as rules puts a
       phantom grid over the sheet, so the paint that ends the path decides: only
       a stroke draws a line. */
    function collect() { if (path && path.length > 1) for (var i = 0; i + 1 < path.length; i++) seg(path[i], path[i + 1]); path = null; }
    function flush(mode) {
      collect();
      if (mode === "fill") { pending = []; return; }
      pending.forEach(function (p) { out[p.d].push(p); });
      pending = [];
    }

    for (var i = 0; i < fns.length; i++) {
      var fn = fns[i], a = args[i];
      if (fn === OPS.save) { stack.push(ctm.slice()); continue; }
      if (fn === OPS.restore) { flush(); ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; continue; }
      if (fn === OPS.transform) { ctm = mul(a, ctm); continue; }
      if (fn === OPS.moveTo) { flush(); path = [xf(a[0], a[1])]; continue; }
      if (fn === OPS.lineTo) { if (path) path.push(xf(a[0], a[1])); continue; }
      if (fn === OPS.rectangle) { seg(xf(a[0], a[1]), xf(a[0] + a[2], a[1])); seg(xf(a[0] + a[2], a[1]), xf(a[0] + a[2], a[1] + a[3])); seg(xf(a[0] + a[2], a[1] + a[3]), xf(a[0], a[1] + a[3])); seg(xf(a[0], a[1] + a[3]), xf(a[0], a[1])); continue; }
      if (fn === OPS.constructPath) {
        flush();
        path = [];
        /* pdf.js packs constructPath as [opCodes, flatArgs, minMax]. The args are a
         * SINGLE FLAT array, not one array per op, and the ops themselves are
         * element 0 - reading element 2 (the minMax box) as the ops finds nothing
         * at all and makes a fully ruled sheet look borderless.
         *
         * Many publishers draw every rule as a filled-thin RECTANGLE instead of
         * moveTo/lineTo, so rectangle must be handled here as well: a handler that
         * only knows lineTo reports zero borders on a sheet that is ruled
         * end to end.                                                           */
        var ops = arr(a && a[0]), fa = arr(a && a[1]), cur = 0;
        function take(n) { var v = fa.slice(cur, cur + n); cur += n; return v; }
        for (var k = 0; k < ops.length; k++) {
          var o = ops[k];
          if (o === OPS.rectangle) {
            var av = (ops.length === 1 && fa.length >= 4) ? take(4) : take(4);
            // pdf.js rectangle is [x, y, width, height] with y at the TOP and a
            // negative height for a rule that runs downwards.
            var rx = av[0], ry = av[1], rw = av[2], rh = av[3];
            if (!isNum(rx) || !isNum(ry) || !isNum(rw) || !isNum(rh)) continue;
            var p0 = xf(rx, ry), p1 = xf(rx + rw, ry), p2 = xf(rx + rw, ry + rh), p3 = xf(rx, ry + rh);
            seg(p0, p1); seg(p1, p2); seg(p2, p3); seg(p3, p0);
          } else if (o === OPS.moveTo || o === OPS.lineTo) {
            var q = take(2);
            if (!isNum(q[0]) || !isNum(q[1])) continue;
            var pt = xf(q[0], q[1]);
            if (o === OPS.moveTo || !path) path = [pt]; else path.push(pt);
          } else if (o === OPS.curveTo) { var c6 = take(6); if (isNum(c6[4])) path.push(xf(c6[4], c6[5])); }
          else if (o === OPS.curveTo2) { var c4 = take(4); if (isNum(c4[2])) path.push(xf(c4[2], c4[3])); }
          else if (o === OPS.curveTo3) { var c2 = take(2); if (isNum(c2[0])) path.push(xf(c2[0], c2[1])); }
          else if (o === OPS.closePath) { /* the polyline is closed on flush */ }
        }
        /* Collected, not published: the stroke or fill that follows decides. */
        collect();
        continue;
      }
      if (fn === OPS.stroke || fn === OPS.closePath) continue;
      if (fn === OPS.endPath) { flush(); continue; }
      // Any other painting op ends the current path. A fill-only op means the
      // shape was painted, not drawn, and its outline is not a border;
      // fillStroke and its variants DO draw the outline, so they end the path
      // the ordinary way.
      if (fn === OPS.fill || fn === OPS.eoFill) { flush("fill"); continue; }
      if (fn === OPS.fillStroke || fn === OPS.eoFillStroke) { flush(); continue; }
      if (OPS.paintFormXObjectBegin !== undefined && fn === OPS.paintFormXObjectBegin) { flush(); continue; }
      if (OPS.paintFormXObjectEnd !== undefined && fn === OPS.paintFormXObjectEnd) { flush(); continue; }
      if (fn === OPS.beginText || fn === OPS.endText) { flush(); continue; }
    }
    flush();
    return out;
  }

  /* rulesFromImage(gray, w, h, opts) — the same thing for a SCANNED page, from
   * a grayscale buffer. A border is a long run of dark pixels in one row or one
   * column of the projection profile. Used only when there is no text layer, and
   * only as a hint: the clustering fallback below can work without it. */
  function rulesFromImage(gray, w, h, opts) {
    var o = opts || {};
    var out = { h: [], v: [], page: num(o.page, 1) };
    if (!gray || !w || !h) return out;
    var thr = num(o.threshold, 160);
    var minRun = num(o.minRun, Math.max(8, Math.round(Math.min(w, h) * 0.05)));
    var rowDark = new Int32Array(h), colDark = new Int32Array(w);
    for (var y = 0; y < h; y++) {
      var base = y * w;
      for (var x = 0; x < w; x++) if (gray[base + x] < thr) { rowDark[y]++; colDark[x]++; }
    }
    function runs(profile, n, emit) {
      var i = 0;
      while (i < n) {
        if (profile[i] >= minRun) {
          var j = i, best = i, bestLen = 0;
          while (j < n && profile[j] >= minRun * 0.6) {
            if (profile[j] > bestLen) { bestLen = profile[j]; best = j; }
            j++;
          }
          emit(best, bestLen);
          i = j;
        } else i++;
      }
    }
    var xs = [];
    runs(colDark, w, function (idx, len) { xs.push(idx); });
    var ys = [];
    runs(rowDark, h, function (idx, len) { ys.push(idx); });
    for (var a = 0; a < xs.length; a++) out.v.push({ page: out.page, x: xs[a], y0: 0, y1: h, len: h });
    for (var b = 0; b < ys.length; b++) out.h.push({ page: out.page, y: ys[b], x0: 0, x1: w, len: w });
    return out;
  }

  /* snapLines(lines, tol) — collapse near-parallel duplicates so a border drawn
   * twice (or a scan shadow) becomes one line. */
  function snapLines(lines, tol) {
    var t = num(tol, 2);
    var sorted = arr(lines).slice().sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      var last = out[out.length - 1];
      if (last !== undefined && sorted[i] - last <= t) continue;
      out.push(sorted[i]);
    }
    return out;
  }

  /* ---- grid from drawn borders -------------------------------------------- */

  function gridFromRules(rules, pageNo) {
    var hs = snapLines(arr(rules.h).map(function (r) { return r.y; }), 2.5);
    var vs = snapLines(arr(rules.v).map(function (r) { return r.x; }), 2.5);
    if (hs.length < 3 || vs.length < 3) return null;
    // The grid must actually span each other, otherwise these are stray marks.
    var bands = hs.length - 1, cols = vs.length - 1;
    var usableH = arr(rules.h).filter(function (r) { return r.x1 - r.x0 > (vs[vs.length - 1] - vs[0]) * 0.25; }).length;
    var usableV = arr(rules.v).filter(function (r) { return r.y1 - r.y0 > (hs[hs.length - 1] - hs[0]) * 0.15; }).length;
    if (usableH < 3 || usableV < 2) return null;
    return {
      kind: "rules",
      page: pageNo,
      xs: vs, ys: hs,
      cols: cols, bands: bands,
      conf: confHigh(hs.length + " horizontal and " + vs.length + " vertical borders found"),
    };
  }

  /* Which columns does this horizontal rule actually cross? A merged cell is
   * exactly a place where the rule that would separate two rows is MISSING. */
  /* Which grid boundaries actually carry a printed rule, per column and per row.
     This is what turns a rectangle grid into a table with real merged cells. Two
     bands with NO rule between them in a given column are ONE cell, and reading
     them as two is precisely how a date printed once across three bands turns
     into three different dates. It is also how "06.10.2026" in one band and
     "TUESDAY" in the band below it are correctly read as a single date. */
  /* One page can carry TWO timetables, and the rules of both are drawn at once, so
     gridFromRules welds them into a single grid with one enormous row in the
     middle. The seam is visible without guessing: no vertical rule crosses the
     boundary, because each table's own verticals stop where that table stops.
     A vertical that runs THROUGH a boundary is what holds a table together, so
     where none does, one table ends and the next begins. */
  function splitGridAtSeams(grid, rules) {
    if (!grid || !grid.ys || grid.ys.length < 4) return [grid];
    var eps = 0.75;
    function crossed(y) {
      return arr(rules && rules.v).some(function (r) {
        return r.y0 <= y - eps && r.y1 >= y + eps;
      });
    }
    var runs = [], cur = [0];
    for (var k = 1; k < grid.ys.length - 1; k++) {
      if (!crossed(grid.ys[k])) { runs.push(cur); cur = [k]; }
      else cur.push(k);
    }
    runs.push(cur);

    /* The band BETWEEN two tables is not itself a table: no rule is drawn inside
       it, only the bottom edge of the table above and the top edge of the one
       below. Left in, it becomes a row that swallows the second table's printed
       title, and the title is then read as the first table's next date. A run is
       real only if it has a rule of its own inside it. */
    runs = runs.filter(function (band) {
      if (band.length < 2) return false;
      var lo = grid.ys[band[0]], hi = grid.ys[band[band.length - 1] + 1];
      return arr(rules && rules.h).some(function (r) { return r.y > lo + 1 && r.y < hi - 1; });
    });
    if (runs.length < 2) return [grid];

    return runs.map(function (band) {
      var lo = band[0], hi = band[band.length - 1] + 1;
      /* Only the columns this run actually uses, so a narrow second table is not
         padded out with the first table's columns. Which columns those are comes
         from the horizontal rules inside the run: a rule that crosses most of a
         column's width is that column's boundary. */
      var used = {};
      arr(rules && rules.h).forEach(function (r) {
        if (r.y < grid.ys[lo] - 3 || r.y > grid.ys[hi] + 3) return;
        for (var c = 0; c < grid.xs.length - 1; c++) {
          var lo2 = Math.max(r.x0, grid.xs[c]), hi2 = Math.min(r.x1, grid.xs[c + 1]);
          if (hi2 - lo2 > (grid.xs[c + 1] - grid.xs[c]) * 0.4) used[c] = 1;
        }
      });
      var cols = Object.keys(used).map(Number).sort(function (a, b) { return a - b; });
      var xs = [];
      cols.forEach(function (c) { xs.push(grid.xs[c], grid.xs[c + 1]); });
      xs = xs.filter(function (x, i, a) { return i === 0 || Math.abs(x - a[i - 1]) > 0.5; });
      if (xs.length < 3) xs = grid.xs.slice();
      return {
        kind: grid.kind, page: grid.page,
        xs: xs,
        ys: grid.ys.slice(lo, hi + 1),
        cols: xs.length - 1,
        bands: hi - lo,
        seam: true,
      };
    });
  }

  function ruleSpans(rules, grid) {
    var hSpan = [], vSpan = [], i;
    for (i = 0; i < grid.ys.length; i++) hSpan.push([]);
    for (i = 0; i < grid.xs.length; i++) vSpan.push([]);

    arr(rules.h).forEach(function (r) {
      var b = nearestIndex(grid.ys, r.y, 3);
      if (b < 0) return;                       // a rule that is not on the grid
      for (var c = 0; c < grid.xs.length - 1; c++) {
        var lo = Math.max(r.x0, grid.xs[c]), hi = Math.min(r.x1, grid.xs[c + 1]);
        // Must cross MOST of the column. A rule that stops half way is a divider
        // inside the column, not a boundary of it.
        if (hi - lo > (grid.xs[c + 1] - grid.xs[c]) * 0.4) hSpan[b].push(c);
      }
    });
    arr(rules.v).forEach(function (r) {
      var b = nearestIndex(grid.xs, r.x, 3);
      if (b < 0) return;
      for (var rr = 0; rr < grid.ys.length - 1; rr++) {
        var lo = Math.max(r.y0, grid.ys[rr]), hi = Math.min(r.y1, grid.ys[rr + 1]);
        if (hi - lo > (grid.ys[rr + 1] - grid.ys[rr]) * 0.4) vSpan[b].push(rr);
      }
    });
    return { rows: hSpan, cols: vSpan };
  }

  function nearestIndex(list, v, tol) {
    var best = -1, bd = Infinity;
    for (var i = 0; i < list.length; i++) {
      var d = Math.abs(list[i] - v);
      if (d < bd) { bd = d; best = i; }
    }
    return bd <= num(tol, 3) ? best : -1;
  }

  /* ---- grid from whitespace (borderless sheets) --------------------------- */

  /* Projection-profile gap detection. A column boundary is a vertical strip that
   * NO word crosses. This uses the words' own geometry, so it adapts to any font,
   * size or column width without a single tuned constant per layout. */
  function clusterColumns(words, opts) {
    var o = opts || {};
    var ws = arr(words);
    if (ws.length < 4) return null;
    var b = o.box || { x0: Math.min.apply(null, ws.map(function (w) { return w.x0; })),
                       x1: Math.max.apply(null, ws.map(function (w) { return w.x1; })) };
    var W = b.x1 - b.x0;
    var bins = num(o.bins, Math.max(120, Math.round(W / 2)));
    var step = W / bins;
    var cover = new Float64Array(bins);
    for (var i = 0; i < ws.length; i++) {
      var a = Math.max(0, Math.floor((ws[i].x0 - b.x0) / step));
      var z = Math.min(bins - 1, Math.ceil((ws[i].x1 - b.x0) / step));
      for (var k = a; k <= z; k++) cover[k] += 1;
    }
    // How much crossing does a gap need? Relative to the busiest bin, so a sparse
    // sheet is not judged by an absolute number tuned for a dense one.
    var peak = Math.max.apply(null, Array.from(cover));
    var need = Math.max(1, peak * num(o.coverRatio, 0.02));
    var boundaries = [b.x0];
    var k2 = 0;
    while (k2 < bins) {
      if (cover[k2] > need) { k2++; continue; }
      var start = k2;
      while (k2 < bins && cover[k2] <= need) k2++;
      var gapW = (k2 - start) * step;
      // A boundary needs a real gutter. Measured in units of the typical WORD
      // width, because that scales with font size and column width alike.
      var wordW = median(ws.map(function (w) { return w.x1 - w.x0; })) || 1;
      if (gapW >= Math.max(wordW * 0.8, 3)) {
        boundaries.push(b.x0 + ((start + k2) / 2) * step);
      }
    }
    boundaries.push(b.x1);
    var merged = [];
    for (var m = 0; m < boundaries.length; m++) {
      if (!merged.length || boundaries[m] - merged[merged.length - 1] > 1) merged.push(boundaries[m]);
    }
    if (merged.length < 3) return null;
    return { xs: merged, conf: confidence(CONF.MEDIUM, 0.55, "columns inferred from " + (merged.length - 2) + " whitespace gutters") };
  }

  function clusterRows(words, opts) {
    var o = opts || {};
    var ws = arr(words);
    if (ws.length < 4) return null;
    var b = o.box || { top: Math.min.apply(null, ws.map(function (w) { return w.top; })),
                       bottom: Math.max.apply(null, ws.map(function (w) { return w.bottom; })) };
    var H = b.bottom - b.top;
    var bins = num(o.bins, Math.max(80, Math.round(H / 2)));
    var step = H / bins;
    var cover = new Float64Array(bins);
    for (var i = 0; i < ws.length; i++) {
      var a = Math.max(0, Math.floor((ws[i].top - b.top) / step));
      var z = Math.min(bins - 1, Math.ceil((ws[i].bottom - b.top) / step));
      for (var k = a; k <= z; k++) cover[k] += 1;
    }
    // Merge overlapping word boxes into text LINES first, then find the gutters
    // between lines. Without this a two-line wrapped subject reads as two rows.
    var lines = mergeLines(ws);
    var cuts = [];
    for (var L = 1; L < lines.length; L++) {
      var gap = lines[L].top - lines[L - 1].bottom;
      var lineH = median(lines.map(function (l) { return l.bottom - l.top; })) || 1;
      if (gap > lineH * num(o.rowGapRatio, 0.35)) cuts.push((lines[L - 1].bottom + lines[L].top) / 2);
    }
    var ys = [b.top].concat(cuts, [b.bottom]);
    if (ys.length < 3) return null;
    return { ys: ys, lines: lines, conf: confidence(CONF.MEDIUM, 0.55, "rows inferred from " + (ys.length - 2) + " vertical gaps") };
  }

  /* mergeLines — union-find over vertically overlapping boxes. Two boxes are on
   * the same printed line when they overlap vertically by more than half the
   * smaller height. This is what stops a wrapped name becoming two rows, and it
   * is also what stops two columns of the same row from being confused. */
  function mergeLines(words) {
    var ws = arr(words).slice().sort(function (a, b) { return a.top - b.top || a.x0 - b.x0; });
    var out = [], cur = null;
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i];
      /* Words from different pages are never on the same printed line, whatever
         their coordinates say. Sorting by top alone puts page two's words among
         page one's, and a banner on page two merges into the college name at the
         top of page one: "Mother Theresa CONTINUED Engineering College". */
      if (cur && w.page != null && cur.page != null && w.page !== cur.page) { out.push(cur); cur = null; }
      if (!cur) { cur = { top: w.top, bottom: w.bottom, items: [w], page: w.page }; continue; }
      var ov = Math.min(cur.bottom, w.bottom) - Math.max(cur.top, w.top);
      var minH = Math.min(cur.bottom - cur.top, w.bottom - w.top);
      // Overlap OR a small step: superscripts and italic descenders sit slightly
      // apart but still belong to the same line.
      if (ov > minH * 0.35 || (w.top - cur.bottom < minH * 0.45 && ov > 0)) {
        cur.top = Math.min(cur.top, w.top); cur.bottom = Math.max(cur.bottom, w.bottom); cur.items.push(w);
      } else { out.push(cur); cur = { top: w.top, bottom: w.bottom, items: [w] }; }
    }
    if (cur) out.push(cur);
    return out.map(function (l, idx) {
      var items = l.items.slice().sort(function (a, b) { return a.x0 - b.x0; });
      l.index = idx; l.items = items;
      l.x0 = items[0].x0; l.x1 = items[items.length - 1].x1;
      l.text = items.map(function (w) { return w.text; }).join(" ");
      return l;
    });
  }

  /* cellsFromGrid(grid, words, opts) — the cell list, plus which cells MERGE.
   * A cell spans from one rule to the next; whether a rule is missing between two
   * bands in a given column is recorded per column, because that is precisely
   * what a merged cell is. */
  /* cellsFromGrid — the table is materialised as the CELLS the rules describe, not
   as every rectangle the grid lines cross. Two bands with no rule between them in
   a column become one cell whose words are gathered from both, which is what
   joins "06.10.2026" and "TUESDAY" into a single date and stops a merged date
   from being read once per band. */
  function cellsFromGrid(grid, words, opts) {
    var o = opts || {};
    var spans = o.spans || null;
    var bands = grid.bands, cols = grid.cols, ws = arr(words);
    var region = {}, order = [], covered = {};

    for (var r = 0; r < bands; r++) {
      for (var c = 0; c < cols; c++) {
        if (covered[r + ":" + c]) continue;
        var rs = 1, cs = 1;
        if (spans) {
          while (r + rs < bands && (spans.rows[r + rs] || []).indexOf(c) < 0) rs++;
          while (c + cs < cols && (spans.cols[c + cs] || []).indexOf(r) < 0) cs++;
        }
        region[r + ":" + c] = { row: r, col: c, rowSpan: rs, colSpan: cs };
        order.push(r + ":" + c);
        for (var a = 0; a < rs; a++) {
          for (var b = 0; b < cs; b++) if (a || b) covered[(r + a) + ":" + (c + b)] = true;
        }
      }
    }

    var cells = order.map(function (key) {
      var g = region[key];
      var x0 = grid.xs[g.col], x1 = grid.xs[g.col + g.colSpan];
      var top = grid.ys[g.row], bottom = grid.ys[g.row + g.rowSpan];
      var inside = ws.filter(function (w) {
        return w.cx >= x0 - 0.5 && w.cx <= x1 + 0.5 && w.cy >= top - 0.5 && w.cy <= bottom + 0.5;
      }).sort(function (a, b) { return (a.top - b.top) || (a.x0 - b.x0); });
      return {
        row: g.row, col: g.col, rowSpan: g.rowSpan, colSpan: g.colSpan, page: grid.page,
        x0: x0, x1: x1, top: top, bottom: bottom,
        words: inside,
        text: inside.map(function (w) { return w.text; }).join(" "),
        /* A cell is styled, not styled-ish: one stray non-italic word (a subject
           code typed upright inside an otherwise italic name) must not veto the
           signal. */
        italic: inside.length > 0 && inside.every(function (w) { return w.italic; }),
        bold: inside.length > 0 && inside.every(function (w) { return w.bold; }),
        empty: inside.length === 0,
      };
    });

    if (spans) {
      cells.forEach(function (cc) {
        cc.ruleAbove = (spans.rows[cc.row] || []).indexOf(cc.col) >= 0;
        cc.ruleBelow = (spans.rows[cc.row + cc.rowSpan] || []).indexOf(cc.col) >= 0;
        cc.ruleLeft = (spans.cols[cc.col] || []).indexOf(cc.row) >= 0;
        cc.ruleRight = (spans.cols[cc.col + cc.colSpan] || []).indexOf(cc.row) >= 0;
      });
    }
    return cells;
  }

  /* cellsFromClusters — the borderless equivalent. Cells are the rectangles where
   * the column and row cluster boundaries cross, so downstream code is identical. */
  function cellsFromClusters(cols, rows, words, pageNo, opts) {
    var o = opts || {};
    var cells = [];
    /* Column membership is decided by a word's LEFT edge, not its middle. A long
       subject name runs out of its own column and into the next one; its middle
       then lands in the neighbour and the whole paper moves to the wrong year. Its
       left edge is where the cell's text starts, and that is the edge that belongs
       to the column it was printed in. */
    var useLeft = o.assign === "left";
    for (var r = 0; r + 1 < rows.ys.length; r++) {
      for (var c = 0; c + 1 < cols.xs.length; c++) {
        var x0 = cols.xs[c], x1 = cols.xs[c + 1], top = rows.ys[r], bottom = rows.ys[r + 1];
        var inside = arr(words).filter(function (w) {
          var px = useLeft ? w.x0 : w.cx;
          return px >= x0 && px < x1 && w.cy >= top && w.cy < bottom;
        }).sort(function (a, b) { return (a.top - b.top) || (a.x0 - b.x0); });
        cells.push({
          row: r, col: c, page: pageNo,
          x0: x0, x1: x1, top: top, bottom: bottom,
          words: inside,
          text: inside.map(function (w) { return w.text; }).join(" "),
          italic: inside.length > 0 && inside.every(function (w) { return w.italic; }),
          bold: inside.length > 0 && inside.every(function (w) { return w.bold; }),
          empty: inside.length === 0,
          mergedDown: false, mergedUp: false,
        });
      }
    }
    return cells;
  }

  /* The column boundaries of a sheet with no rules, taken from the header line.
     A borderless sheet cannot be read by looking for whitespace gutters between
     the columns: two year columns of similar subject names leave no gutter at all
     between them, so a gutter projection reports one column where the paper has
     three and every paper lands in the same cell.
     The header, however, always knows: "DATE | II YEAR | III YEAR" prints each
     column's name centred over that column, so the gaps BETWEEN those names mark
     the boundaries. Each group of header words is one column label, the midpoint
     between neighbouring labels is the boundary, and the sheet's own columns fall
     where its header says they do. */
  function headerSeedColumns(words, opts) {
    var o = opts || {};
    var lines = mergeLines(arr(words));
    var best = null;
    lines.forEach(function (l) {
      var hits = l.items.filter(function (w) { return matchHeaderToken(w.text); });
      if (hits.length < 2) return;
      var score = hits.length;
      if (!best || score > best.score) best = { line: l, score: score };
    });
    if (!best) return null;

    var items = best.line.items.slice().sort(function (a, b) { return a.x0 - b.x0; });
    var gaps = [];
    for (var i = 1; i < items.length; i++) gaps.push(items[i].x0 - items[i - 1].x1);
    /* Labels are separated by real space; the words inside one label are not. The
       gaps on a header line therefore come in two sizes - nothing at all between
       "II" and "YEAR", a wide jump between one column name and the next - so a
       boundary is a gap in the upper half of the range. Neither the median nor
       the smallest gap will find it: with half the gaps at zero the median sits
       halfway across the sheet and hides every boundary, and when every non-zero
       gap IS a boundary, the smallest one is a boundary too and using it as the
       threshold rejects them all. */
    var maxGap = gaps.length ? Math.max.apply(null, gaps) : 0;
    var minGap = Math.max(num(o.minLabelGap, 10), maxGap * 0.25);
    var groups = [], cur = [items[0]];
    for (var j = 1; j < items.length; j++) {
      if (items[j].x0 - items[j - 1].x1 > minGap) { groups.push(cur); cur = []; }
      cur.push(items[j]);
    }
    groups.push(cur);
    if (groups.length < 2) return null;

    var centres = groups.map(function (g) {
      return (g[0].x0 + g[g.length - 1].x1) / 2;
    });
    var xs = [];
    for (var k = 1; k < centres.length; k++) {
      var mid = (centres[k - 1] + centres[k]) / 2;
      if (!xs.length || mid - xs[xs.length - 1] > 1) xs.push(mid);
    }
    if (xs.length < 1) return null;
    return {
      xs: xs,
      conf: confidence(CONF.HIGH, 0.8, "columns taken from the " + groups.length +
        " column names printed on the header line"),
      labels: groups.map(function (g) { return g.map(function (w) { return w.text; }).join(" "); }),
      headerTop: best.line.top,
      headerBottom: best.line.bottom,
    };
  }

  /* Which table does a cell belong to? A page may carry several. Tables are split
   * where there is a vertical gap much larger than the sheet's own row rhythm. */
  function splitTables(cells, opts) {
    var o = opts || {};
    var byRow = {};
    arr(cells).forEach(function (c) { (byRow[c.row] || (byRow[c.row] = [])).push(c); });
    var rows = Object.keys(byRow).map(Number).sort(function (a, b) { return a - b; });
    if (!rows.length) return [];
    var heights = rows.map(function (r) {
      var cs = byRow[r];
      return cs[0].bottom - cs[0].top;
    });
    var med = median(heights) || 1;
    var gapMul = num(o.tableGapRatio, 2.2);
    var groups = [], cur = [rows[0]];
    for (var i = 1; i < rows.length; i++) {
      var prev = byRow[rows[i - 1]][0], cur0 = byRow[rows[i]][0];
      var gap = cur0.top - prev.bottom;
      if (gap > med * gapMul && cur.length >= 2) { groups.push(cur); cur = [rows[i]]; }
      else cur.push(rows[i]);
    }
    groups.push(cur);
    var out = [];
    for (var g = 0; g < groups.length; g++) {
      var set = {};
      groups[g].forEach(function (r) { set[r] = 1; });
      var mine = arr(cells).filter(function (c) { return set[c.row]; });
      if (!mine.length) continue;
      var colSet = {};
      mine.forEach(function (c) {
        for (var k = 0; k < num(c.colSpan, 1); k++) colSet[c.col + k] = 1;
      });
      out.push({
        cells: mine,
        x0: Math.min.apply(null, mine.map(function (c) { return c.x0; })),
        x1: Math.max.apply(null, mine.map(function (c) { return c.x1; })),
        top: Math.min.apply(null, mine.map(function (c) { return c.top; })),
        bottom: Math.max.apply(null, mine.map(function (c) { return c.bottom; })),
        y0: Math.min.apply(null, mine.map(function (c) { return c.top; })),
        y1: Math.max.apply(null, mine.map(function (c) { return c.bottom; })),
        rows: groups[g].length,
        cols: Object.keys(colSet).length,
      });
    }
    return out;
  }

  /* Is a header row repeated on the next page? That is the signal that a table
   * CONTINUES rather than restarting, so page 2's repeated header is skipped. */
  function detectRepeatedHeader(tableText, nextTableText, opts) {
    var o = opts || {};
    var min = num(o.minTokens, 2);
    var a = new Set(headerTokens(upper(tableText)));
    var b = headerTokens(upper(nextTableText));
    var shared = b.filter(function (t) { return a.has(t); });
    return { repeated: shared.length >= min, shared: shared };
  }

  function headerTokens(s) {
    var KNOWN = ["DATE", "DAY", "SESSION", "FN", "AN", "YEAR", "SEM", "SEMESTER",
                 "SUBJECT", "TIME", "SL", "SNO", "NO"];
    var found = [];
    KNOWN.forEach(function (k) { if (s.indexOf(k) >= 0) found.push(k); });
    return uniq(found);
  }

  /* ==========================================================================
   * STAGE 3 — HEADER AND ORIENTATION
   * The header is found by asking every cell what it IS, never by assuming it is
   * row 0. A sheet with a logo and three lines of title above the table has no
   * header on row 0, and a landscape sheet may carry its header down the left.
   * ========================================================================== */

  /* The vocabulary is data, not code, so a college can add its own terms without
   * touching this file. Nothing here decides an exam - it only decides which band
   * is the header. */
  var HEADER_TERMS = {
    rowStart: ["DATE", "DAY", "SL", "SL.NO", "SNO", "NO", "DATE/TIME"],
    year: ["YEAR", "SEM", "SEMESTER"],
    session: ["SESSION", "FN", "AN"],
    content: ["SUBJECT", "CODE", "STAFF", "FACULTY"],
  };
  var HEADER_TOKENS = (function () {
    var out = {};
    Object.keys(HEADER_TERMS).forEach(function (k) {
      arr(HEADER_TERMS[k]).forEach(function (t) { out[t.toUpperCase()] = k; });
    });
    return out;
  })();

  /* matchHeaderToken(text) — a header word counts only as a WHOLE word, so
   * "MANDATE" is not "AN" and "SEMESTER" is not read as "SEM" plus junk. */
  function matchHeaderToken(text) {
    var toks = upper(text).split(/[^A-Z0-9./]+/).filter(Boolean);
    for (var i = 0; i < toks.length; i++) {
      var role = HEADER_TOKENS[toks[i]];
      if (role) return { token: toks[i], role: role };
    }
    return null;
  }

  /* findHeader(cells) — score every row and every column for header vocabulary
   * and take the strongest. Returns WHICH axis won, because that is what decides
   * the orientation. */
  function findHeader(cells, opts) {
    var o = opts || {};
    var cs = arr(cells).filter(function (c) { return !c.empty; });
    if (!cs.length) return null;
    var minHits = num(o.minHits, 2);
    var byRow = {}, byCol = {};

    cs.forEach(function (c) {
      var m = matchHeaderToken(c.text);
      if (!m) return;
      /* A cell that prints a date is never a header, even when it also prints a
         header word. "06.10.2026 FN" is a date with a session appended, and
         counting its FN as a header hit is what made one sheet look like a
         session axis and lose its year columns entirely. */
      if (parseDate(c.text, {})) return;
      if (!byRow[c.row]) byRow[c.row] = { hits: [], cells: [] };
      byRow[c.row].hits.push(m.token); byRow[c.row].cells.push(c);
      if (!byCol[c.col]) byCol[c.col] = { hits: [], cells: [] };
      byCol[c.col].hits.push(m.token); byCol[c.col].cells.push(c);
    });

    function best(map) {
      var out = null;
      Object.keys(map).forEach(function (k) {
        var e = map[k];
        if (e.hits.length < minHits) return;
        var distinct = uniq(e.hits).length;
        /* Score by DISTINCT header words. Counting repeats rewards a column of data
           that happens to repeat the same labels ("CODE", "SUBJECT", "STAFF") over
           the one row that actually names the table, which is how a real header
           loses to a column of contents. */
        var score = distinct;
        if (!out || score > out.score) {
          out = { index: Number(k), score: score, hits: e.hits, cells: e.cells, distinct: distinct };
        }
      });
      return out;
    }
    var rowWin = best(byRow), colWin = best(byCol);
    if (!rowWin && !colWin) {
      /* A sheet whose header band is nothing but DATES - the dates run across the
         top and each one heads a column. There are no header words to find, so the
         band is the topmost run of dated cells, and it is reported as inferred so
         the review screen can say the axis was read from the dates themselves. */
      var dateRows = {}, dateCols = {};
      cs.forEach(function (c) {
        if (!parseDate(c.text, {})) return;
        (dateRows[c.row] || (dateRows[c.row] = [])).push(c);
        (dateCols[c.col] || (dateCols[c.col] = [])).push(c);
      });
      function dateBand(map) {
        var out = null;
        Object.keys(map).forEach(function (k) {
          var list = map[k];
          if (out || list.length < 2) return;
          out = { index: Number(k), score: list.length, hits: ["DATE"], cells: list, distinct: 1, inferred: true };
        });
        return out;
      }
      rowWin = dateBand(dateRows);
      colWin = dateBand(dateCols);
      if (!rowWin && !colWin) return null;
    }

    var yTop = Math.min.apply(null, cs.map(function (c) { return c.top; }));
    var yBot = Math.max.apply(null, cs.map(function (c) { return c.bottom; }));
    var xLeft = Math.min.apply(null, cs.map(function (c) { return c.x0; }));
    var xRight = Math.max.apply(null, cs.map(function (c) { return c.x1; }));
    var axis;
    if (rowWin && colWin) {
      /* Both bands name as many different things as each other, so the decision is
         which one sits nearer the top-left corner. Both offsets are measured from
         the sheet's own edge and divided by the sheet's own extent, or the two
         numbers are not comparable at all: an absolute top divided by a height and
         an absolute left divided by a width put the top row and the left column
         "far apart" purely because a page is taller than it is wide. */
      var rowPos = (rowWin.cells[0].top - yTop) / Math.max(1, yBot - yTop);
      var colPos = (colWin.cells[0].x0 - xLeft) / Math.max(1, xRight - xLeft);
      axis = rowWin.score !== colWin.score
        ? (rowWin.score > colWin.score ? "row" : "col")
        : (rowPos <= colPos ? "row" : "col");
    } else axis = rowWin ? "row" : "col";

    var win = axis === "row" ? rowWin : colWin;
    var hits = uniq(win.hits);

    /* A second header row directly above the one that won, when it also names
       things. Real sheets print the year band above the CODE / SUBJECT / STAFF
       sub-header, and each row alone is only half the story. */
    var index2 = null;
    if (axis === "row") {
      var above = byRow[win.index - 1];
      if (above && uniq(above.hits).length >= 2) index2 = win.index - 1;
    }

    return {
      axis: axis, index: win.index, index2: index2, hits: hits, cells: win.cells,
      inferred: !!win.inferred,
      conf: win.inferred
        ? confMedium("no header words on this sheet; the axis was read from the dates themselves")
        : confHigh("header words " + hits.join(", ") + " all fall on " + axis + " " + win.index),
    };
  }

  /* detectOrientation(header, cells) — dates can run down a column or across a
   * row. The answer follows from what the header cells actually ARE: a row of
   * years means the dates run down the side. */
  function detectOrientation(header, cells) {
    if (!header) return { mode: "unknown", datesAxis: null, conf: confNone("no header band was found") };
    /* A sheet that groups CODE / SUBJECT / STAFF under a year prints TWO header
       rows: the year band above, the column names below. Both are header, and
       both are read - judging the orientation from the sub-header alone finds
       neither the years nor the dates. */
    var rowBands = uniq([header.index].concat(header.index2 != null ? [header.index2] : []));
    var axisCells = arr(cells).filter(function (c) {
      if (c.empty) return false;
      return header.axis === "row"
        ? rowBands.indexOf(c.row) >= 0
        : c.col === header.index;
    });
    if (!axisCells.length) return { mode: "unknown", datesAxis: null, conf: confNone("the header band has no text") };
    var kinds = axisCells.map(function (c) { return classifyCell(c, {}).type; });
    function count(t) { return kinds.filter(function (k) { return k === t; }).length; }
    var nDate = count("DATE"), nYear = count("YEAR_LABEL"), nSess = count("SESSION");

    /* Only the structural kinds vote. The sub-header row of a two-tier header is a
       run of ordinary words - CODE, SUBJECT, STAFF - and letting them into the
       count drowns out the two year labels they sit under. */
    var structural = nDate + nYear + nSess;
    if (!structural) return { mode: "unknown", datesAxis: null,
             conf: confLow("the header names columns but never says where the dates are") };
    if (nYear >= nDate && nYear >= nSess) {
      return header.axis === "row"
        ? { mode: "years-across", datesAxis: "col",
            conf: confHigh("year labels run across the header, so the dates run down the side") }
        : { mode: "years-down", datesAxis: "row",
            conf: confHigh("year labels run down the side, so the dates run across the top") };
    }
    if (nDate >= nSess) {
      return header.axis === "row"
        ? { mode: "dates-across", datesAxis: "row", conf: confHigh("the header row itself carries the dates") }
        : { mode: "dates-down", datesAxis: "col", conf: confHigh("the header column itself carries the dates") };
    }
    return { mode: "sessions-across", datesAxis: "col",
             conf: confMedium("a session axis was found; the date axis is assumed beside it", 0.6) };
  }

  /* ==========================================================================
   * STAGE 4 — CLASSIFY A CELL BY WHAT IT IS
   * Nothing below looks at the cell's row or column number. Two identical cells
   * in different positions classify identically, which is what makes the reader
   * layout-independent.
   * ========================================================================== */

  var MONTHS = {
    JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, APR: 4, APRIL: 4,
    MAY: 5, JUN: 6, JUNE: 6, JUL: 7, JULY: 7, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9,
    SEPTEMBER: 9, OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11, DEC: 12, DECEMBER: 12,
  };
  var WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

  function validYmd(y, m, d) {
    if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  function iso(y, m, d) {
    return y + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;
  }

  /* pickByRange(options, range) — resolves a real ambiguity against the date
   * range printed in the title. It returns nothing unless exactly ONE candidate
   * falls inside, so the range can never talk us into a wrong answer. */
  function pickByRange(options, range) {
    if (!range || !range.from || !range.to || options.length < 2) return null;
    var hits = options.filter(function (o) { return o.iso >= range.from && o.iso <= range.to; });
    return hits.length === 1 ? hits[0] : null;
  }

  /* parseDate(text, ctx)
   * ctx.range  {from,to} ISO, used ONLY to settle a genuine day/month ambiguity.
   * ctx.month/year let a bare day column be read once the month is known.
   * Never swaps a numeric date silently: an unsettled ambiguity is returned with
   * both readings and a low confidence. */
  /* Every date-looking run of characters in a piece of text, in reading order.
     Deliberately over-eager: each candidate is then put through parseDate, which
     is the thing that decides whether it really is a date. */
  function dateTokensIn(text) {
    var up = String(text || "").toUpperCase();
    var re = new RegExp(
      "\\d{1,2}\\s*(?:" +
        "[.\\/-]\\s*\\d{1,2}\\s*[.\\/-]\\s*\\d{2,4}" +                  // 06.10.2026
        "|(?:ST|ND|RD|TH)?\\s*[-. ]?\\s*[A-Z]{3,9}\\.?\\s*[-. ]?\\s*,?\\s*\\d{2,4}" + // 06-Oct-2026
      ")" +
      "|[A-Z]{3,9}\\.?\\s*\\d{1,2}(?:ST|ND|RD|TH)?\\s*,?\\s*\\d{2,4}",     // Oct 8, 2026
      "g");
    var out = [], m;
    while ((m = re.exec(up)) !== null) {
      /* The pattern is deliberately wide so that it catches every shape a college
         might print, which also makes it catch things that merely look like one:
         "ACADEMIC YEAR 2026-27" ends with four digits after a word. Only a run
         that is a real calendar date is a date, so each candidate is confirmed
         before it is reported. */
      var tok = m[0].trim();
      if (tok && parseDate(tok, {})) out.push(tok);
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return out;
  }

  function parseDate(text, ctx) {
    var c = ctx || {};
    var s = clean(text);
    if (!s) return null;
    var up = s.toUpperCase();
    var weekday = null;
    for (var w = 0; w < WEEKDAYS.length; w++) {
      if (new RegExp("\\b" + WEEKDAYS[w].slice(0, 3) + "[A-Z]*\\b").test(up)) { weekday = WEEKDAYS[w]; break; }
    }
    var m, y, mo, d;

    // 1) numeric with a separator: 06.10.2026 / 06/10/26 / 06-10-2026
    m = up.match(/\b(\d{1,2})\s*([.\/\-])\s*(\d{1,2})\s*\2\s*(\d{2,4})\b/);
    if (m) {
      var a = Number(m[1]), b = Number(m[3]);
      y = Number(m[4]);
      if (y < 100) y += y < 70 ? 2000 : 1900;
      if (a > 12 && b <= 12) {
        d = a; mo = b;
        return mk(y, mo, d, m[0], confHigh("day first, unambiguous because " + a + " cannot be a month"));
      }
      if (b > 12 && a <= 12) {
        d = b; mo = a;
        return mk(y, mo, d, m[0], confHigh("month first, unambiguous because " + b + " cannot be a day"));
      }
      var opts = [];
      if (validYmd(y, b, a)) opts.push({ y: y, m: b, d: a, iso: iso(y, b, a), reading: "day-first" });
      if (validYmd(y, a, b)) opts.push({ y: y, m: a, d: b, iso: iso(y, a, b), reading: "month-first" });
      var settled = pickByRange(opts, c.range);
      if (settled) {
        return mk(settled.y, settled.m, settled.d, m[0],
                  confMedium("the day/month order was settled by the date range printed in the title", 0.75));
      }
      if (opts.length === 1) {
        return mk(opts[0].y, opts[0].m, opts[0].d, m[0],
                  confMedium("only one of the two orders is a real calendar date", 0.7));
      }
      // Genuinely ambiguous: keep the conventional reading, flag it, and hand the
      // user both candidates instead of hiding the choice.
      var cands = opts.map(function (o) { return o.iso + " (" + o.reading + ")"; });
      return mk(y, b, a, m[0],
                confLow("both " + a + "/" + b + " orders are real dates and the title range does not settle it: " + cands.join(" or ")),
                true, cands);
    }

    // 2) named month: "6 Oct 2026", "06th October 2026", "06-Oct-2026", "Oct 6, 2026"
    // The year may be separated by a dash as well as a space, because "06-Oct-2026"
    // is how half the colleges on earth print it.
    m = up.match(/\b(\d{1,2})(?:ST|ND|RD|TH)?\s*[-. ]?\s*([A-Z]{3,9})\.?\s*[-. ]?\s*,?\s*(\d{2,4})\b/);
    if (m && MONTHS[m[2]]) {
      y = Number(m[3]); if (y < 100) y += y < 70 ? 2000 : 1900;
      d = Number(m[1]); mo = MONTHS[m[2]];
      if (validYmd(y, mo, d)) return mk(y, mo, d, m[0], confHigh("day " + d + " " + m[2] + " " + y));
    }
    m = up.match(/\b([A-Z]{3,9})\.?\s*(\d{1,2})(?:ST|ND|RD|TH)?\s*,?\s*(\d{2,4})\b/);
    if (m && MONTHS[m[1]]) {
      y = Number(m[3]); if (y < 100) y += y < 70 ? 2000 : 1900;
      d = Number(m[2]); mo = MONTHS[m[1]];
      if (validYmd(y, mo, d)) return mk(y, mo, d, m[0], confHigh(m[1] + " " + d + " " + y));
    }

    // 3) a bare day number, only once the sheet has already told us the month.
    m = up.match(/\b(\d{1,2})(?:ST|ND|RD|TH)?\b/);
    if (m && c.month && c.year) {
      d = Number(m[1]); mo = c.month; y = c.year;
      if (validYmd(y, mo, d)) return mk(y, mo, d, m[0], confMedium("day number completed with the month from the header", 0.7));
    }
    return null;

    function mk(yy, mm, dd, raw, conf, ambiguous, candidates) {
      // A syntactically plausible but impossible date (31.02.2026) is not a date.
      // Rejecting here covers every branch at once, including the ones that look
      // unambiguous on the strength of "31 cannot be a month".
      if (!validYmd(yy, mm, dd)) return null;
      var wd = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
      var printed = weekday ? WEEKDAYS.indexOf(weekday) : -1;
      return {
        iso: iso(yy, mm, dd), year: yy, month: mm, day: dd,
        weekday: weekday, weekdayMatches: printed < 0 ? null : wd === printed,
        raw: raw, ambiguous: !!ambiguous, candidates: arr(candidates), conf: conf,
      };
    }
  }

  /* parseYearLabel — Roman and Arabic forms of the same thing both land on the
   * same number, and the printed text is kept so the user can see what was read.
   * A SEM value is NOT turned into a year: they are different things. */
  function parseYearLabel(text) {
    var s = upper(clean(text));
    if (!s) return null;
    var sem = null, year = null, how = "", conf = null;
    var mSem = s.match(/\bSEM(?:ESTER)?\b\.?\s*[:#-]?\s*([IVX]{1,5}|\d{1,2})\b/);
    if (mSem) {
      sem = numFromToken(mSem[1]);
      how = "printed after SEM";
      conf = confHigh("semester " + mSem[1]);
    }
    var mYear = s.match(/\b([IVX]{1,5}|\d{1,2})\s*(?:ST|ND|RD|TH)?\s*YEAR\b/) ||
                s.match(/\bYEAR\s*([IVX]{1,5}|\d{1,2})\b/) ||
                s.match(/\b(\d{1,2})\s*(?:ST|ND|RD|TH)\s*YEAR\b/);
    if (mYear) {
      year = numFromToken(mYear[1]);
      how = "printed beside YEAR";
      conf = confHigh("year " + mYear[1]);
    }
    if (year === null && sem === null) {
      var mOrd = s.match(/\b(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH)\b/);
      if (mOrd) { year = ORDINAL_WORDS[mOrd[1]]; how = "spelled ordinal"; conf = confMedium("year written out as " + mOrd[1], 0.8); }
    }
    if (year === null && sem === null) return null;
    return { year: year, semester: sem, raw: clean(text), how: how,
             conf: conf || confLow("weak year label") };
  }

  function numFromToken(tok) {
    var s = upper(clean(tok));
    if (/^\d{1,2}$/.test(s)) return Number(s);
    return romanToInt(s);
  }

  /* parseSessionLabel — FN/AN and their synonyms are college-specific words, so
   * the mapping arrives as data. Whole-word only: "MANY" is not "AN" and
   * "FINANCE" is not "FN". */
  var DEFAULT_SESSIONS = { FN: ["FN", "FORENOON", "MORNING"], AN: ["AN", "AFTERNOON"] };

  function parseSessionLabel(text, table) {
    var t = (table && Object.keys(table).length) ? table : DEFAULT_SESSIONS;
    // Split on whitespace and punctuation but KEEP alphanumerics intact: a college
    // that labels its sessions "P1"/"P2" must not have them shredded to "P".
    var toks = upper(clean(text)).split(/[^A-Z0-9]+/).filter(Boolean);
    if (!toks.length) return null;
    var keys = Object.keys(t);
    for (var i = 0; i < toks.length; i++) {
      for (var k = 0; k < keys.length; k++) {
        var names = arr(t[keys[k]]).map(upper);
        if (names.indexOf(toks[i]) >= 0) {
          return { session: keys[k], raw: toks[i], conf: confHigh("printed session label \"" + toks[i] + "\"") };
        }
      }
    }
    return null;
  }

/* scoreCodeToken — NOT one regex. The token is run through a small grammar and
   scored, so CS3591, CCS375, CS25C10, GE3751A, "CB 3491" and MR21CS105 are each
   read for the reason they actually match, and "Dr. S. Kavitha" is not.
   The suffix is deliberately open: some codes carry one trailing letter (GE3751A),
   some carry letter+digits (CS25C10), and some repeat the department code in the
   middle (MR21CS105). A grammar that only allows one of those silently loses the
   others. */
  function scoreCodeToken(tok) {
    var s = clean(tok);
    if (!s) return null;
    var up = s.toUpperCase();
    var m = up.match(/^([A-Z]{1,6})[ ]?(\d{1,5})(?:([A-Z]\d{0,2}|[A-Z]{1,3}\d{1,4}))?$/);
    if (!m) return null;
    var letters = m[1], digits = m[2], suffix = m[3] || "";
    var score = 0, notes = [];
    if (letters.length >= 2 && letters.length <= 4) score += 0.5;
    else score -= 0.2;
    if (digits.length >= 3) score += 0.3;
    else if (digits.length === 2) score += 0.2;
    else score -= 0.3;
    if (suffix) { score += 0.1; notes.push("has a letter/digit suffix"); }
    if (up !== s) { score -= 0.15; notes.push("mixed case"); }
    if (/\s/.test(s)) { score -= 0.05; notes.push("the printer left a space inside the code"); }
    return { code: letters + digits + suffix, score: score, notes: notes };
  }

  /* parseSubject — the code is the first thing IN THE CELL, and the name is
   * everything after it. Case is preserved exactly as printed. */
  function parseSubject(cell) {
    var words = arr(cell && cell.words);
    var text = clean(cell && cell.text);
    if (!text) return null;
    if (!words.length) return fromTokens(text.split(/\s+/));
    return fromTokens(readingOrder(words));
  }

  /* Reading order inside one cell is line by line, left to right WITHIN a line.
     Sorting by x first looks reasonable and is wrong: a subject name that wrapped
     onto two lines comes out interleaved ("Mathematics - Discrete" instead of
     "Discrete Mathematics"), and the code is then read off the middle of the
     cell. Words are grouped into lines by their vertical centre, which is what
     makes a two-line cell read the way it looks. */
  function readingOrder(words) {
    var ws = arr(words).slice().sort(function (a, b) {
      return (a.cy - b.cy) || (a.x0 - b.x0);
    });
    var lines = [];
    ws.forEach(function (w) {
      var last = lines[lines.length - 1];
      // One line height of slack absorbs the jitter in a word's centre position.
      if (last && Math.abs(w.cy - last.cy) <= Math.max(2, (w.size || 9) * 0.6)) {
        last.ws.push(w);
        last.cy = (last.cy * (last.ws.length - 1) + w.cy) / last.ws.length;
      } else {
        lines.push({ cy: w.cy, ws: [w] });
      }
    });
    var out = [];
    lines.forEach(function (l) {
      l.ws.sort(function (a, b) { return a.x0 - b.x0; }).forEach(function (w) { out.push(w.text); });
    });
    return out;
  }

  /* gluedCodeSplit — handles the "no separator" form where the code is stuck to the
   front of the name (CS3551DataStructures). Every grammar-valid prefix is tried,
   shortest first, and a split is only accepted when the REMAINDER begins like a
   real word. That is what stops the greedy grammar from reading CS3551D as the
   code and leaving "ataStructures" as the name. A run with no such split is left
   unclaimed rather than guessed. */
  function gluedCodeSplit(text) {
    var s = clean(text);
    if (s.length < 6) return null;
    var limit = Math.min(12, s.length - 2);
    for (var len = 3; len <= limit; len++) {
      var head = s.slice(0, len), tail = s.slice(len);
      if (!/^[A-Z][a-z]/.test(tail)) continue;      // remainder must start like a word
      var sc = scoreCodeToken(head);
      if (sc && sc.score >= 0.7) return { code: sc.code, name: clean(tail) };
    }
    return null;
  }

  function fromTokens(toks) {
    if (!toks.length) return null;
    var first = clean(toks[0]);

    /* A code can be printed as TWO words ("CB 3491", "CS 3551 - NAME"). Trying only
       the first word reads "CB" as a word and the subject loses its code, so the
       first two words are tried as a unit as well. Trailing punctuation is trimmed
       first, because the printer writes "3491-" with the dash glued to the digits. */
    var attempts = [{ text: first, rest: toks.slice(1) }];
    if (toks.length > 1) {
      var j1 = clean(toks[0] + " " + toks[1]).replace(/[-–—:,|/]+$/, "");
      var j2 = clean(toks[0] + toks[1]).replace(/[-–—:,|/]+$/, "");
      if (j1 !== first) attempts.push({ text: j1, rest: toks.slice(2) });
      if (j2 !== first && j2 !== j1) attempts.push({ text: j2, rest: toks.slice(2) });
    }
    for (var a = 0; a < attempts.length; a++) {
      var sc = scoreCodeToken(attempts[a].text);
      if (sc && sc.score >= 0.7) {
        var rest = attempts[a].rest;
        var separated = false;
        if (rest.length && /^[-–—:|,/]$/.test(clean(rest[0]))) { rest = rest.slice(1); separated = true; }
        var name = text2name(rest);
        var strong = separated && !/\s/.test(attempts[a].text);
        return {
          code: sc.code,
          name: name,
          conf: strong ? confHigh("code " + sc.code + " starts the cell, followed by a separator")
                       : confMedium("code-shaped leading token \"" + attempts[a].text + "\"" +
                           (sc.notes.length ? " (" + sc.notes.join(", ") + ")" : "")),
        };
      }
    }

    var glued = gluedCodeSplit(first);
    if (glued) {
      return {
        code: glued.code, name: glued.name,
        conf: confLow("the code and the name are printed with no separator: \"" + first + "\""),
      };
    }
    return { code: null, name: text2name(toks) };
  }

  function text2name(toks) {
    return clean(arr(toks).map(clean).filter(Boolean).join(" "));
  }

  /* ---- staff ---------------------------------------------------------------
   * Split on real separators only. A dot inside an initial ("S.P", "K.M.") is
   * never a split point, which is why the cut happens on & , / | and " and "
   * and nothing else. Italic type corroborates; it never decides. */
  var HONORIFICS = ["DR", "MR", "MRS", "MS", "MISS", "PROF", "ER", "ENGR", "REV",
                    "FR", "CAPT", "MSGR", "SHRI", "SMT", "SISTER", "BROTHER"];

  /* honorificOf — matches the honorific as a PREFIX of the whole string, not of the
   first space-separated word. "Dr.KM.Abubackkar" is one glued token, and taking
   the first word and deleting every non-letter turns it into "DRKMABUBACKKAR",
   which matches nothing at all. The character after the honorific must be a dot,
   a space, or the end, so "DRAFT" is not read as "DR". */
  function honorificOf(text) {
    var s = upper(clean(text));
    for (var i = 0; i < HONORIFICS.length; i++) {
      var h = HONORIFICS[i];
      if (s.indexOf(h) !== 0) continue;
      var after = s.charAt(h.length);
      if (after === "" || after === "." || after === " ") return h;
    }
    return null;
  }

  function splitStaff(text) {
    var s = clean(text);
    if (!s) return [];
    return s.split(/\s*(?:,|\band\b|&|\/|\|)\s*/i).map(clean).filter(Boolean);
  }

  function looksLikeName(part) {
    var p = clean(part);
    if (!p) return false;
    if (honorificOf(p)) return true;
    if (matchNonExam(p)) return false;          // an activity label is not a person
    var words = p.split(/\s+/);
    if (words.length < 2 || words.length > 5 || /\d/.test(p)) return false;
    // Names are not printed in all caps. A multi-word ALL-CAPS string is a label
    // ("NAAN MUDALVAN", "MODEL EXAM"), and reading it as a person is worse than
    // leaving it UNKNOWN for the user to look at.
    if (words.every(function (w) { return w === upper(w); })) return false;
    return words.every(function (w) { return /^[A-Z]/.test(w); });
  }

  function parseStaff(cell) {
    var text = clean(cell && cell.text);
    if (!text) return null;
    var parts = splitStaff(text), names = [], titled = 0;
    for (var i = 0; i < parts.length; i++) {
      if (!looksLikeName(parts[i])) continue;
      names.push(parts[i]);
      if (honorificOf(parts[i])) titled++;
    }
    if (!names.length) return null;
    var italic = !!(cell && cell.italic);
    var conf;
    if (italic && titled === names.length) conf = confHigh("italic type and all " + names.length + " names carry a title");
    else if (titled === names.length && names.length > 1) conf = confHigh(names.length + " names, each with a title");
    else if (titled > 0) conf = confMedium("some names carry a title");
    else if (italic) conf = confMedium("italic type but no titles printed");
    else conf = confLow("name-shaped text with neither a title nor italic type to corroborate it");
    return { names: names, conf: conf };
  }

  /* ---- non-exam vocabulary -------------------------------------------------
   * ACTIVITY WORDS matched as whole phrases, supplied by the caller so a college
   * can extend the list. Nothing here is tied to one particular sheet. */
  var DEFAULT_NON_EXAM = ["NAAN MUDALVAN", "LIBRARY", "HOLIDAY", "STUDY LEAVE",
                          "SPORTS", "NSS", "YOGA", "MENTORING"];

  function matchNonExam(text, vocabulary) {
    var list = arr(vocabulary && vocabulary.length ? vocabulary : DEFAULT_NON_EXAM);
    var s = upper(clean(text));
    if (!s) return null;
    for (var i = 0; i < list.length; i++) {
      var phrase = clean(list[i]);
      if (!phrase) continue;
      var esc = upper(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("(^|[^A-Z])" + esc + "([^A-Z]|$)").test(s)) {
        return { phrase: phrase, conf: confHigh("matches the non-exam activity \"" + phrase + "\"") };
      }
    }
    return null;
  }

  /* looksLikeSubjectName — the gate for a subject printed WITHOUT a code. The spec
   requires that case, but "accept any leftover text as a subject" would make the
   UNKNOWN class unreachable and quietly turn OCR debris into subjects. A subject
   name is capitalised; text with no capital letter in it is not one. */
  function looksLikeSubjectName(text, ctx) {
    var s = clean(text);
    if (!s) return false;
    var toks = s.split(/\s+/);
    if (toks.length < 2 && s.length < 4) return false;
    if (!/[A-Z]/.test(s)) return false;              // all-lowercase: not a printed name
    if (honorificOf(s)) return false;                // that is a person, handled separately
    if (matchNonExam(s, ctx && ctx.nonExam)) return false;
    if (scoreCodeToken(toks[0])) return false;       // it had a code, so not this branch
    return true;
  }

  /* ---- the classifier ------------------------------------------------------
   * Ordered by how SPECIFIC a match is, never by where the cell sits. A code is
   * the most specific thing a cell can begin with, so it is tested first; a full
   * date next; a year or session label after that. */
  function classifyCell(cell, ctx) {
    var c = ctx || {};
    var text = clean(cell && cell.text);
    if (!text) return { type: "EMPTY", conf: confHigh("no text in this cell"), cell: cell };

    var subj = parseSubject(cell);
    if (subj && subj.code) {
      return { type: "SUBJECT", code: subj.code, name: subj.name, conf: subj.conf, cell: cell,
               codeConf: subj.conf,
               nameConf: subj.name ? confHigh("everything after the code in the same cell") : confNone("no subject name printed") };
    }
    var d = parseDate(text, c);
    if (d) return { type: "DATE", date: d, conf: d.conf, cell: cell };

    var yl = parseYearLabel(text);
    if (yl) return { type: "YEAR_LABEL", year: yl.year, semester: yl.semester, conf: yl.conf, cell: cell };

    var se = parseSessionLabel(text, c.sessions);
    if (se) return { type: "SESSION", session: se.session, conf: se.conf, cell: cell };

    var ne = matchNonExam(text, c.nonExam);
    if (ne) return { type: "NON_EXAM", phrase: ne.phrase, conf: ne.conf, cell: cell };

    var st = parseStaff(cell);
    /* No code in the cell, and the text is name-shaped. "Self Study" and
     * "Aswin Vijayaraghavan" are both two capitalised words, so shape alone
     * cannot separate a subject printed without its code from a member of staff.
     * Break the tie on evidence, strongest first, and never on position:
     *   1. a title  -> person
     *   2. italic type -> person
     *   3. otherwise -> subject name, because subjects outnumber staff several
     *      times over in any timetable
     * The loser of the tie is recorded in the confidence note so the user can
     * see the choice was made rather than assumed. */
    if (st) {
      var titled = st.names.some(function (n) { return !!honorificOf(n); });
      if (titled) return { type: "STAFF", staff: st.names, conf: st.conf, cell: cell };
      if (cell.italic) return { type: "STAFF", staff: st.names, conf: st.conf, cell: cell };
      /* Both real sheets set subjects in BOLD and staff in ITALIC. Bold is therefore
         evidence for the other side of the same coin: name-shaped, no title, but
         bold -> subject printed without its code. */
      if (cell.bold && !cell.italic) {
        return { type: "SUBJECT", code: null, name: st.names.join(" "), cell: cell,
                 codeConf: confNone("no subject code printed"),
                 nameConf: confHigh("printed in the same bold type the sheet uses for subjects") };
      }
      if (subj && subj.name && looksLikeSubjectName(subj.name, c)) {
        return { type: "SUBJECT", code: null, name: subj.name,
                 conf: confMedium("name-shaped text with no code, no title and no italic type, so read as a subject name"),
                 codeConf: confNone("a subject name is printed but no code"), cell: cell };
      }
      return { type: "STAFF", staff: st.names, conf: st.conf, cell: cell };
    }

    if (subj && subj.name && looksLikeSubjectName(subj.name, c)) {
      return { type: "SUBJECT", code: null, name: subj.name, conf: confMedium("a subject name printed with no code"),
               codeConf: confNone("a subject name is printed but no code"), cell: cell };
    }
    return { type: "UNKNOWN", text: text, conf: confLow("nothing in this cell was recognised"), cell: cell };
  }

  /* ==========================================================================
   * STAGE 5 — METADATA
   * Every field is either read from the sheet or left EMPTY. There is no default
   * anywhere in this file: a default is a guess the user cannot see, and an
   * unstated guess is the thing this whole redesign exists to remove.
   * ========================================================================== */

  var MONTH_NAMES = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY",
                     "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

  /* field(out, key, value, conf) — writes only when something was actually read,
   * and records why, so the preview can show the evidence rather than a value. */
  function field(out, key, value, conf) {
    if (value === null || value === undefined || value === "" ) {
      out.missing.push(key);
      out.fields[key] = null;
      out.conf[key] = confNone("not printed on this sheet");
      return;
    }
    out.fields[key] = value;
    out.conf[key] = conf;
  }

  /* extractMeta(lines, ctx) — lines are the sheet's text lines (from stage 1),
   * ctx.range is the date range if already known. Returns {fields, conf, missing,
   * raw}. `missing` is the list the UI shows as "not on this file". */
  function extractMeta(lines, ctx) {
    var c = ctx || {};
    var out = { fields: {}, conf: {}, missing: [], raw: {} };
    var text = arr(lines).map(function (l) { return l.text || ""; }).join("\n");
    var up = text.toUpperCase();
    out.raw.lines = arr(lines).map(function (l) { return l.text || ""; });

    // Academic year: any year pair, not a hardcoded 2026-27.
    var my = up.match(/\b(19|20)\d{2}\s*[-–—]\s*(\d{2,4})\b/);
    if (my) {
      var to = Number(my[2]);
      if (my[2].length === 2) to = Number(my[1] + my[2]);
      field(out, "academicYear", Number(my[0].match(/\d{4}/)[0]) + "-" + String(to).slice(-2), confHigh("printed: " + my[0].trim()));
      out.raw.academicYear = my[0].trim();
    } else field(out, "academicYear", null);

    // Term: ODD / EVEN, with SEMESTER optional.
    var mt = up.match(/\b(ODD|EVEN)\s*SEM(?:ESTER)?\b/);
    if (mt) field(out, "term", mt[1].toLowerCase(), confHigh("printed: " + mt[0].trim()));
    else field(out, "term", null);

    // Assessment: any exam name, with its number in whatever form is printed.
    var ma = up.match(/\b(CONTINUOUS\s+ASSESSMENT\s+TEST|CAT|MODEL\s+EXAM|INTERNAL\s+ASSESSMENT|UNIT\s+TEST|END\s+SEMESTER\s+EXAM)\s*[-–—]?\s*([IVX]+|\d{1,2})?\b/);
    if (ma) {
      var num = ma[2] ? String(numFromToken(ma[2]) || ma[2]) : null;
      field(out, "assessment", clean(ma[1]).toLowerCase().replace(/\s+/g, " ") + (num ? " " + num : ""),
            confHigh("printed: " + clean(ma[0])));
      out.raw.assessment = clean(ma[0]);
    } else field(out, "assessment", null);

    // Date range: "FROM x TO y", or two dates on one line.
    var from = null, to = null, rangeSrc = null;
    var mf = up.match(/\bFROM\b([^\n]*?)\bTO\b([^\n]*)/);
    if (mf) {
      var d1 = parseDate(mf[1], {}), d2 = parseDate(mf[2], {});
      if (d1 && d2) { from = d1.iso; to = d2.iso; rangeSrc = "printed: FROM " + clean(mf[1]) + " TO " + clean(mf[2]); }
    }
    if (!from) {
      // Two dates on the SAME line, which is how a single-day sheet states its range.
      // The tokens are found by a permissive scan rather than by one date shape, so
      // a sheet that prints "06-Oct-2026 to 16-Oct-2026" is read as readily as one
      // that prints "06.10.2026 to 16.10.2026". Every candidate still has to survive
      // parseDate, so a false token is discarded rather than believed.
      arr(lines).forEach(function (l) {
        if (from) return;
        var found = dateTokensIn(l.text || "");
        if (found.length >= 2) {
          var a = parseDate(found[0], {}), b = parseDate(found[1], {});
          if (a && b) { from = a.iso; to = b.iso; rangeSrc = "two dates on one line: " + found[0] + " and " + found[1]; }
        }
      });
    }
    if (from && to && from > to) { var sw = from; from = to; to = sw; rangeSrc += " (reversed)"; }
    out.fields.dateRange = from ? { from: from, to: to } : null;
    out.conf.dateRange = from ? confHigh(rangeSrc) : confNone("no date range printed");
    if (!from) out.missing.push("dateRange");

    // Time range and the session it implies. AM/AN is college-specific, so the
    // mapping is passed in and the inference is labelled as an inference.
    var mt2 = up.match(/\b(\d{1,2}[:.]\d{2})\s*(AM|PM)?\s*(?:TO|-|–|—)\s*(\d{1,2}[:.]\d{2})\s*(AM|PM)?/);
    if (mt2) {
      field(out, "timeRange", clean(mt2[0]), confHigh("printed: " + clean(mt2[0])));
      var mer = mt2[2] || mt2[4] || null;
      if (mer) {
        var map = c.sessionFromMeridiem || { AM: "FN", PM: "AN" };
        if (map[mer.toUpperCase()]) {
          out.fields.sessionFromTime = map[mer.toUpperCase()];
          out.conf.sessionFromTime = confMedium(mer.toUpperCase() + " read as " + map[mer.toUpperCase()] + " using this college's session rule", 0.7);
        } else out.conf.sessionFromTime = confNone("no session rule configured for " + mer);
      }
    } else field(out, "timeRange", null);
    if (!out.fields.sessionFromTime) out.missing.push("sessionFromTime");

    // Semester line: kept verbatim, because "SEM: III & V" is not a single value.
    /* Semester line, kept verbatim because "SEM: III & V" is not one value. The
     VALUE is captured separately and the trailing "everything else on the line" is
     not: this sheet prints "ODD SEMESTER" and "CONTINUOUS ASSESSMENT TEST-II TIME
     TABLE (...)" on the same visual line, and a greedy match returns the whole
     title as the semester. */
    var ms = null;
    /* "SEM: III, V & VII" names the semesters; "ODD SEMESTER" merely says which
       term the sheet belongs to and names none. The first "SEM" on the page is
       almost always the one inside "ODD SEMESTER", so the labelled form is looked
       for first and the bare word is only a fallback. */
    ms = text.match(/\bSEM(?:ESTER)?\b\s*[:#-]\s*((?:[IVX]{1,5}|\d{1,2})(?:\s*(?:&|AND|,|\/)\s*(?:[IVX]{1,5}|\d{1,2}))*)/i);
    if (ms) {
      field(out, "semesterLine", clean(ms[0]), confHigh("printed verbatim"));
      field(out, "semesterValue", clean(ms[1] || ""),
        confHigh("the semesters this timetable is for, printed next to the label"));
      out.raw.semesterLine = clean(ms[0]);
      out.raw.semesterValue = clean(ms[1] || "");
    } else {
      ms = text.match(/\bSEM(?:ESTER)?\b/i);
      if (ms) {
        field(out, "semesterLine", clean(ms[0]), confMedium("the word is printed but no semester numbers are", 0.7));
        out.raw.semesterLine = clean(ms[0]);
      } else field(out, "semesterLine", null);
    }

    // College: the first substantial line that is not a label or a date.
    var college = arr(lines).map(function (l) { return clean(l.text || ""); })
      .filter(function (t) { return t.length > 12 && !/\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/.test(t) && !/SEM|^DATE$|^TIME$/i.test(t); })[0];
    field(out, "college", college || null, college ? confMedium("the first substantial line of the sheet", 0.75) : confNone("no college line found"));

    // A date range discovered later can settle an ambiguous date, so keep it.
    out.range = out.fields.dateRange;
    return out;
  }

  /* ==========================================================================
   * STAGE 6 — DEPARTMENT AND SECTION RESOLUTION
   * Four routes, tried in order, and the last one is a human: exact, alias,
   * fuzzy, manual. Fuzzy never picks a winner on its own below the threshold; it
   * returns candidates so the user chooses.
   * ========================================================================== */

  function normaliseName(s) {
    return upper(clean(s))
      .replace(/&/g, " AND ")
      .replace(/\bDEPARTMENT\s+OF\b/g, "")
      .replace(/\bBRANCH\b/g, "")
      .replace(/[^A-Z0-9]+/g, " ")
      .trim().replace(/\s+/g, " ");
  }

  function tokenSet(s) {
    var t = normaliseName(s).split(" ").filter(function (w) { return w.length > 1 && w !== "AND" && w !== "OF"; });
    var set = {};
    t.forEach(function (w) { set[w] = 1; });
    return set;
  }

  /* resolveDepartment(printed, master, opts)
   * master: [{code, name, aliases:[]}]
   * Returns {department, conf, route, candidates}. `route` is one of
   * exact / alias / fuzzy / manual / none, and is shown to the user. */
  function resolveDepartment(printed, master, opts) {
    var o = opts || {};
    var list = arr(master);
    /* The department is only out of the user's hands when it was read exactly, or
       was chosen by hand. A fuzzy guess and an unmatched name both have to be
       confirmed, and the UI needs one flag to ask about both. */
    function out(d, printedName, route, candidates, conf) {
      d.printed = printedName;
      d.route = route;
      d.candidates = candidates;
      d.conf = conf;
      d.needsConfirmation = route !== "exact" && route !== "alias" && route !== "manual";
      return d;
    }
    var raw = clean(printed);
    if (!raw) return out({ department: null, printed: "" }, "", "none", [], confNone("no department printed on this sheet"));

    if (o.manual) {
      var m = list.filter(function (d) { return d.code === o.manual; })[0];
      if (m) return out({ department: m }, raw, "manual", [], confHigh("chosen by hand"));
    }

    var want = normaliseName(raw);
    var exact = list.filter(function (d) { return normaliseName(d.name) === want; })[0];
    if (exact) return out({ department: exact }, raw, "exact", [], confHigh("the printed name matches \"" + exact.name + "\" exactly"));

    var aliased = list.filter(function (d) {
      return arr(d.aliases).some(function (a) { return normaliseName(a) === want; });
    })[0];
    if (aliased) return out({ department: aliased }, raw, "alias", [], confHigh("the printed name is a known short form of \"" + aliased.name + "\""));

    /* A college very often prints the generic tail its master's own name leaves
       out: "ARTIFICIAL INTELLIGENCE AND DATA SCIENCE ENGINEERING" against a master
       entry "Artificial Intelligence and Data Science". That is the same
       department, and the whole distinctive part of the name still has to match
       word for word - only a trailing word that names no subject is dropped - so
       this is a match, not a guess. The dropped word is named in the reason so the
       reader of the log can see what was ignored. */
    var GENERIC_TAIL = ["ENGINEERING", "TECHNOLOGY", "SCIENCES", "STUDIES"];
    var tailDropped = null;
    var printedWords = want.split(" ");
    for (var g = 0; g < GENERIC_TAIL.length; g++) {
      var tail = GENERIC_TAIL[g];
      if (printedWords.length < 3) break;
      if (printedWords[printedWords.length - 1] !== tail) continue;
      var trimmed = printedWords.slice(0, -1).join(" ");
      var near = list.filter(function (d) { return normaliseName(d.name) === trimmed; })[0];
      if (near) { tailDropped = tail; aliased = near; break; }
    }
    if (tailDropped) return out({ department: aliased }, raw, "alias", [],
      confHigh("the printed name is \"" + aliased.name + "\" with \"" + tailDropped + "\" added"));

    // Fuzzy: token overlap, then a character-level fallback for abbreviations.
    var scored = list.map(function (d) {
      var a = tokenSet(want), b = tokenSet(d.name);
      var keys = Object.keys(a), inter = 0;
      keys.forEach(function (k) { if (b[k]) inter++; });
      var jac = inter / Math.max(1, keys.length + Object.keys(b).length - inter);
      return { department: d, score: jac, reading: inter + " of " + keys.length + " words in common" };
    }).sort(function (x, y) { return y.score - x.score; });

    var threshold = num(o.fuzzyThreshold, 0.34);
    var best = scored[0];
    if (best && best.score >= threshold) {
      return out({ department: best.department }, raw, "fuzzy", scored.slice(0, 3),
        confidence(CONF.MEDIUM, Math.min(0.85, 0.5 + best.score),
          "\"" + raw + "\" is not an exact match; closest is \"" + best.department.name + "\" (" + best.reading + ") — check it"));
    }
    /* Nothing matched. The printed name is still handed back, with no code, because
       the user has to be able to SEE what the file said in order to choose a
       department - dropping it would leave them with a blank box and no clue. */
    return out({ department: { code: null, name: raw, unmatched: true } }, raw, "none", scored.slice(0, 3),
      confNone("\"" + raw + "\" matches no department closely enough to choose one (" +
        (scored.slice(0, 3).map(function (c) { return c.department.name + " " + Math.round(c.score * 100) + "%"; }).join(", ") || "no departments on file") + ") — pick one"));
  }

  /* resolveSections(printed, master, opts) — a sheet may or may not name its
   * sections. An absent section list is a fact, not a failure: many sheets are
   * single-section and must NOT be given invented sections. */
  var DEFAULT_SECTIONS = ["A", "B", "C", "D"];

  function resolveSections(printed, master, opts) {
    var o = opts || {};
    var list = arr(master && master.length ? master : DEFAULT_SECTIONS);
    var raw = clean(printed);
    var found = [];
    if (raw) {
      // A parenthesised group is the usual way sections are printed.
      var m = raw.match(/\(([^)]*)\)/);
      var scope = m ? m[1] : raw;
      scope.replace(/[A-Za-z]+/g, function (w) { return "|" + w + "|"; })
        .split("|").forEach(function (w) {
          var v = w.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
          if (v && list.indexOf(v) >= 0) found.push(v);
        });
    }
    if (!found.length) {
      return { sections: [], conf: confNone(raw ? "no section letters found in \"" + raw + "\"" : "this sheet does not name its sections"),
               needsConfirmation: !!raw, printed: raw || null };
    }
    return { sections: uniq(found), conf: confHigh("printed: " + raw), needsConfirmation: false, printed: raw };
  }

  /* ==========================================================================
   * ASSEMBLY — turning classified cells into exam rows
   * The date and the year each come from the cell that actually holds them, found
   * through the detected orientation. A merged cell serves every row or column it
   * spans, and nothing else: there is no "carry the last date down" rule, which is
   * how a date leaks onto a row that belongs to a different exam.
   * ========================================================================== */

  /* parseYearList — a column can head several years at once ("II & III YEAR",
   * "SEM III & V"). One label is not one year. */
  function parseYearList(text) {
    var s = upper(clean(text));
    if (!s) return null;
    var years = [], sems = [];
    var mSem = s.match(/\bSEM(?:ESTER)?\b\.?\s*[:#-]?([^\n]*)/);
    if (mSem) {
      String(mSem[1]).replace(/\b([IVX]{1,5})\b|\b(\d{1,2})\b/g, function (_, r, d) {
        var v = r ? romanToInt(r) : Number(d);
        if (isNum(v)) sems.push(v);
        return "";
      });
    }
    var mYear = s.match(/([IVX]{1,5}|\d{1,2})\s*(?:ST|ND|RD|TH)?\s*YEAR/g);
    if (mYear) mYear.forEach(function (t) {
      var v = numFromToken(t.replace(/\s*YEAR$/, "").trim());
      if (isNum(v)) years.push(v);
    });
    if (!years.length && !sems.length) {
      var one = parseYearLabel(text);
      if (one) { if (one.year !== null) years.push(one.year); if (one.semester !== null) sems.push(one.semester); }
    }
    if (!years.length && !sems.length) return null;
    return { years: uniq(years), semesters: uniq(sems), raw: clean(text),
             conf: confHigh("read " + (years.length ? uniq(years).join(" & ") + " year(s)" : "") +
                            (years.length && sems.length ? " and " : "") +
                            (sems.length ? uniq(sems).join(" & ") + " semester(s)" : "") + " from \"" + clean(text) + "\"") };
  }

  function coversRow(c, r) { return r >= c.row && r < c.row + num(c.rowSpan, 1); }
  function coversCol(c, col) { return col >= c.col && col < c.col + num(c.colSpan, 1); }

  /* The date that applies to a content cell, found through the axis the header
   * actually declared:
   *   - dates running DOWN a column: the date cell spans this ROW (it is a merged
   *     cell) and sits in a column to the left.
   *   - dates running ACROSS the top: the date cell spans this COLUMN and sits in
   *     a row above.
   * A span is honoured only when the cell really spans. There is deliberately no
   * "carry the last date down" rule: that rule is exactly how a date leaks onto the
   * row after the exam it belongs to. */
  function dateForCell(cells, cell, orient) {
    var down = orient.datesAxis !== "row";
    var best = null, above = null;
    arr(cells).forEach(function (c) {
      if (c.type !== "DATE" || !c.date) return;
      var shares, precedes;
      if (down) {
        shares = coversRow(c, cell.row) && c.col < cell.col;
        precedes = c.row < cell.row && c.col < cell.col;
      } else {
        shares = coversCol(c, cell.col) && c.row < cell.row;
        precedes = c.col < cell.col && c.row < cell.row;
      }
      var dist = Math.abs(c.row - cell.row) + Math.abs(c.col - cell.col);
      if (shares) {
        if (!best || dist < best.dist) best = { cell: c, dist: dist, via: "shares" };
      } else if (precedes) {
        /* The member of staff sits on the row BELOW its subject, and the date is
           printed once for the pair, so the staff row has no date cell of its own.
           The nearest date cell above it in the date column is that date: an
           intervening date would be nearer still, so this cannot carry a date
           across a boundary. Recorded as "inherited" so it shows up as lower
           confidence in review rather than looking as certain as a printed date. */
        if (!above || dist < above.dist) above = { cell: c, dist: dist, via: "above" };
      }
    });
    return best || above;
  }

  /* The year label that applies to a content cell: the one above it when the
   * years run across, or beside it when they run down. */
  function yearForCell(cells, cell, orient) {
    var yearsAcross = orient.mode === "years-across" || orient.mode === "sessions-across";
    var best = null;
    arr(cells).forEach(function (c) {
      if (c.type !== "YEAR_LABEL") return;
      var applies = yearsAcross
        ? (coversCol(c, cell.col) && c.row <= cell.row)
        : (coversRow(c, cell.row) && c.col <= cell.col);
      if (!applies) return;
      var dist = (cell.row - c.row) + (cell.col - c.col);
      if (!best || dist < best.dist) best = { cell: c, dist: dist };
    });
    if (!best) return null;
    var list = parseYearList(best.cell.text);
    if (!list) return null;
    list.cell = best.cell;
    return list;
  }

  /* The session (FN / AN) that applies to a content cell. A sheet prints it three
   ways and all three are handled here: a cell of its own, a word inside the date
   cell ("06.10.2026 FN"), or a word inside the date cell that the header calls a
   session column. When nothing is printed the cell has no session, which is not
   the same thing as having been told the session. */
  function sessionForCell(cells, cell, orient, dateCell) {
    var best = null;
    arr(cells).forEach(function (c) {
      if (c.type !== "SESSION") return;
      var shares = orient.datesAxis === "row"
        ? (coversRow(c, cell.row) && c.col < cell.col)
        : (coversCol(c, cell.col) && c.row < cell.row);
      if (!shares) return;
      var dist = Math.abs(c.row - cell.row) + Math.abs(c.col - cell.col);
      if (!best || dist < best.dist) best = { cell: c, dist: dist };
    });
    if (best) return { session: best.cell.classified.session, conf: best.cell.classified.conf, printed: true };
    var dc = dateCell || (function () {
      var f = dateForCell(cells, cell, orient);
      return f ? f.cell : null;
    })();
    if (dc) {
      var s = parseSessionLabel(dc.text, null);
      if (s) {
        return { session: s.session, conf: s.conf, printed: true };
      }
    }
    return null;
  }

  /* buildExams(tableCells, ctx) — one entry per (date, year, session) with its
   * subjects and staff. Nothing is merged across a date boundary and nothing is
   * dropped: a content cell that finds no date is reported, not hidden. */
  /* Some sheets print the code, the name and the staff in three separate columns
   instead of one "CS25C01 - Discrete Mathematics" cell. Read literally, the code
   and the name are two subjects and every exam grows a nameless extra paper. A
   code-only cell sitting immediately left of a name-only cell in the SAME row is
   one paper printed in two columns, so the two are joined here. Cells that
   already carry both are left alone, which is what stops one year's code being
   joined to the next year's name. */
  function joinSplitSubjects(list) {
    var out = [];
    arr(list).forEach(function (cl) {
      var prev = out[out.length - 1];
      var a = prev && prev.classified, b = cl && cl.classified;
      var joinable = prev && cl
        && prev.type === "SUBJECT" && cl.type === "SUBJECT"
        && prev.row === cl.row
        && cl.col === prev.col + (prev.colSpan || 1)
        && a && b
        && ((a.code && !a.name && !b.code && b.name) || (b.code && !b.name && !a.code && a.name));
      if (!joinable) { out.push(cl); return; }
      var codeSide = a.code ? a : b, nameSide = a.name ? a : b;
      var merged = Object.assign({}, prev, {
        colSpan: (prev.colSpan || 1) + (cl.colSpan || 1),
        x1: cl.x1,
        text: [codeSide.code, nameSide.name].filter(Boolean).join(" - "),
      });
      merged.classified = Object.assign({}, prev.classified, {
        code: codeSide.code, name: nameSide.name,
        codeConf: codeSide.codeConf, nameConf: nameSide.nameConf,
        raw: merged.text,
      });
      merged.date = merged.classified.date || null;
      /* Both original cells are remembered so the "every cell is accounted for"
         check still sees two cells read, not one invented one. */
      merged.sources = (prev.sources || [prev]).concat(cl.sources || [cl]);
      out[out.length - 1] = merged;
    });
    return out;
  }

  function buildExams(cells, ctx) {
    var c = ctx || {};
    var header = findHeader(cells, c.header);
    var orient = detectOrientation(header, cells);
    var classCtx = {
      range: c.range, sessions: c.sessions, nonExam: c.nonExam,
      month: c.month, year: c.year,
    };

    var classified = arr(cells).map(function (cl) {
      var k = classifyCell(cl, classCtx);
      k.cell = cl;
      cl.type = k.type;
      cl.classified = k;
      cl.date = k.date || null;
      return cl;
    });

    /* The header band is structure, not content. Without this the cell printed
       "DATE" is read as a subject called DATE and turns up as an exam. A two-tier
       header contributes BOTH of its rows: the year band is header too. */
    var headerCells = header ? arr(header.cells) : [];
    function isHeader(cl) {
      if (headerCells.indexOf(cl) >= 0) return true;
      if (!header || header.axis !== "row" || header.index2 == null) return false;
      return cl.row === header.index || cl.row === header.index2;
    }

    var contentTypes = c.contentTypes || ["SUBJECT", "NON_EXAM"];
    var contents = joinSplitSubjects(classified.filter(function (cl) { return !isHeader(cl) && contentTypes.indexOf(cl.type) >= 0; }));
    var staffCells = classified.filter(function (cl) { return !isHeader(cl) && cl.type === "STAFF"; });

    var buckets = {}, order = [], orphans = [];

function ensureBucket(dateIso, yr, dateCell, yf, via, sess) {
    /* The session is part of the key, not a label on the exam: two sittings on one
       day are two exams, and merging them would attach every morning paper to every
       afternoon one. */
    var sessKey = sess ? String(sess.session).toUpperCase() : "";
    var key = dateIso + "|" + (yr === null ? "?" : yr) + "|" + sessKey;
    if (!buckets[key]) {
      buckets[key] = {
          date: dateIso, year: yr,
          session: sess ? sess.session : null,
          sessionConf: sess ? sess.conf : confNone("no session printed for this exam"),
          dateConf: via === "above"
            ? confMedium("the date is printed for the subject row above; this row has no date of its own")
            : dateCell.classified.conf,
          dateInherited: via === "above",
          yearConf: yf ? yf.conf : confNone("no year label applies to this row or column"),
          dateAmbiguous: !!dateCell.date.ambiguous,
          dateCandidates: dateCell.date.candidates || [],
          staff: [], staffConf: confNone("no staff printed for this exam"),
          subjects: [], subjectCount: 0, nonExamCount: 0,
          cellRefs: [],
        };
        order.push(key);
      }
      return buckets[key];
    }
    function yearsFor(cl, yf) { return yf && yf.years.length ? yf.years : [null]; }

    contents.forEach(function (cl) {
      var df = dateForCell(classified, cl, orient);
      if (!df) {
        orphans.push({ cell: cl, why: "no date cell applies to this one" });
        return;
      }
      var yf = yearForCell(classified, cl, orient);
      var sess = sessionForCell(classified, cl, orient, df.cell);
      yearsFor(cl, yf).forEach(function (yr) {
        var b = ensureBucket(df.cell.date.iso, yr, df.cell, yf, df.via, sess);
        if (cl.type === "SUBJECT") {
          b.subjects.push({
            code: cl.classified.code, name: cl.classified.name,
            codeConf: cl.classified.codeConf, nameConf: cl.classified.nameConf,
            row: cl.row, col: cl.col, raw: cl.text,
          });
          b.subjectCount++;
        } else {
          b.subjects.push({ code: null, name: null, nonExam: cl.classified.phrase,
                            conf: cl.classified.conf, row: cl.row, col: cl.col, raw: cl.text });
          b.nonExamCount++;
        }
        (cl.sources || [cl]).forEach(function (src) { b.cellRefs.push(src); });
      });
    });

    /* Staff is resolved through the SAME date and year as the subjects above it,
       rather than by "the nearest staff cell in this column". The column-wide rule
       attaches every member of staff on the sheet to every single exam; resolving
       by date is what puts each person with the exam they actually teach. */
    staffCells.forEach(function (cl) {
      var df = dateForCell(classified, cl, orient);
      if (!df) {
        orphans.push({ cell: cl, why: "no date cell applies to this staff cell" });
        return;
      }
      var yf = yearForCell(classified, cl, orient);
      var sess = sessionForCell(classified, cl, orient, df.cell);
      yearsFor(cl, yf).forEach(function (yr) {
        var b = ensureBucket(df.cell.date.iso, yr, df.cell, yf, df.via, sess);
        var label = cl.classified.staff.join(" & ");
        if (b.staff.indexOf(label) < 0) {
          b.staff.push(label);
          b.staffConf = cl.classified.conf;
arr(cl.sources || [cl]).forEach(function (src) { b.cellRefs.push(src); });
        }
      });
    });

    var exams = order.map(function (k) { return buckets[k]; });
    exams.forEach(function (b) {
      b.ready = confOk(b.dateConf) && b.subjectCount > 0;
      b.reasons = [];
      if (!confOk(b.dateConf)) b.reasons.push("the date was not read confidently");
      if (!b.subjectCount) {
        b.reasons.push(b.nonExamCount
          ? "only a non-exam activity was read for this date, not a subject"
          : "no subjects were read for this date");
      }
      if (!confOk(b.yearConf)) b.reasons.push("no year label was read for this exam");
      if (!b.staff.length) b.reasons.push("no staff were printed for this exam");
    });

    return { header: header, orient: orient, cells: classified, exams: exams, orphans: orphans,
             staffCells: staffCells, sessions: classified.filter(function (x) { return x.type === "SESSION"; }) };
  }

  /* ==========================================================================
   * RECONCILIATION — the part that refuses to let a guess pass unnoticed
   * ========================================================================== */

  function reconcile(result, ctx) {
    var c = ctx || {};
    var out = { counts: {}, leftovers: [], warnings: [], ok: true };
    var all = [];
    arr(result.tables).forEach(function (t) { all = all.concat(t.cells || []); });
    var nonEmpty = all.filter(function (x) { return x.text; });

    var counts = {};
    nonEmpty.forEach(function (x) { counts[x.type] = (counts[x.type] || 0) + 1; });
    out.counts = counts;

    // 1. Every non-empty cell must be accounted for: header, an exam, or a
    //    recognised non-content cell. Anything left is shown to the user.
    var used = {};
    arr(result.tables).forEach(function (t) {
      (t.orphans || []).forEach(function (o) { used[o.cell.row + ":" + o.cell.col] = true; });
      (t.exams || []).forEach(function (b) { (b.cellRefs || []).forEach(function (cl) { used[cl.row + ":" + cl.col] = true; }); });
      (t.staffCells || []).forEach(function (s) { used[s.row + ":" + s.col] = true; });
      (t.sessions || []).forEach(function (s) { used[s.row + ":" + s.col] = true; });
      if (t.header) {
        t.header.cells.forEach(function (h) { used[h.row + ":" + h.col] = true; });
        // A two-tier header: the year band above the winning row is header as well.
        if (t.header.index2 != null && t.cells) {
          t.cells.forEach(function (cl) {
            if (cl.row === t.header.index2) used[cl.row + ":" + cl.col] = true;
          });
        }
      }
    });
    /* DATE, YEAR_LABEL and SESSION cells are STRUCTURE: they are consumed by being
       read as the date, the year and the session of an exam. Leaving them in the
       leftovers list would report "this cell belongs to no exam" about the very
       cells that gave the exams their dates. */
    var STRUCTURAL = { DATE: 1, YEAR_LABEL: 1, SESSION: 1 };
    nonEmpty.forEach(function (x) { if (STRUCTURAL[x.type]) used[x.row + ":" + x.col] = true; });

    out.leftovers = nonEmpty.filter(function (x) { return !used[x.row + ":" + x.col]; })
      .map(function (x) {
        return { row: x.row, col: x.col, page: x.page, text: x.text, type: x.type,
                 reason: x.type === "UNKNOWN"
                   ? "nothing in this cell was recognised"
                   : "this cell was read as " + x.type + " but belongs to no exam" };
      });

    // 2. Dates must sit inside the range printed in the title.
    var range = (result.meta && result.meta.fields && result.meta.fields.dateRange) || c.range || null;
    var outOfRange = [];
    arr(result.tables).forEach(function (t) {
      (t.exams || []).forEach(function (b) {
        if (range && (b.date < range.from || b.date > range.to)) {
          outOfRange.push({ date: b.date, row: b.cellRefs[0] ? b.cellRefs[0].row : null,
                            page: b.cellRefs[0] ? b.cellRefs[0].page : null });
        }
      });
    });
    if (outOfRange.length) {
      out.warnings.push({ code: "date-outside-printed-range", detail: outOfRange,
        text: outOfRange.length + " exam date(s) fall outside " + range.from + " to " + range.to +
              ", the range printed in the title. The range is reported as printed and has NOT been changed." });
    }

    // 3. The same exam twice usually means a duplicate cell, not two exams.
    var seen = {}, dupes = [];
    arr(result.tables).forEach(function (t) {
      (t.exams || []).forEach(function (b) {
        var key = b.date + "|" + b.year + "|" + b.subjects.map(function (s) { return s.code || s.nonExam; }).join(",");
        if (seen[key]) dupes.push({ date: b.date, year: b.year, page: b.cellRefs[0] && b.cellRefs[0].page });
        seen[key] = true;
      });
    });
    if (dupes.length) out.warnings.push({ code: "duplicate-exam", detail: dupes,
      text: dupes.length + " exam(s) appear more than once with identical subjects." });

    // 4. Title furniture must not have been read as a date.
    var furniture = [];
    var assess = result.meta && result.meta.fields && result.meta.fields.assessment;
    nonEmpty.forEach(function (x) {
      if (assess && x.text.toUpperCase().indexOf(String(assess).toUpperCase()) >= 0) {
        furniture.push({ row: x.row, col: x.col, page: x.page, text: x.text });
      }
    });
    if (furniture.length) out.warnings.push({ code: "title-text-inside-table",
      detail: furniture, text: "the exam's own title text appears inside the table; the table boundary may be wrong." });

    // 5. A summary of what still needs a human.
    var needsReview = [];
    arr(result.tables).forEach(function (t) {
      (t.exams || []).forEach(function (b) {
        if (b.reasons && b.reasons.length) needsReview.push({ date: b.date, year: b.year, reasons: b.reasons });
      });
      (t.orphans || []).forEach(function (o) { needsReview.push({ row: o.cell.row, col: o.cell.col, reasons: [o.why], text: o.cell.text }); });
    });
    out.needsReview = needsReview;

    var missingMeta = (result.meta && result.meta.missing) || [];
    if (missingMeta.length) out.warnings.push({ code: "metadata-missing", detail: missingMeta,
      text: "not printed on this file: " + missingMeta.join(", ") + ". Left blank rather than assumed." });

    out.ok = out.leftovers.length === 0 && out.warnings.length === 0;
    out.summary = {
      cells: nonEmpty.length,
      exams: arr(result.tables).reduce(function (n, t) { return n + (t.exams ? t.exams.length : 0); }, 0),
      subjects: arr(result.tables).reduce(function (n, t) {
        return n + (t.exams ? t.exams.reduce(function (m, b) { return m + b.subjectCount; }, 0) : 0);
      }, 0),
      leftovers: out.leftovers.length,
      warnings: out.warnings.length,
      needsReview: needsReview.length,
    };
    return out;
  }

  /* ==========================================================================
   * ORCHESTRATION
   * analyse() takes per-page data that has ALREADY been read out of the file
   * (words with boxes, and rules in the same reading space) and does everything
   * from there. Keeping the file-reading outside means this whole pipeline is
   * synchronous and testable without a PDF library, and the browser only has to
   * supply the two adapters in stage 1.
   * ========================================================================== */

  function analyse(pageData, opts) {
    var o = opts || {};
    var allWords = [], pageResults = [];

    arr(pageData).forEach(function (pd) {
      var words = arr(pd.words);
      allWords = allWords.concat(words);
      var box = pd.box || pageBoxOf(words, pd.page);
      var rules = pd.rules || { h: [], v: [] };
      var grid = gridFromRules(rules, pd.page);
      var grids = grid ? splitGridAtSeams(grid, rules) : [];
      var method = null, cells = [];

      if (grids.length) {
        /* Each table on the page is built from its OWN grid. Row numbers are then
           made to run on across the grids, because two grids that both start at
           row 0 hand the same row numbers to two different tables and every
           afterwards decision - which date applies, which year - reads across
           from one table into the other. */
        var rowOffset = 0;
        cells = grids.reduce(function (acc, g) {
          var mine = cellsFromGrid(g, words, { spans: ruleSpans(rules, g) });
          if (rowOffset) {
            mine.forEach(function (cl) {
              cl.rowInGrid = cl.row;
              cl.row += rowOffset;
            });
          }
          rowOffset += g.bands;
          return acc.concat(mine);
        }, []);
        method = "ruled grid";
      } else {
        // No printed rules: fall back to the whitespace and alignment of the words.
        // The header band is found first and excluded from the clustering, because
        // a centred title sitting above the table destroys any full-page column
        // projection - that is why a borderless sheet looks like one column.
        var preHeader = words.length ? findHeader(cellsFromClusters(
            { xs: [box.x0, box.x1] }, { ys: [box.top, box.bottom] }, words, pd.page), {}) : null;
        /* The header line is found BEFORE the body, and everything above it is
           title. Getting this wrong is not a small error: the title lines become
           table rows, the table's bounding box grows to the whole page, every word
           is then "inside the table", and the sheet's own title stops being
           readable as a title. */
        var seeds = headerSeedColumns(words);
        var useSeeds = seeds && seeds.xs.length >= 1;
        var bodyTop = useSeeds ? seeds.headerTop
          : (preHeader && preHeader.axis === "row"
            ? Math.max.apply(null, preHeader.cells.map(function (x) { return x.bottom; }))
            : box.top);
        var bodyWords = words.filter(function (w) { return w.bottom > bodyTop; });
        if (!bodyWords.length) bodyWords = words;
        var cols = clusterColumns(bodyWords, { box: { x0: box.x0, x1: box.x1 } });
        var rows = clusterRows(bodyWords, { box: { top: bodyTop, bottom: box.bottom } });
        /* The header's own column names are a better source of column boundaries
           than whitespace, and they are tried first. */
        var assign = useSeeds ? "left" : "centre";
        /* The seeds are the boundaries BETWEEN columns; the sheet's own left and
           right edges close the first and last of them. */
        if (useSeeds) cols = { xs: [box.x0].concat(seeds.xs, [box.x1]), conf: seeds.conf, labels: seeds.labels };
        if (cols.xs.length >= 2 && rows.ys.length >= 2) {
          cells = cellsFromClusters(cols, rows, bodyWords, pd.page, { assign: assign });
          method = useSeeds ? "header-seeded columns" : "whitespace clustering";
        }
      }

      var tables = splitTables(cells, { page: pd.page }).map(function (t) { return Object.assign(t, { method: method, page: pd.page }); });
      pageResults.push({ page: pd.page, box: box, rules: rules, grid: grid, method: method, tables: tables, cells: cells });
    });

    // Metadata is read from the words OUTSIDE every table, so a title can never be
    // mistaken for content and a subject can never be mistaken for a title.
    var tableBoxes = [];
    pageResults.forEach(function (pr) {
      pr.tables.forEach(function (t) {
        tableBoxes.push({ page: pr.page, x0: t.x0, x1: t.x1, top: t.y0, bottom: t.y1 });
      });
    });
    function insideTable(w) {
      return tableBoxes.some(function (tb) {
        return tb.page === w.page && w.x0 >= tb.x0 - 2 && w.x1 <= tb.x1 + 2 &&
               w.top >= tb.top - 2 && w.bottom <= tb.bottom + 2;
      });
    }
    var furnitureLines = mergeLines(allWords.filter(function (w) { return !insideTable(w); }));
    var meta = extractMeta(furnitureLines, o);

    // Now the date range is known, so re-run classification with it available: an
    // ambiguous 03.04 that the title settles cannot be settled afterwards.

    /* A table that runs off the bottom of one page and starts again at the top of
       the next is ONE table. The pages cannot know that on their own: page two is a
       separate set of rules with its own row and column numbers. It is joined here,
       BEFORE the exams are built, because building them separately loses the join
       anyway - row 3 of page one and row 3 of page two are different rows to every
       lookup by date, year and session.
       The evidence is the repeated header: page two printing the same column names
       the first page printed is what says "continued", not merely "another table". */
    var logical = [];
    pageResults.forEach(function (pr) {
      pr.tables.forEach(function (t) {
        var mine = findHeader(t.cells, {});
        var prev = logical[logical.length - 1];
        function maxRow(cells) {
          return cells.reduce(function (m, c) { return Math.max(m, c.row); }, -1);
        }
        var sameShape = prev && prev.cols === num(t.cols, -1);
        var continues = prev && sameShape
          && pr.page === prev.pages[prev.pages.length - 1] + 1
          && mine && prev.headerHits
          && mine.hits.some(function (h) { return prev.headerHits.indexOf(h) >= 0; });
        if (continues) {
          /* Row numbers are carried on across the page break. Page two restarts at
             row 0, and if those numbers are left alone, page two's first date row
             becomes indistinguishable from page one's first date row: the two
             sittings of one day collapse into a single exam holding every paper
             from both pages. */
          var from = maxRow(prev.cells) + 1;
          t.cells.forEach(function (cl) { cl.rowInPage = cl.row; cl.row += from; });
          prev.cells = prev.cells.concat(t.cells);
          prev.pages.push(pr.page);
          prev.boxes.push(t);
          prev.headerHits = uniq(prev.headerHits.concat(mine.hits));
          return;
        }
        logical.push({
          cells: t.cells.slice(), pages: [pr.page], boxes: [t], cols: num(t.cols, -1),
          headerHits: mine ? mine.hits.slice() : [],
          page: pr.page, method: t.method, sealed: false,
        });
      });
      /* No sealing here: two tables on the SAME page can never be one table, and
         the page-number test below already says so. A table on the next page is a
         different matter - that is exactly the continuation being looked for. */
    });

    var tables = [];
    logical.forEach(function (grp) {
        var first = grp.boxes[0];
        var built = buildExams(grp.cells, Object.assign({}, o, { range: meta.fields.dateRange }));
        var deptText = findDepartmentNear(allWords, grp.boxes[0].page, first);
        var dept = o.departments
          ? resolveDepartment(deptText, o.departments, { manual: o.manualDepartment, fuzzyThreshold: o.fuzzyThreshold })
          : { department: null, route: "none", candidates: [], conf: confNone("no department list was supplied") };
        var sect = resolveSections(first.sectionsText || findSectionTextNear(allWords, grp.boxes[0].page, first) ||
                                   sectionTextFromHeader(built.header), o.sections);
        (built.exams || []).forEach(function (b) {
          b.department = dept.department ? (dept.department.code || dept.department.name) : null;
          b.deptConf = dept.conf;
          b.sections = sect.sections;
          b.sectionsConf = sect.conf;
          /* A row is not ready while anything about it still needs a human. The old line
           here was `b.ready = b.ready && !dept.conf.level === "none" ? b.ready : b.ready`,
           which compares a boolean with a string and then hands b.ready back
           unchanged on both branches - an expression that cannot alter anything.
           It looked like a guard and guarded nothing. */
          b.blockers = b.blockers || [];
          if (dept.needsConfirmation) {
            b.blockers.push({
              field: "department", level: dept.conf.level,
              why: dept.conf.level === "none"
                ? "the department printed on this sheet does not match any department on file"
                : "the department was matched by guesswork, not printed exactly",
            });
          }
          if (!b.staff.length) {
            b.blockers.push({
              field: "staff", level: b.staffConf.level,
              why: "no member of staff is printed for this exam",
            });
          }
          if (b.sectionsConf && b.sectionsConf.level === "none" && b.sections.length === 0) {
            b.blockers.push({
              field: "sections", level: b.sectionsConf.level,
              why: "no section letters are printed for this exam",
            });
          }
          b.needsReview = b.blockers.length > 0;
          b.ready = b.ready && !b.needsReview;
        });
        tables.push(Object.assign(first, {
          cells: built.cells, exams: built.exams, orphans: built.orphans,
          header: built.header, orient: built.orient, staffCells: built.staffCells,
          sessions: built.sessions, dept: dept, deptText: deptText, sections: sect,
          method: grp.method, pages: grp.pages, continued: grp.pages.length > 1,
        }));
    });

    var result = { meta: meta, tables: tables, pages: pageResults, words: allWords };
    result.recon = reconcile(result, o);
    return result;
  }

/* The department is printed ABOVE its table. The words are searched for a
     department keyword and the nearest hit above the table wins. The NAME is then
     read word by word and stops at the next label, because on these sheets
     "DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING" shares a visual line with
     "SEM: III, V & VII" and "TIME: 9:30 AM TO 12:30 PM" - taking "the rest of the
     line" as the name swallows the whole timetable header. */
  /* Where a printed department name ends. Only words that begin a DIFFERENT field
     stop it. AND, TO, ON and FOR are deliberately NOT stop words: almost every
     real department name contains "and" - Computer Science AND Engineering,
     Electronics AND Communication Engineering, Artificial Intelligence AND Data
     Science - and stopping at it reports the department as "ELECTRONICS" or
     "COMPUTER SCIENCE", which matches no master entry and sends the user to
     confirm a name the file never printed. */
  var DEPT_STOP = /^(SEM|SEMESTER|TIME|DATE|DATES|SESSION|SHIFT|VENUE|HALL|SECTION|SECTIONS|ACADEMIC|YEAR|BRANCH|DEPT|DEPARTMENT|CAT|MODEL|EXAM|EXAMINATION|BATCH|REG|REGISTER|ROLL|ROLL\s*NO)\b/i;

  function findDepartmentNear(words, page, table) {
    var above = arr(words).filter(function (w) {
      return w.page === page && w.bottom <= table.y0 + 2 && w.top >= table.y0 - 260;
    }).sort(function (a, b) { return (a.top - b.top) || (a.x0 - b.x0); });

    for (var i = 0; i < above.length; i++) {
      var m = String(above[i].text || "").match(/^(DEPARTMENT\s+OF|BRANCH|DEPT\.?|DEPARTMENT)\s*:?\s*(.*)$/i);
      if (!m) continue;
      var parts = [];
      if (clean(m[2])) parts.push(clean(m[2]));
      for (var j = i + 1; j < above.length; j++) {
        var t = clean(above[j].text || "");
        if (!t) continue;
        // Only continue along the SAME printed line; a new line is a new label.
        if (above[j].top > above[i].top + (above[j].bottom - above[j].top) * 0.6) break;
        if (DEPT_STOP.test(t)) break;
        parts.push(t);
      }
      var name = clean(parts.join(" ")).replace(/^OF\b\s*/i, "");
      if (name) return name;
    }
    return null;
  }

  function findSectionTextNear(words, page, table) {
    var near = arr(words).filter(function (w) {
      return w.page === page && w.bottom <= table.y0 + 2 && w.top >= table.y0 - 120;
    });
    var line = mergeLines(near).map(function (l) { return l.text; }).join(" ");
    var m = line.match(/\bSEC(?:TION|TIONS)\b\s*:?\s*(\([^)]*\)|[A-Za-z0-9,& ]*)/i);
    return m ? clean(m[1]) : null;
  }

  /* Sections are often printed INSIDE the header, not above it: this sheet heads its
     columns "II YEAR (A & B)". Looking only above the table finds nothing and the
     sheet is then reported as having no sections at all. */
  function sectionTextFromHeader(header) {
    if (!header || !arr(header.cells).length) return null;
    var groups = [];
    arr(header.cells).forEach(function (c) {
      var m = String(c.text || "").match(/\(([^)]*)\)/);
      if (m) groups.push("(" + clean(m[1]) + ")");
    });
    return groups.length ? uniq(groups).join(" ") : null;
  }

  return {
    VERSION: VERSION,

    // utilities the other stages and the UI share
    clean: clean, upper: upper, uniq: uniq, median: median, mad: mad,
    romanToInt: romanToInt, ordinals: ORDINAL_WORDS,
    CONF: CONF, confidence: confidence, confHigh: confHigh, confMedium: confMedium,
    confLow: confLow, confNone: confNone, confOk: confOk, confAtLeast: confAtLeast,

    // stage 1
    wordsFromPdfPage: wordsFromPdfPage,
    wordsFromOcrPage: wordsFromOcrPage,
    pagesOf: pagesOf, pageBoxOf: pageBoxOf, mergeLines: mergeLines,

    // stage 2
    rulesFromOperators: rulesFromOperators,
    rulesFromImage: rulesFromImage,
    gridFromRules: gridFromRules,
    ruleSpans: ruleSpans,
    clusterColumns: clusterColumns,
    clusterRows: clusterRows,
    cellsFromGrid: cellsFromGrid,
    cellsFromClusters: cellsFromClusters,
    splitTables: splitTables,
    detectRepeatedHeader: detectRepeatedHeader,

    // stage 3 — header and orientation
    HEADER_TERMS: HEADER_TERMS,
    matchHeaderToken: matchHeaderToken,
    findHeader: findHeader,
    detectOrientation: detectOrientation,

    // stage 4 — cell classification
    MONTHS: MONTHS, WEEKDAYS: WEEKDAYS,
    HONORIFICS: HONORIFICS, DEFAULT_SESSIONS: DEFAULT_SESSIONS,
    DEFAULT_NON_EXAM: DEFAULT_NON_EXAM,
    validYmd: validYmd, iso: iso,
    parseDate: parseDate, dateTokensIn: dateTokensIn,
    parseYearLabel: parseYearLabel,
    parseSessionLabel: parseSessionLabel,
    scoreCodeToken: scoreCodeToken,
    parseSubject: parseSubject,
    parseStaff: parseStaff, splitStaff: splitStaff, honorificOf: honorificOf,
    matchNonExam: matchNonExam,
    classifyCell: classifyCell,
    looksLikeSubjectName: looksLikeSubjectName,
    gluedCodeSplit: gluedCodeSplit,

    // stage 5 — metadata
    MONTH_NAMES: MONTH_NAMES,
    extractMeta: extractMeta,

    // stage 6 — department and sections
    DEFAULT_SECTIONS: DEFAULT_SECTIONS,
    normaliseName: normaliseName, tokenSet: tokenSet,
    resolveDepartment: resolveDepartment,
    resolveSections: resolveSections,

    // assembly and reconciliation
    parseYearList: parseYearList,
    dateForCell: dateForCell, sessionForCell: sessionForCell, yearForCell: yearForCell,
    coversRow: coversRow, coversCol: coversCol,
    buildExams: buildExams,
    reconcile: reconcile,
    findDepartmentNear: findDepartmentNear,
    findSectionTextNear: findSectionTextNear, sectionTextFromHeader: sectionTextFromHeader,

    // orchestration
    analyse: analyse,
  };
});