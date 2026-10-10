// Renders the specs in cat_corpus_specs.js into real PDFs.
//
// Why a generator instead of 17 checked-in PDFs: a generated sheet is
// reproducible, its contents sit right next to its expectation, and when a fixture
// starts failing you can change one number in a spec instead of hunting through a
// binary for whatever the college's word processor did.
//
// The output is a genuine PDF with a real text layer and real drawn rules, laid out
// the way the two real sheets in corpus/ are laid out: the date in its own column,
// the subject in the year column, and the member of staff on the row BELOW its
// subject. Long text wraps onto a second line and the row grows to fit, because
// that is what a college does and because a cell with two lines is a case the
// reader has to survive.
//
//   node cat_make_fixtures.js          writes corpus/gen/*.pdf + corpus/golden/*.json
//   node cat_make_fixtures.js --check  fails if the files on disk are stale
const fs = require("fs");
const path = require("path");
const { Pdf, textWidth } = require("./cat_pdf_writer.js");
const { SPECS, golden } = require("./cat_corpus_specs.js");

const GEN = path.join(__dirname, "corpus", "gen");
const GOLD = path.join(__dirname, "corpus", "golden");
const LEFT = 40;
const A4 = { width: 595, height: 842 };

function ordinalLabel(y) {
  return ({ 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V" })[y] || String(y);
}

// Break a line of text at word boundaries so it fits the column.
function wrap(text, size, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let cur = "";
  words.forEach((w) => {
    const t = cur ? cur + " " + w : w;
    if (cur && textWidth(t, size) > maxW) { lines.push(cur); cur = w; }
    else cur = t;
  });
  if (cur) lines.push(cur);
  return lines;
}

// Turn logical rows of {col, text, style} into a measured grid. Row heights are
// whatever the tallest cell in that row needs, which is what makes a wrapped
// subject line up with the cells beside it.
function measure(o) {
  const size = o.font || 9;
  const padX = o.padX != null ? o.padX : 7;
  const padY = o.padY != null ? o.padY : 5;
  const lineH = size * 1.32;
  const minH = o.minRowH || 0;
  const xs = [LEFT];
  o.widths.forEach((w) => { xs.push(xs[xs.length - 1] + w); });

  const rows = o.rows.map((r) => {
    const cells = [];
    let lines = 1;
    (r || []).forEach((c) => {
      if (!c || !c.text) return;
      const span = Math.max(1, c.span || 1);
      const maxW = (xs[c.col + span] - xs[c.col]) - padX * 2;
      const wrapped = wrap(c.text, size, maxW);
      lines = Math.max(lines, wrapped.length);
      cells.push({ col: c.col, span: span, style: c.style, lines: wrapped });
    });
    const h = Math.max(minH, lines * lineH + padY * 2);
    return { cells, h };
  });

  const ys = [];
  let y = o.top || 165;
  rows.forEach((r) => { ys.push(y); y += r.h; });
  ys.push(y);
  return { xs, ys, rows, cols: xs.length - 1, size, padX, padY, lineH, page: o.page };
}

/* Paint a table. `rules` may name rows whose leftmost vertical edge is NOT drawn,
   which is how both real sheets print a date that belongs to a subject and the
   staff underneath it: the horizontal rule between those two rows stops at the
   date column, so the date is visually ONE cell covering both. The reader has to
   notice that from the geometry rather than being told.
   A cell may also carry `span`, the number of columns it covers. The edges inside
   a spanned cell are simply not drawn, which is the only thing that makes a merge
   a merge - so a sheet that groups CODE / SUBJECT / STAFF under one year band can
   be printed for real, with the band drawn as one cell over three columns. */
function paint(page, m, ruled, rules) {
  function spansOf(r) {
    return (m.rows[r] ? m.rows[r].cells : []).filter((c) => (c.span || 1) > 1);
  }
  // A boundary at index c sits INSIDE a spanned cell when the span starts to its
  // left and reaches past it; that edge is then not drawn at all.
  function interior(span, c) { return span.col < c && span.col + (span.span || 1) - 1 >= c; }

  if (ruled) {
    for (let r = 0; r <= m.rows.length; r++) {
      const skip = (rules && rules.mergedLeftRows || {})[r];
      let x = skip ? m.xs[1] : m.xs[0];
      spansOf(r - 1).slice().sort((a, b) => a.col - b.col).forEach((s) => {
        const to = m.xs[s.col + (s.span || 1)];
        if (to > x) page.line(x, m.ys[r], to, m.ys[r]);
        x = Math.max(x, to);
      });
      if (m.xs[m.cols] > x) page.line(x, m.ys[r], m.xs[m.cols], m.ys[r]);
    }
    for (let c = 0; c <= m.cols; c++) {
      let r = 0;
      while (r < m.rows.length) {
        while (r < m.rows.length && spansOf(r).some((s) => interior(s, c))) r++;
        if (r >= m.rows.length) break;
        let to = r;
        while (to < m.rows.length && !spansOf(to).some((s) => interior(s, c))) to++;
        page.line(m.xs[c], m.ys[r], m.xs[c], m.ys[to]);
        r = to;
      }
    }
  }
  m.rows.forEach((row, r) => {
    row.cells.forEach((c) => {
      const span = c.span || 1;
      const x0 = m.xs[c.col], x1 = m.xs[c.col + span];
      const blockH = c.lines.length * m.lineH;
      const top = m.ys[r] + (m.ys[r + 1] - m.ys[r] - blockH) / 2;
      c.lines.forEach((line, i) => {
        const y = top + i * m.lineH;
        if (m.align === "left") {
          page.text(line, x0 + m.padX, y, {
            size: m.size, bold: c.style === "b", italic: c.style === "i",
          });
        } else {
          page.text(line, (x0 + x1) / 2, y, {
            size: m.size, align: "center", bold: c.style === "b", italic: c.style === "i",
          });
        }
      });
    });
  });
  return page;
}

// Draw the title lines onto a page the caller already created, and return the y it
// finished at. The title and the table MUST share a page: giving the title its own
// page looks fine in the code and silently splits every fixture in two.
function drawTitleOn(page, lines) {
  let y = 34;
  (lines || []).forEach((l) => {
    page.text(l.text, page.width / 2, y, {
      size: l.size || 9.5, bold: l.bold, align: "center",
    });
    y += (l.size || 9.5) + 5;
  });
  return y;
}

// ---- logical rows ----------------------------------------------------------
// A logical row is a list of {col, text, style}; a null entry is an empty cell.
// These builders turn the spec's entries into those, once per layout.

function groupEntries(entries, dates, withSessions) {
  const groups = [];
  Object.keys(dates).forEach((d) => {
    const forDate = entries.filter((e) => e.d === d);
    (withSessions ? ["FN", "AN"] : [null]).forEach((s) => {
      const mine = forDate.filter((e) => (e.session || null) === s);
      if (!mine.length) return;
      const byKey = {};
      mine.forEach((e) => {
        const k = e.y;
        byKey[k] = byKey[k] || { code: null, name: null, staff: [], nonExam: null };
        const slot = byKey[k];
        if (e.nonExam) slot.nonExam = e.nonExam;
        else { slot.code = e.code; slot.name = e.name; }
        e.staff.forEach((x) => { if (slot.staff.indexOf(x) < 0) slot.staff.push(x); });
      });
      groups.push({ dateText: withSessions ? d + "  " + s : d, byKey, session: s });
    });
  });
  return groups;
}

/* Each builder returns { rows, staffRows }. staffRows lists the logical row indices
   that hold only staff, so the caller can leave the date column's horizontal rule
   out above them and let the date span both rows. */
function rowsYearsAcross(entries, dates, years, withSessions, yearHeaders) {
  const groups = groupEntries(entries, dates, withSessions);
  const header = [{ col: 0, text: "DATE", style: "b" }].concat(years.map((y) => ({
    col: 1 + years.indexOf(y),
    text: (yearHeaders && yearHeaders[y]) || (ordinalLabel(y) + " YEAR"),
    style: "b",
  })));
  const rows = [header];
  const staffRows = [];
  groups.forEach((g) => {
    const main = [{ col: 0, text: g.dateText, style: "b" }];
    years.forEach((y) => {
      const e = g.byKey[y];
      if (!e) return;
      main.push({
        col: 1 + years.indexOf(y),
        text: e.nonExam ? e.nonExam : (e.code ? e.code + " - " + e.name : e.name),
        style: e.nonExam ? "n" : "b",
      });
    });
    rows.push(main);
    if (years.some((y) => g.byKey[y] && g.byKey[y].staff.length)) {
      staffRows.push(rows.length);
      rows.push(years.map((y) => {
        const e = g.byKey[y];
        return e && e.staff.length
          ? { col: 1 + years.indexOf(y), text: e.staff.join(" & "), style: "i" }
          : null;
      }));
    }
  });
  return { rows, staffRows };
}

function rowsSplit(entries, dates, years) {
  const groups = groupEntries(entries, dates, false);
  // The year is a band drawn ACROSS the three columns below it, which is how a real
  // sheet groups CODE / SUBJECT / STAFF. Printing it as an ordinary cell would make
  // the year apply to the code column alone and leave the name and staff unattached.
  const band = [{ col: 0, text: "DATE", span: 1, style: "b" }];
  years.forEach((y) => { band.push({ col: 1 + years.indexOf(y) * 3, text: ordinalLabel(y) + " YEAR", span: 3, style: "b" }); });
  const header = [band, [{ col: 0, text: "", style: "b" }]];
  years.forEach((y) => {
    ["CODE", "SUBJECT", "STAFF"].forEach((h, i) => {
      header[1].push({ col: 1 + years.indexOf(y) * 3 + i, text: h, style: "b" });
    });
  });
  const rows = [band, header[1]];
  groups.forEach((g) => {
    const main = [{ col: 0, text: g.dateText, style: "b" }];
    years.forEach((y) => {
      const e = g.byKey[y];
      if (!e) return;
      const base = 1 + years.indexOf(y) * 3;
      if (e.code) main.push({ col: base, text: e.code, style: "n" });
      main.push({ col: base + 1, text: e.name || "", style: e.name ? "b" : "n" });
      if (e.staff.length) {
        main.push({ col: base + 2, text: e.staff.join(" & "), style: "i" });
      }
    });
    rows.push(main);
  });
  return { rows, staffRows: [] };
}

// A date cell that spans its subject row and the staff row below it is drawn by
// leaving the horizontal rule out of the date column at that boundary.
function ruleOptions(staffRows) {
  const mergedLeftRows = {};
  (staffRows || []).forEach((r) => { mergedLeftRows[r] = true; });
  return { mergedLeftRows };
}

function rowsDatesAcross(entries, dates, years) {
  const printed = Object.keys(dates);
  const header = [{ col: 0, text: "YEAR", style: "b" }].concat(printed.map((d, i) => ({
    col: 1 + i, text: d, style: "b",
  })));
  const rows = [header];
  const staffRows = [];
  years.forEach((y) => {
    const mine = entries.filter((e) => e.y === y);
    if (!mine.length) return;
    const main = [{ col: 0, text: ordinalLabel(y) + " YEAR", style: "b" }];
    printed.forEach((d, i) => {
      const e = mine.filter((x) => x.d === d)[0];
      if (!e) return;
      main.push({
        col: 1 + i,
        text: e.nonExam ? e.nonExam : (e.code ? e.code + " - " + e.name : e.name),
        style: e.nonExam ? "n" : "b",
      });
    });
    rows.push(main);
    if (mine.some((e) => e.staff.length)) {
      staffRows.push(rows.length);
      rows.push(printed.map((d, i) => {
        const e = mine.filter((x) => x.d === d)[0];
        return e && e.staff.length ? { col: 1 + i, text: e.staff.join(" & "), style: "i" } : null;
      }));
    }
  });
  return { rows, staffRows };
}

// ---- widths ----------------------------------------------------------------
function widthsFor(spec, years) {
  const page = spec.page || A4;
  const avail = page.width - LEFT * 2;
  if (spec.widths) return fitWidths(spec.widths, avail);
  if (spec.layout === "dates-across") {
    const n = Object.keys(spec.dates).length;
    const yw = Math.round(avail * 0.2);
    return [yw].concat(Array.apply(null, { length: n }).map(() => Math.floor((avail - yw) / n)));
  }
  if (spec.layout === "years-across-split") {
    const per = Math.floor((avail - 78) / (years.length * 3));
    return [78].concat(years.map(() => [Math.round(per * 0.55), per, Math.round(per * 0.95)]).flat());
  }
  const dw = Math.min(92, Math.round(avail * 0.2));
  return [dw].concat(years.map(() => Math.floor((avail - dw) / years.length)));
}

/* A spec may state its own column widths, and a set that is too wide for the page
 * is silently fatal rather than obvious: the last column is drawn past the paper
 * edge, every horizontal rule then has an endpoint outside the page, and the reader
 * drops all of them and reports a ruled sheet as borderless. Widths are therefore
 * scaled to fit, keeping the proportions the spec asked for. */
function fitWidths(widths, avail) {
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= avail) return widths.slice();
  const k = avail / total;
  const out = widths.map((w) => Math.max(18, Math.round(w * k)));
  let over = out.reduce((a, b) => a + b, 0) - avail;
  for (let i = out.length - 1; i >= 0 && over > 0; i--) {
    const take = Math.min(over, out[i] - 18);
    if (take > 0) { out[i] -= take; over -= take; }
  }
  return out;
}

function tableOpts(spec, years, o) {
  const opt = o || {};
  return {
    page: opt.page || spec.page || A4,
    widths: opt.widths || widthsFor(opt.spec || spec, years),
    top: opt.top != null ? opt.top : (spec.top || 165),
    minRowH: opt.minRowH || spec.rows || 26,
    font: spec.font || 9,
    align: opt.align || spec.align || "center",
    padX: opt.padX,
    ruled: opt.ruled !== undefined ? opt.ruled : spec.ruled !== false,
  };
}

function buildPdf(spec) {
  const pdf = new Pdf({ title: spec.name });
  const pageSpec = spec.page || A4;
  const first = pdf.page(pageSpec);
  const titleBottom = drawTitleOn(first, spec.title);

  if (spec.layout === "dates-across") {
    const widths = widthsFor(spec, spec.years);
    const t = rowsDatesAcross(spec.entries, spec.dates, spec.years);
    paint(first, measure(Object.assign(
      tableOpts(spec, spec.years, { top: titleBottom + 24, minRowH: 26 }),
      { rows: t.rows, widths })), spec.ruled !== false, ruleOptions(t.staffRows));
    return pdf.build();
  }

  if (spec.layout === "years-across-split") {
    const widths = widthsFor(spec, spec.years);
    const t = rowsSplit(spec.entries, spec.dates, spec.years);
    paint(first, measure(Object.assign(
      tableOpts(spec, spec.years, { top: titleBottom + 24 }),
      { rows: t.rows, widths })), spec.ruled !== false);
    return pdf.build();
  }

  // The ordinary shape: DATE down the left, one column per year, staff below.
  const widths = widthsFor(spec, spec.years);
  const main = rowsYearsAcross(spec.entries, spec.dates, spec.years, !!spec.sessions, spec.yearHeaders);
  paint(first, measure(Object.assign(
    tableOpts(spec, spec.years, { top: titleBottom + 20 }),
    { rows: main.rows, widths })), spec.ruled !== false, ruleOptions(main.staffRows));

  // A second table further down the SAME page, under its own department line.
  if (spec.secondTable) {
    const t2 = spec.secondTable;
    first.text(t2.label, pageSpec.width / 2, t2.top - 24, { size: 10, bold: true, align: "center" });
    const b = rowsYearsAcross(t2.entries, spec.dates, t2.years, false, spec.yearHeaders);
    paint(first, measure({
      page: pageSpec, widths: t2.widths, top: t2.top,
      minRowH: spec.rows || 26, font: spec.font || 9, align: spec.align || "center", ruled: true,
      rows: b.rows,
    }), true, ruleOptions(b.staffRows));
  }

  // The table continuing onto page two, with its header repeated.
  if (spec.secondPage) {
    const sp = spec.secondPage;
    const p2 = pdf.page(pageSpec);
    drawTitleOn(p2, sp.title);
    const b = rowsYearsAcross(sp.entries, spec.dates, spec.years, false, spec.yearHeaders);
    paint(p2, measure({
      page: pageSpec, widths, top: sp.top || 80, minRowH: spec.rows || 30,
      font: spec.font || 9, align: spec.align || "center", ruled: true,
      rows: b.rows,
    }), true, ruleOptions(b.staffRows));
  }

  return pdf.build();
}

function main() {
  const check = process.argv.indexOf("--check") >= 0;
  if (!check) {
    fs.mkdirSync(GEN, { recursive: true });
    fs.mkdirSync(GOLD, { recursive: true });
  }
  let stale = 0;
  SPECS.forEach((spec) => {
    const buf = buildPdf(spec);
    const g = golden(spec);
    const pdfPath = path.join(GEN, spec.name + ".pdf");
    const jsonPath = path.join(GOLD, spec.name + ".json");
    const json = JSON.stringify(g, null, 2) + "\n";
    if (check) {
      const okPdf = fs.existsSync(pdfPath) && fs.readFileSync(pdfPath).equals(buf);
      const okJson = fs.existsSync(jsonPath) && fs.readFileSync(jsonPath, "utf8") === json;
      if (!okPdf || !okJson) {
        stale++;
        console.log("STALE " + spec.name + (okPdf ? " (pdf ok)" : " (pdf differs)") +
          (okJson ? "" : " (json differs)"));
      }
    } else {
      fs.writeFileSync(pdfPath, buf);
      fs.writeFileSync(jsonPath, json);
      console.log("wrote " + path.relative(__dirname, pdfPath) + " (" + buf.length + " bytes, " +
        g.exams.length + " expected exams)");
    }
  });
  if (check) {
    if (stale) {
      console.error("\n" + stale + " fixture(s) out of date. Run: node cat_make_fixtures.js");
      process.exit(1);
    }
    console.log("all " + SPECS.length + " generated fixtures match their specs");
  }
}

if (require.main === module) main();
module.exports = { buildPdf, golden, GEN, GOLD };