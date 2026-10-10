// The optional second-opinion function is a security boundary, so its limits are
// tested rather than assumed: no key means no answer, oversized requests are
// refused, and a reply can only ever speak about the cells that were asked about.
//
// The model call is stubbed. Nothing here touches the network or needs a key.
const h = require("../harness.js");
const s = h.suite("cat_llm.test.js — the second-opinion function stays inside its limits");
const { ait, eq, ok } = s;

// require() of an ES module gives a namespace object; the handler is its default.
const fn = require("../netlify/functions/cat-llm.mjs").default;

function req(method, body, headers) {
  return {
    method: method,
    headers: headers || {},
    body: body == null ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

// Replaces global fetch for one call and restores it afterwards.
async function withFetch(stub, run) {
  const real = global.fetch;
  let seen = null;
  global.fetch = async (url, opts) => { seen = { url, opts }; return stub(opts); };
  try { return { out: await run(), seen }; }
  finally { global.fetch = real; }
}

function modelReply(items) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      content: [{ type: "text", text: "```json\n" + JSON.stringify({ items }) + "\n```" }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  };
}

const KEY = { ANTHROPIC_API_KEY: "sk-test", CAT_LLM_MODEL: "claude-sonnet-5" };

ait("says plainly that it is not configured, instead of failing obscurely", async () => {
  const real = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await fn(req("POST", { items: [{ id: 1, raw: "CS3501 - DATA" }] }));
eq(r.statusCode, 503);
    ok(/No second-opinion service is configured/.test(JSON.parse(r.body).error),
      "the message says the service is absent rather than failing obscurely");
  } finally { if (real) process.env.ANTHROPIC_API_KEY = real; }
});

ait("refuses anything that is not a POST", async () => {
  eq((await fn(req("GET"))).statusCode, 405);
});

ait("refuses a request that carries no cells", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  eq((await fn(req("POST", { items: [] }))).statusCode, 400);
  eq((await fn(req("POST", "not json"))).statusCode, 400);
});

ait("refuses more cells than one request is allowed to carry", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const many = Array.from({ length: 21 }, (_, i) => ({ id: i, raw: "CS350" + i + " - SUBJECT" }));
  eq((await fn(req("POST", { items: many }))).statusCode, 413);
});

ait("never lets a reply speak about a cell that was not asked about", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const { out } = await withFetch(
    () => modelReply([
      { id: "a", subjectCode: "CS3501", subjectName: "DATA", confidence: "high", reason: "printed" },
      { id: "not-asked-for", subjectCode: "XX9999", subjectName: "MADE UP", confidence: "high", reason: "" },
    ]),
    () => fn(req("POST", { items: [{ id: "a", raw: "CS3501 - DATA" }] })));
  const body = JSON.parse(out.body);
  eq(out.statusCode, 200);
  eq(body.suggestions.length, 1, "the invented extra suggestion was dropped");
  eq(body.suggestions[0].subjectCode, "CS3501");
  eq(body.suggestions[0].advisory, true, "every suggestion is marked as advice, not a reading");
});

ait("treats anything but 'high' confidence as low, and bounds the reason", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const { out } = await withFetch(
    () => modelReply([{ id: 1, subjectCode: "CS3501", confidence: "VERY HIGH", reason: "x".repeat(900) }]),
    () => fn(req("POST", { items: [{ id: 1, raw: "CS3501 - DATA" }] })));
  const s0 = JSON.parse(out.body).suggestions[0];
  eq(s0.confidence, "low", "a model that grades its own answer 'VERY HIGH' is not trusted");
  ok(s0.reason.length <= 300, "the reason is cut to a readable length");
});

ait("does not pass an upstream refusal through to the browser", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const { out } = await withFetch(
    () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: "invalid x-api-key sk-test" } }) }),
    () => fn(req("POST", { items: [{ id: 1, raw: "CS3501" }] })));
  const body = JSON.parse(out.body);
  eq(out.statusCode, 502);
  ok(!/sk-test/.test(out.body), "the key never appears in what the browser is told");
  ok(!/invalid x-api-key/.test(out.body), "the upstream message is not echoed");
});

ait("sends the cell text and nothing else", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const { seen } = await withFetch(
    () => modelReply([{ id: 1, subjectCode: "CS3501", confidence: "high", reason: "" }]),
    () => fn(req("POST", {
      items: [{ id: 1, raw: "CS3501 - DATA", regno: "2021CS001", student: "Some Student" }],
    })));
  const sent = seen.opts.body;
  ok(/CS3501 - DATA/.test(sent), "the printed cell is sent");
  ok(!/2021CS001/.test(sent), "a register number that was smuggled in is dropped");
  ok(!/Some Student/.test(sent), "a student name that was smuggled in is dropped");
  eq(seen.opts.headers["x-api-key"], "sk-test", "the key goes in the server-side header only");
});

ait("turns a reply that is not JSON into a clear failure, not a crash", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  // The API always answers with a JSON envelope; it is the model's own text
  // inside it that may be prose instead of the requested shape.
  const { out } = await withFetch(
    () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ content: [{ type: "text", text: "I am sorry, I cannot help with that." }] }),
    }),
    () => fn(req("POST", { items: [{ id: 1, raw: "CS3501" }] })));
  eq(out.statusCode, 502);
  ok(/expected shape/.test(JSON.parse(out.body).error));
});

ait("answers only the configured origin", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.CAT_LLM_ORIGIN = "https://seating.example.edu";
  try {
    const r = await fn(req("POST", { items: [{ id: 1, raw: "CS3501" }] }, { origin: "https://evil.example" }));
    eq(r.statusCode, 403, "another site cannot spend this deployment's key");
  } finally { delete process.env.CAT_LLM_ORIGIN; }
});
module.exports = s;
