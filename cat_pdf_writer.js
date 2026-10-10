// A minimal PDF writer, just enough to GENERATE test fixtures.
//
// The fixtures have to be real PDFs with a real text layer and real drawn rules,
// because the reader is supposed to work from geometry and text rather than from
// anything the fixture generator tells it directly. Writing the file here (rather
// than depending on a PDF library) also means the fixtures are byte-for-byte
// reproducible: a change in a fixture shows up as a diff, not as a re-download.
//
// Coordinates are TOP-DOWN (x from the left, y from the top) because that is how
// the layout code below thinks. The conversion to PDF's bottom-up space happens
// once, here.
//
// Real Helvetica metrics are included because column and row positions in a
// fixture are computed from text widths: with a fake constant width the generated
// sheet would not line up the way a real one does, and the reader would be tested
// against a layout that cannot occur.

// Adobe's standard Helvetica widths, units per 1000, for codes 32..126.
// Helvetica-Oblique shares them exactly, which is why italic needs no second table.
const HELV = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191, 40: 333, 41: 333,
  42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556, 56: 556, 57: 556,
  58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556, 64: 1015,
  65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778, 72: 722, 73: 278, 74: 500,
  75: 667, 76: 556, 77: 833, 78: 722, 79: 778, 80: 667, 81: 778, 82: 722, 83: 667, 84: 611,
  85: 722, 86: 667, 87: 944, 88: 667, 89: 667, 90: 611,
  91: 278, 92: 278, 93: 278, 94: 469, 95: 556, 96: 333,
  97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556, 104: 556, 105: 222,
  106: 222, 107: 500, 108: 222, 109: 833, 110: 556, 111: 556, 112: 556, 113: 556, 114: 333,
  115: 500, 116: 278, 117: 556, 118: 500, 119: 722, 120: 500, 121: 500, 122: 500,
  123: 334, 124: 260, 125: 334, 126: 584,
};
const DEFAULT_W = 556;

function charWidth(code) {
  return HELV[code] !== undefined ? HELV[code] : DEFAULT_W;
}

function textWidth(s, size) {
  let w = 0;
  for (let i = 0; i < s.length; i++) w += charWidth(s.charCodeAt(i));
  return (w * size) / 1000;
}

function escapePdf(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

class Page {
  constructor(doc, width, height) {
    this.doc = doc;
    this.width = width;
    this.height = height;
    this.ops = [];
  }
  // y here is the TOP of the text, matching the rest of the layout code.
  text(str, x, topY, o = {}) {
    const size = o.size || 9;
    // Four faces, because the fixtures have to exercise the same style evidence the
    // real sheets give: subjects and headers bold, staff italic.
    const font = o.bold && o.italic ? "F4" : o.bold ? "F3" : o.italic ? "F2" : "F1";
    const w = textWidth(String(str), size);
    let left = x;
    if (o.align === "center") left = x - w / 2;
    else if (o.align === "right") left = x - w;
    const baseline = this.height - topY - size * 0.8;
    this.ops.push(`BT /${font} ${size} Tf 1 0 0 1 ${left.toFixed(2)} ${baseline.toFixed(2)} Tm (${escapePdf(str)}) Tj ET`);
    return { x0: left, x1: left + w, top: topY, bottom: topY + size * 1.2, width: w };
  }
  line(x1, y1, x2, y2, o = {}) {
    const w = o.width || 0.6;
    const a = this.height - y1, b = this.height - y2;
    this.ops.push(`${w} w ${x1.toFixed(2)} ${a.toFixed(2)} m ${x2.toFixed(2)} ${b.toFixed(2)} l S`);
  }
  rect(x, y, w, h, o = {}) {
    // pdf.js reports a rectangle path with the top-left origin and a NEGATIVE
    // height, so the writer emits exactly that shape.
    this.ops.push(`${o.width || 0.6} w ${x.toFixed(2)} ${(this.height - y).toFixed(2)} ${w.toFixed(2)} ${(-h).toFixed(2)} re S`);
  }
  stream() {
    return this.ops.join("\n");
  }
}

class Pdf {
  constructor(o = {}) {
    this.title = o.title || "fixture";
    this.pages = [];
  }
  page(o = {}) {
    const p = new Page(this, o.width || 595, o.height || 842);
    this.pages.push(p);
    return p;
  }
  build() {
    const chunks = [];
    let len = 0;
    const offsets = [];
    const put = (s) => {
      const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "latin1");
      chunks.push(b);
      len += b.length;
    };
    const startObj = (n) => { offsets[n] = len; put(`${n} 0 obj\n`); };
    const endObj = () => put("endobj\n");

    put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    const pageNums = this.pages.map((_, i) => 4 + i * 2);
    // F1 regular, F2 oblique, F3 bold, F4 bold-oblique. All Helvetica, so all four
    // share the one width table above.
    const fontNums = [4 + this.pages.length * 2, 5 + this.pages.length * 2,
      6 + this.pages.length * 2, 7 + this.pages.length * 2];

    startObj(1); put("<< /Type /Catalog /Pages 2 0 R >>\n"); endObj();
    startObj(2);
    put(`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${this.pages.length} >>\n`);
    endObj();
    startObj(3);
    put(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n`);
    endObj();

    this.pages.forEach((p, i) => {
      const contentNum = pageNums[i] + 1;
      startObj(pageNums[i]);
      put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width} ${p.height}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 ${fontNums[1]} 0 R /F3 ${fontNums[2]} 0 R ` +
          `/F4 ${fontNums[3]} 0 R >> >> /Contents ${contentNum} 0 R >>\n`);
      endObj();
      const body = p.stream();
      startObj(contentNum);
      put(`<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream\n`);
      endObj();
    });

    startObj(fontNums[0]);
    put("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n");
    endObj();
    startObj(fontNums[1]);
    put("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>\n");
    endObj();
    startObj(fontNums[2]);
    put("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\n");
    endObj();
    startObj(fontNums[3]);
    put("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique /Encoding /WinAnsiEncoding >>\n");
    endObj();

    const count = fontNums[3] + 1;
    const xref = len;
    put(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let n = 1; n < count; n++) {
      put(String(offsets[n] || 0).padStart(10, "0") + " 00000 n \n");
    }
    put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}

module.exports = { Pdf, Page, textWidth, charWidth, escapePdf };