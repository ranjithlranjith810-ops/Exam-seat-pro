// Regression tests for the SPA router's refresh / deep-link contract.
//
// The bug: opening or refreshing a nested URL such as /seating/hall-notice
// returned "Cannot GET /seating/hall-notice" on a static host that has no SPA
// fallback (VS Code Live Server, GitHub Pages). Netlify rewrites /* to
// index.html, so it worked there and hid the problem.
//
// The fix: in-app navigation writes the route into the HASH ("#/seating/..."),
// so the address bar path stays "/" and ANY static host can serve a refresh.
// Path-form routes are still ACCEPTED on load (so a bookmarked Netlify URL, or
// a server with an SPA fallback, still works), but every route collapses to the
// same descriptor whichever container carried it.
//
// The pure primitives are tested directly; the browser wrappers that read
// `window` are checked at the source level.
const fs = require("fs");
const h = require("./harness.js");
const api = h.load();

const s = h.suite("nav_routing.test.js — root-safe hash routing + deep links");
const { it, eq, ok } = s;

const ORIGIN = "https://app.example.com";
const route = (p, q, hh) => api.routeFromLocation(p, q || "", hh || "", 0);
const href = (to) => api.canonicalInternalHref(to, ORIGIN);

// ── route resolution from either container ───────────────────────────────────
it("R1 a pathname route resolves (server with an SPA fallback)", () => {
  const r = route("/seating/hall-notice", "?date=2025-12-01");
  eq(r.path, "/seating/hall-notice");
  eq(r.search, "?date=2025-12-01");
  eq(r.source, "path");
  eq(api.matchPath(r.path).page, "hallnotice");
});

it("R2 a hash route resolves to the SAME descriptor as the path route", () => {
  const p = route("/seating/hall-notice", "?date=2025-12-01");
  const hh = route("/", "", "#/seating/hall-notice?date=2025-12-01");
  eq(hh.path, p.path);
  eq(hh.search, p.search);
  eq(hh.raw, p.raw, "path and hash forms agree on raw");
  eq(hh.source, "hash");
  eq(api.matchPath(hh.path).page, "hallnotice");
});

it("R3 the nested global-notice session is read from the hash", () => {
  const r = route("/", "", "#/seating/global-notice/fn?date=2025-12-01");
  const m = api.matchPath(r.path);
  eq(m.page, "globalnotice");
  eq(m.params.session, "fn");
});

it("R4 an unknown route matches nothing (the 404 page, not a crash)", () => {
  eq(api.matchPath(api.routeFromLocation("/", "", "#/does-not-exist", 0).path), null);
});

it("R5 trailing slashes and repeats normalise identically in both containers", () => {
  eq(route("/seating//hall-notice/").path, "/seating/hall-notice");
  eq(route("/", "", "#/seating//hall-notice/").path, "/seating/hall-notice");
});

it("R6 an empty hash falls back to the path", () => {
  const r = route("/dashboard", "?x=1", "#");
  eq(r.source, "path");
  eq(r.path, "/dashboard");
  eq(r.search, "?x=1");
});

it("R6b a dev server exposing /index.html is treated as the app root", () => {
  const r = route("/index.html", "", "#/dashboard");
  eq(r.path, "/dashboard", "the hash still routes");
  const root = route("/index.html", "", "#");
  eq(root.path, "/");
  eq(api.matchPath(root.path).isRoot, true);
});

// ── canonical hrefs ──────────────────────────────────────────────────────────
it("R7 a path target becomes a root+hash href (refresh-safe on any host)", () => {
  const t = href("/seating/hall-notice?date=2025-12-01");
  eq(t.href, "#/seating/hall-notice?date=2025-12-01");
  eq(t.routePart, "/seating/hall-notice?date=2025-12-01");
  eq(t.external, false);
});

it("R8 the bare root stays '/' (never '#/')", () => {
  eq(href("/").href, "/");
  eq(href("/").routePart, "/");
});

it("R9 a non-root page keeps all of its query string", () => {
  eq(href("/seating/global-notice/an?date=2025-12-01").href, "#/seating/global-notice/an?date=2025-12-01");
});

it("R10 external URLs are passed through untouched", () => {
  const t = href("https://example.org/help");
  eq(t.external, true);
  eq(t.href, "https://example.org/help");
});

it("R11 an already-hash target round-trips to the same href", () => {
  eq(href("#/dashboard").href, "#/dashboard");
  eq(href("#/dashboard").routePart, "/dashboard");
});

it("R12 the debug flag survives in the hash search (IS_DEV reads both)", () => {
  const r = route("/", "", "#/dashboard?debug=1");
  ok(/[?&]debug=1/.test(r.search), "debug=1 is visible in the hash search");
});

// ── App is wired to the hash-aware router ────────────────────────────────────
it("R13 buildRoute resolves through routeFromLocation (path OR hash)", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("function buildRoute()");
  ok(start >= 0, "buildRoute exists");
  const body = html.slice(start, html.indexOf("function notify()", start));
  ok(body.indexOf("routeFromLocation") >= 0, "buildRoute delegates to routeFromLocation");
  ok(body.indexOf("source:") >= 0, "the route records which container (source) it came from");
});

it("R14 readQueryParam reads the location via routeFromLocation (hash-aware)", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("function readQueryParam(name)");
  ok(start >= 0, "readQueryParam exists");
  const body = html.slice(start, html.indexOf("function currentDepth", start));
  ok(body.indexOf("routeFromLocation") >= 0, "readQueryParam is hash-aware");
  ok(body.indexOf("new URLSearchParams(window.location.search") < 0, "it no longer parses window.location.search directly");
});

it("R15 navigate writes the canonical hash href and dedupes on routePart", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("function navigate(to, opts)");
  ok(start >= 0, "navigate exists");
  const body = html.slice(start, html.indexOf("function navigateBack", start));
  ok(body.indexOf("resolveTarget") >= 0, "navigate resolves through resolveTarget");
  ok(body.indexOf("t.routePart") >= 0, "the duplicate-entry guard uses routePart");
  ok(body.indexOf("pushState") >= 0 && body.indexOf("replaceState") >= 0, "it still uses History state");
});

it("R16 resolveTarget is the hash-writing canonicalInternalHref", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("function resolveTarget(to)");
  ok(start >= 0, "resolveTarget exists");
  const body = html.slice(start, html.indexOf("function", start + 10));
  ok(body.indexOf("canonicalInternalHref") >= 0, "resolveTarget delegates to canonicalInternalHref");
});

it("R17 safeNextPath matches the bare ROUTE (routePart), not a hash-stripped href", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  const start = html.indexOf("function safeNextPath(value)");
  ok(start >= 0, "safeNextPath exists");
  const body = html.slice(start, html.indexOf("function homePathFor", start));
  ok(body.indexOf("t.routePart") >= 0, "safeNextPath reads routePart");
});

it("R18 a hashchange listener re-syncs the rendered route", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  ok(html.indexOf('addEventListener("hashchange", syncFromLocation)') >= 0, "hashchange is wired to syncFromLocation");
  ok(html.indexOf('addEventListener("popstate", syncFromLocation)') >= 0, "popstate is still wired");
});

it("R19 the redirect into login still carries the full intended route in ?next", () => {
  const html = fs.readFileSync(h.HTML, "utf8");
  ok(html.indexOf('encodeURIComponent(route.raw)') >= 0, "the blocked route is handed to login as ?next");
  ok(html.indexOf('safeNextPath(readQueryParam("next"))') >= 0, "login sends the next path through safeNextPath");
});

module.exports = s;
