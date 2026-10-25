// Reads a photo of a physical chess board into piece placement using a vision model.
// Gemini (free tier) is used when GEMINI_API_KEY is set; otherwise Claude (ANTHROPIC_API_KEY).
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
const PROVIDER = process.env.VISION_PROVIDER || (geminiKey || !anthropicKey ? "gemini" : "claude");
const MODEL =
  PROVIDER === "gemini"
    ? process.env.GEMINI_MODEL || "gemini-3.8-flash" // first choice; see GEMINI_MODELS for the fallback
    : process.env.CHESS_MODEL || "claude-opus-5-5";
const EFFORT = process.env.CHESS_EFFORT || "medium";

let anthropic = null;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["board_visible", "rows", "white_home_edge", "confidence", "notes"],
  properties: {
    board_visible: {
      type: "boolean",
      description: "False if no complete 8x8 chess board can be seen clearly enough to read.",
    },
    rows: {
      type: "array",
      description:
        "Exactly 8 strings, one per board row AS SEEN IN THE IMAGE, from the row nearest the top of the image to the row nearest the bottom. Each string has exactly 8 characters, left to right as seen in the image. Use FEN letters (white: PNBRQK, black: pnbrqk) and '.' for an empty square.",
      items: { type: "string" },
    },
    white_home_edge: {
      type: "string",
      enum: ["bottom", "top", "left", "right"],
      description: "Which edge of the image White's first rank (a1-h1) is on.",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: {
      type: "string",
      description: "Short note on anything ambiguous (occluded squares, glare, unsure piece types). Empty if none.",
    },
  },
};

const SYSTEM = `You transcribe photos of physical chess boards into exact piece placement.
The photos come from a phone, webcam or smart glasses, so the board is often seen at an angle, partly cropped by perspective, with glare or a hand nearby.

How to work:
- First locate the 8x8 grid and its four corners. Count rows and columns carefully; do not merge or skip a row.
- Read every square, row by row, exactly as it appears in the image (top of image first, left to right). Do not rotate the board in your head; orientation is reported separately.
- Keep track of columns using the square colours: they alternate light/dark along every row and column, and the same column is the same colour in every other row. Before writing a piece into a row, check which numbered square (1-8 from the left) it stands on. A common mistake is shifting a piece one square sideways, especially in rows with several empty squares.
- Distinguish piece types by silhouette: king (tallest, cross), queen (crown/coronet), bishop (mitre with slit), knight (horse head), rook (castle battlements), pawn (smallest, round head). Distinguish colour by the piece's material colour, not the square colour.
- Sanity-check before answering: each side has exactly one king, at most 8 pawns, and no pawns on the first or last rank. If a check fails, look again at the squares involved.
- For white_home_edge, use printed coordinates on the board if visible; otherwise use the rule that each player has a light square in their right-hand corner, together with where the pieces are and the hint you are given about where the wearer sits.`;

const userPrompt = (myColor) => {
  const seat = myColor === "b" ? "Black" : "White";
  return `Transcribe this chess board. Hint: the wearer is playing ${seat} and is probably sitting behind the ${seat} pieces, so ${seat}'s home rank is most likely the edge nearest the camera (the bottom of the image) unless the board clearly says otherwise.`;
};

// Converts the as-seen grid to FEN ranks (rank 8 first, files a-h) given where White's home edge is.
export function gridToRanks(rows, whiteHomeEdge) {
  const g = rows.map((r) => r.split(""));
  const ranks = [];
  for (let i = 0; i < 8; i++) {
    let s = "";
    for (let j = 0; j < 8; j++) {
      switch (whiteHomeEdge) {
        case "bottom": s += g[i][j]; break;
        case "top": s += g[7 - i][7 - j]; break;
        case "left": s += g[j][7 - i]; break;
        case "right": s += g[7 - j][i]; break;
        default: throw new Error(`bad edge ${whiteHomeEdge}`);
      }
    }
    ranks.push(s);
  }
  return ranks;
}

export function ranksToPlacement(ranks) {
  return ranks.map((r) => r.replace(/\.+/g, (m) => String(m.length))).join("/");
}

async function askClaude(base64, mediaType, myColor) {
  anthropic ??= new Anthropic();
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: userPrompt(myColor) },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`Model declined: ${response.stop_details?.explanation ?? "no explanation"}`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Model ran out of tokens before answering");
  }
  return { text: response.content.find((b) => b.type === "text")?.text, model: MODEL };
}

// Free-tier models are often overloaded (503) or out of quota (429), and the SDK's default
// retries can hang for minutes. So: no SDK retries, a timeout, and fall through to the next model.
const GEMINI_MODELS = process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
const TIMEOUT_MS = 20000; // per model, before moving on to the next
const LAST_TIMEOUT_MS = 35000; // the last model gets longer: there's nothing left to fall back to
const BUSY_REST_MS = 2 * 60 * 1000; // after "overloaded" (503) or rate-limited (429)
const TIMEOUT_REST_MS = 10 * 60 * 1000; // after a timeout: a hanging model costs the most time
const health = new Map(); // api key -> { rest: Map(model -> until), lastGood: model }

const isTransient = (err) => !err.status || err.status === 429 || err.status >= 500;
const isTimeout = (err) => !err.status && /timeout|timed out|abort/i.test(`${err.name} ${err.message}`);

/**
 * The order to try models in: the one that answered last time first (unless it's resting), then the
 * rest in preference order, then resting ones as a last resort. Exported for tests.
 */
export function modelOrder(models, { rest = new Map(), lastGood = null } = {}, now = Date.now()) {
  const resting = (m) => (rest.get(m) ?? 0) > now;
  const awake = models.filter((m) => !resting(m));
  if (lastGood && awake.includes(lastGood)) {
    awake.splice(awake.indexOf(lastGood), 1);
    awake.unshift(lastGood);
  }
  return [...awake, ...models.filter(resting)];
}

// One client per key: each user brings their own free key, and the server's own key is the fallback.
const geminiClients = new Map();
function geminiClient(key) {
  let client = geminiClients.get(key);
  if (!client) {
    if (geminiClients.size > 500) geminiClients.clear();
    client = new GoogleGenAI({ apiKey: key });
    geminiClients.set(key, client);
  }
  return client;
}

async function askGemini(base64, mediaType, myColor, userKey) {
  const key = userKey || geminiKey;
  // Without a key the SDK falls back to Google Cloud credentials, which fails slowly and confusingly.
  if (!key) throw new Error("No API key set");
  const gemini = geminiClient(key);
  // Model health is tracked per key: one user's quota running out says nothing about another's.
  if (!health.has(key)) {
    if (health.size > 500) health.clear();
    health.set(key, { rest: new Map(), lastGood: null });
  }
  const h = health.get(key);
  const candidates = modelOrder(GEMINI_MODELS, h);
  let lastErr;
  for (const [i, model] of candidates.entries()) {
    const timeout_ms = i === candidates.length - 1 ? LAST_TIMEOUT_MS : TIMEOUT_MS;
    const t0 = Date.now();
    try {
      const interaction = await gemini.interactions.create(
        {
          model,
          store: false,
          system_instruction: SYSTEM,
          generation_config: { thinking_level: EFFORT },
          response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
          input: [
            { type: "text", text: userPrompt(myColor) },
            { type: "image", data: base64, mime_type: mediaType, resolution: "high" },
          ],
        },
        { timeout_ms, retries: { strategy: "none" } },
      );
      h.lastGood = model;
      h.rest.delete(model);
      return { text: interaction.output_text, model };
    } catch (err) {
      if (!isTransient(err)) throw err;
      const timedOut = isTimeout(err);
      console.warn(`[vision] ${model} ${timedOut ? "timed out" : `unavailable (${err.status ?? err.name})`} after ${Date.now() - t0} ms, trying next model`);
      h.rest.set(model, Date.now() + (timedOut ? TIMEOUT_REST_MS : BUSY_REST_MS));
      if (h.lastGood === model) h.lastGood = null;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * @param {string} base64 image data (no data: prefix)
 * @param {string} mediaType e.g. "image/jpeg"
 * @param {{ myColor: "w"|"b", apiKey?: string }} options apiKey: the user's own Gemini key, if they sent one
 * @returns {Promise<{ placement: string|null, confidence: string, notes: string, model: string }>}
 */
export async function readBoard(base64, mediaType, { myColor, apiKey }) {
  const { text, model } = await (PROVIDER === "gemini" ? askGemini : askClaude)(base64, mediaType, myColor, apiKey);
  if (!text) throw new Error("Model returned no text");
  const out = JSON.parse(text);

  if (!out.board_visible) {
    return { placement: null, confidence: out.confidence, notes: out.notes || "No board visible", model };
  }
  const bad = out.rows.length !== 8 || out.rows.some((r) => !/^[pnbrqkPNBRQK.]{8}$/.test(r));
  if (bad) {
    return { placement: null, confidence: "low", notes: `Could not read an 8x8 grid (${out.rows.join(" | ")})`, model };
  }
  const ranks = gridToRanks(out.rows, out.white_home_edge);
  return { placement: ranksToPlacement(ranks), confidence: out.confidence, notes: out.notes, model };
}

export const visionInfo = {
  provider: PROVIDER,
  model: MODEL,
  effort: EFFORT,
  hasKey: Boolean(PROVIDER === "gemini" ? geminiKey : anthropicKey),
};
