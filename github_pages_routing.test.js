// GitHub Pages project-site routing.
//
// The site is served at https://ranjithlranjith810-ops.github.io/Exam-seat-pro/,
// a subpath GitHub Pages does NOT rewrite (no SPA fallback). A bare project URL
// arrives as pathname "/Exam-seat-pro/" and used to resolve to the 404 page. The
// fix strips that exact base only on the Pages host, so the entry route becomes
// "/" and the app tidies itself to the landing page. Hash routes already worked
// and must keep working.
//
// `stripProjectBase` is a pure function with an explicit hostname, so the
// subpath case is asserted directly; `routeFromLocation` is asserted for the
// hash and off-host path cases it can resolve without a browser `location`.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("github_pages_routing.test.js — project-subpath base handling");
const { it, eq, ok } = s;

const HOST = "ranjithlranjith810-ops.github.io";
const route = (p, q, hh) => api.routeFromLocation(p, q || "", hh || "", 0);

// ── the pure base-strip helper ───────────────────────────────────────────────
it("G1 the bare project URL resolves to the app root on the Pages host", () => {
  eq(api.stripProjectBase("/Exam-seat-pro/", HOST), "/");
  eq(api.stripProjectBase("/Exam-seat-pro", HOST), "/");
});

it("G2 a deeper project path keeps the in-app part", () => {
  eq(api.stripProjectBase("/Exam-seat-pro/dashboard", HOST), "/dashboard");
  eq(api.stripProjectBase("/Exam-seat-pro/seating/hall-notice", HOST), "/seating/hall-notice");
});

it("G3 the strip is inert off the exact Pages host", () => {
  eq(api.stripProjectBase("/Exam-seat-pro/", "app.example.com"), "/Exam-seat-pro/");
  eq(api.stripProjectBase("/dashboard", "app.example.com"), "/dashboard");
  eq(api.stripProjectBase("/dashboard", ""), "/dashboard");
  // A user/org Pages site served from the root must never strip a route segment.
  eq(api.stripProjectBase("/dashboard", "someone.github.io"), "/dashboard");
});

it("G4 hash routes on the Pages host are unaffected by the strip", () => {
  const login = route("/Exam-seat-pro/", "", "#/login");
  eq(login.source, "hash");
  eq(login.path, "/login");
  eq(api.matchPath(login.path).page, "login");

  const hn = route("/Exam-seat-pro/", "", "#/seating/hall-notice");
  eq(api.matchPath(hn.path).page, "hallnotice");

  const gn = route("/Exam-seat-pro/", "", "#/seating/global-notice/fn");
  const m = api.matchPath(gn.path);
  eq(m.page, "globalnotice");
  eq(m.params.session, "fn");
});

it("G5 strip + normalise yields the root entry the app tidies from", () => {
  const entry = api.normalizePath(api.stripProjectBase("/Exam-seat-pro/", HOST));
  eq(entry, "/");
  eq(api.matchPath(entry).isRoot, true);
});

// ── routeFromLocation without a browser host (other deployments) ─────────────
it("G6 path-form routes still work off the Pages host (Netlify/localhost)", () => {
  const r = route("/seating/hall-notice", "?date=2025-12-01");
  eq(r.source, "path");
  eq(r.path, "/seating/hall-notice");
  eq(r.search, "?date=2025-12-01");
});

it("G7 query strings are preserved on hash routes", () => {
  const r = route("/Exam-seat-pro/", "", "#/seating/global-notice/an?date=2025-12-01");
  eq(r.search, "?date=2025-12-01");
  eq(r.raw, "/seating/global-notice/an?date=2025-12-01");
});

// ── source-level wiring ─────────────────────────────────────────────────────
it("G8 routeFromLocation reads the host defensively and strips the base", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("function routeFromLocation(");
  ok(start >= 0, "routeFromLocation exists");
  const body = html.slice(start, html.indexOf("function canonicalInternalHref", start));
  ok(body.indexOf("stripProjectBase") >= 0, "the path branch strips the Pages project base");
  ok(body.indexOf('typeof location !== "undefined"') >= 0, "the hostname read is browser-safe");
});

it("G9 the Pages host/base constants are the expected values", () => {
  eq(api.GH_PAGES_HOST, "ranjithlranjith810-ops.github.io");
  eq(api.GH_PAGES_BASE, "/Exam-seat-pro");
});

module.exports = s;
