// ─────────────────────────────────────────────────────────────────────────────
// cat-llm — an optional second opinion on timetable cells the reader was unsure
// about. It is a HELPER, never an authority.
//
// Three rules shape this file:
//
//  1. The API key lives here and only here. Nothing in the browser ever sees it,
//     which is the only reason this function exists instead of a fetch() from the
//     page. A key shipped to a browser is a key anybody can spend.
//
//  2. Only the cell text is sent, and only the cells the reader flagged. Student
//     lists, register numbers, halls and anything else on the page are never part
//     of the request. The payload is capped so it cannot be used to ship arbitrary
//     data to the model, and the request is rate limited so it cannot be used to
//     run up a bill.
//
//  3. Nothing here decides anything. The function returns SUGGESTIONS with the
//     model's own confidence. The browser shows them next to the printed text and
//     a person accepts or ignores each one. There is no code path in which a model
//     response is written to a student's exam without a human pressing a button.
//
// Configure with:
//   ANTHROPIC_API_KEY   required, server-side only
//   CAT_LLM_ORIGIN      the site origin allowed to call this (optional; without
//                       it the function answers only same-origin requests)
//   CAT_LLM_MODEL       optional, defaults to a current small model
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = process.env.CAT_LLM_MODEL || "claude-sonnet-5";
const API = "https://api.anthropic.com/v1/messages";

// Bounds. A timetable cell is a line or two of text; twenty flagged cells is a
// whole awkward page. Anything larger is refused rather than truncated, because a
// silently shortened request produces confidently wrong answers about cells the
// caller never sent.
const MAX_ROWS = 20;
const MAX_CELL_CHARS = 400;
const MAX_BODY_BYTES = 32 * 1024;

// A crude per-instance limiter. It is not a security control - it exists so a
// stuck retry loop cannot turn into a large bill, and it resets whenever the
// function sleeps.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const window = 60_000;
  const max = 10;
  const seen = (hits.get(ip) || []).filter((t) => now - t < window);
  if (seen.length >= max) {
    hits.set(ip, seen);
    return true;
  }
  seen.push(now);
  hits.set(ip, seen);
  return false;
}

function reply(status, body, origin) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    // The answer must never be cached: it is derived from one upload and from a
    // model that may change underneath us.
    "X-Content-Type-Options": "nosniff",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return { statusCode: status, headers, body: JSON.stringify(body) };
}

function cleanCell(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, MAX_CELL_CHARS);
}

// The prompt asks for the smallest possible answer in a fixed shape. Anything the
// model cannot read is returned as a null with a reason, because a guess here
// would be indistinguishable from a reading to the person accepting it.
const SYSTEM = [
  "You are checking readings of a college exam timetable.",
  "For each item you are given the RAW TEXT of one printed cell and the reader's",
  "attempt at it.",
  "Reply with JSON only: {\"items\":[{\"id\":<same id>,\"subjectCode\":string|null,",
  "\"subjectName\":string|null,\"staff\":string|null,\"confidence\":\"high|low\",",
  "\"reason\":string}]}",
  "Rules: use ONLY the characters present in the raw text. Never expand an",
  "abbreviation, never invent a subject, a code or a person, and never carry",
  "anything over from another cell. If the text does not contain a subject code,",
  "return null for it and say so in the reason. Keep each field exactly as printed,",
  "including its spacing and capitalisation.",
].join(" ");

export default async (req) => {
  const allowed = process.env.CAT_LLM_ORIGIN || null;
  const origin = req.headers.origin || null;
  // Without a configured origin the function only answers requests that arrive
  // without an Origin header (same-origin navigations) - a cross-site page cannot
  // make it spend the key.
  if (allowed && origin && origin !== allowed) {
    return reply(403, { error: "This deployment does not serve that origin." }, null);
  }

  if (req.method === "OPTIONS") {
    return { statusCode: 204, headers: { ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type" }, body: "" };
  }
  if (req.method !== "POST") return reply(405, { error: "POST only." }, allowed);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // The common case, and the reason this path must be optional: the app is
    // fully usable without it.
    return reply(503, { error: "No second-opinion service is configured on this deployment." }, allowed);
  }

  if (rateLimited(req.headers["x-nf-client-connection-ip"] || "unknown")) {
    return reply(429, { error: "Too many requests. Wait a minute and try again." }, allowed);
  }

  if (req.body && req.body.length > MAX_BODY_BYTES) {
    return reply(413, { error: "Too much text was sent." }, allowed);
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return reply(400, { error: "Malformed request." }, allowed);
  }

  const items = Array.isArray(body && body.items) ? body.items : null;
  if (!items || !items.length) return reply(400, { error: "No items were sent." }, allowed);
  if (items.length > MAX_ROWS) {
    return reply(413, { error: "Ask about " + MAX_ROWS + " cells at a time." }, allowed);
  }

  // Rebuilt here rather than trusted: every field is bounded and typed on this
  // side, so a caller cannot smuggle a prompt in through an unexpected key.
  const cleaned = items.map((it, i) => ({
    id: typeof it.id === "string" || typeof it.id === "number" ? it.id : i,
    raw: cleanCell(it.raw),
    readerCode: cleanCell(it.readerCode) || null,
    readerName: cleanCell(it.readerName) || null,
  })).filter((it) => it.raw);
  if (!cleaned.length) return reply(400, { error: "No readable cells were sent." }, allowed);

  const payload = {
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: "Check these cells:\n\n" + cleaned
        .map((it) => `#${it.id}\nRAW: ${it.raw}\nREADER CODE: ${it.readerCode || "(none)"}\nREADER NAME: ${it.readerName || "(none)"}`)
        .join("\n\n"),
    }],
  };

  let upstream;
  try {
    upstream = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return reply(502, { error: "The second-opinion service could not be reached." }, allowed);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    // The upstream message can name the key or the account, so it is not passed
    // through. The status alone tells the caller enough to act on.
    return reply(502, { error: "The second-opinion service refused the request (HTTP " + upstream.status + ")." }, allowed);
  }

  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    return reply(502, { error: "The second-opinion service sent something unreadable." }, allowed);
  }

  const replyText = (parsed.content || []).map((b) => b && b.text).filter(Boolean).join("");
  let out;
  try {
    // The model is told to answer with JSON only, but a model can still wrap it
    // in prose or a code fence, so the object is located rather than assumed.
    const start = replyText.indexOf("{");
    const end = replyText.lastIndexOf("}");
    out = start >= 0 && end > start ? JSON.parse(replyText.slice(start, end + 1)) : null;
  } catch (e) { out = null; }
  if (!out || !Array.isArray(out.items)) {
    return reply(502, { error: "The second-opinion service did not answer in the expected shape." }, allowed);
  }

  // The answer is filtered back to the cells that were actually asked about, and
  // every field is bounded again on the way out.
  const byId = new Map(cleaned.map((it) => [String(it.id), it]));
  const suggestions = out.items.filter((r) => r && byId.has(String(r.id))).map((r) => ({
    id: r.id,
    subjectCode: cleanCell(r.subjectCode) || null,
    subjectName: cleanCell(r.subjectName) || null,
    staff: cleanCell(r.staff) || null,
    confidence: r.confidence === "high" ? "high" : "low",
    reason: cleanCell(r.reason).slice(0, 300),
    // Stated on every suggestion, so a caller cannot mistake it for a reading.
    advisory: true,
  }));

  return reply(200, { suggestions, model: MODEL, usage: parsed.usage || null }, allowed);
};