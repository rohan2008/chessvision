import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Chess } from "chess.js";
import { Engine } from "./engine.js";
import { GameTracker, speakMove } from "./game.js";
import { readBoard, visionInfo } from "./vision.js";
import { refundShared, sharedLimits, sharedRemaining, takeShared } from "./quota.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 15 * 1024 * 1024;
const MAX_GAMES = 2000;
const GAME_IDLE_MS = 6 * 60 * 60 * 1000;
const GAME_ID = /^[A-Za-z0-9_-]{4,40}$/;

const engine = new Engine();

// Each person (or device) plays in their own game, picked by ?game=<id> or the x-game-id header.
// Requests without one share the "default" game, which is handy for a single user on a PC.
const games = new Map();

function getGame(id) {
  let g = games.get(id);
  if (!g) {
    if (games.size >= MAX_GAMES) throw Object.assign(new Error("Server is full, try again later"), { status: 503 });
    g = { tracker: new GameTracker(), clients: new Set(), last: null, movetime: 1500, busy: false };
    games.set(id, g);
  }
  g.touched = Date.now();
  return g;
}

setInterval(() => {
  for (const [id, g] of games) {
    if (!g.clients.size && !g.busy && Date.now() - g.touched > GAME_IDLE_MS) games.delete(id);
  }
}, 10 * 60 * 1000).unref();

function broadcast(g, result) {
  g.last = result;
  const data = `data: ${JSON.stringify(result)}\n\n`;
  for (const res of g.clients) res.write(data);
}

function sanLine(fen, uciMoves, max = 6) {
  const c = new Chess(fen);
  const out = [];
  for (const u of uciMoves.slice(0, max)) {
    try {
      out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
    } catch {
      break;
    }
  }
  return out.join(" ");
}

// Runs a scanned/typed position through the game tracker and the engine.
async function analyze(g, update, extra = {}) {
  const myColor = g.tracker.myColor;
  const base = { at: Date.now(), myColor, ...extra };
  if (update.status === "invalid") {
    return { ...base, ok: false, error: `Board looks illegal: ${update.error}. Rescan or fix the FEN.` };
  }
  if (update.status === "unchanged" && g.last?.ok) {
    return { ...g.last, ...extra, at: Date.now(), unchanged: true };
  }
  const chess = update.chess;
  const fen = chess.fen();
  const lastMove = update.lastMove ? update.lastMove.san : null;
  const result = { ...base, ok: true, fen, turn: chess.turn(), lastMove, status: update.status, corrected: update.corrected || 0 };

  if (chess.isCheckmate()) return { ...result, gameOver: true, speech: "Checkmate. Game over." };
  if (chess.isDraw() || chess.isStalemate()) return { ...result, gameOver: true, speech: "The game is drawn." };
  if (chess.turn() !== myColor) {
    return { ...result, yourTurn: false, speech: null, message: "Waiting for your opponent to move." };
  }

  const a = await engine.analyze(fen, g.movetime);
  if (!a.bestmove) return { ...result, yourTurn: true, speech: "No legal moves." };
  const best = new Chess(fen).move({ from: a.bestmove.slice(0, 2), to: a.bestmove.slice(2, 4), promotion: a.bestmove[4] });
  const top = a.lines[0];
  let speech = speakMove(best);
  if (top?.mate > 0) speech += `. Mate in ${top.mate}.`;
  return {
    ...result,
    yourTurn: true,
    best: { uci: a.bestmove, san: best.san, from: best.from, to: best.to },
    speech,
    lines: a.lines.map((l) => ({ scoreCp: l.scoreCp, mate: l.mate, depth: l.depth, san: sanLine(fen, l.pv) })),
  };
}

const userError = (status, message) => Object.assign(new Error(message), { status, expose: true });

// `apiKey` is the person's own Gemini key, if they added one; otherwise the server's shared key is used,
// counted against `who`'s daily allowance.
async function scanImage(g, base64, mediaType, apiKey, who) {
  if (g.busy) throw userError(409, "Still reading the last photo. Try again in a few seconds.");
  const shared = !apiKey && visionInfo.hasKey;
  if (shared) {
    const limit = takeShared(who);
    if (limit === "user") {
      const n = sharedLimits.perUser;
      throw userError(429, `You've used today's ${n} free scan${n === 1 ? "" : "s"}. Add your own free Gemini key on the setup page for unlimited scans.`);
    }
    if (limit === "total") {
      throw userError(429, "The free shared scans are used up for today. Add your own free Gemini key on the setup page to keep going.");
    }
  }
  g.busy = true;
  try {
    const t0 = Date.now();
    const read = await readBoard(base64, mediaType, { myColor: g.tracker.myColor, apiKey }).catch((err) => {
      if (!shared) throw err;
      refundShared(who); // Google never read the photo, so it doesn't count
      if (err.status === 429 || err.status >= 500 || !err.status) {
        throw userError(503, "The free shared key is busy right now. Try again in a minute, or add your own free Gemini key on the setup page.");
      }
      throw err;
    });
    const extra = { confidence: read.confidence, notes: read.notes, visionMs: Date.now() - t0, visionModel: read.model };
    if (!read.placement) {
      return { at: Date.now(), ok: false, error: read.notes || "Couldn't find the board.", ...extra };
    }
    return await analyze(g, g.tracker.update(read.placement), { placement: read.placement, ...extra });
  } finally {
    g.busy = false;
  }
}

// iOS Shortcuts often send images as application/octet-stream, so trust the bytes over the header.
function sniffImageType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  const brand = buf.subarray(4, 12).toString();
  if (/^ftyp(heic|heix|mif1|msf1)/.test(brand)) return "image/heic";
  return null;
}

function sayFor(result) {
  if (!result.ok) return result.error;
  if (result.yourTurn && result.speech) {
    return result.lastMove && !result.unchanged ? `They played ${result.lastMove}. ${result.speech}` : result.speech;
  }
  if (result.lastMove && !result.yourTurn) return `You played ${result.lastMove}. Waiting for your opponent.`;
  return result.speech || result.message || "Board read, nothing to do.";
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Image too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

// The Gemini SDK keeps Google's real error JSON in `body`; pull out the message and reason.
function geminiDetail(err) {
  try {
    const parsed = JSON.parse(err.body);
    const e = (Array.isArray(parsed) ? parsed[0] : parsed).error;
    return { message: e.message, reason: e.details?.find((d) => d.reason)?.reason };
  } catch {
    return { message: err.message };
  }
}

function apiError(err) {
  if (err.expose || err.status === 413 || err.status === 503) return [err.status, err.message];
  if (visionInfo.provider === "gemini" && err.status) {
    const { message, reason } = geminiDetail(err);
    if (err.status === 429) {
      return [429, "Gemini free-tier limit reached. Wait a minute, or until tomorrow for the daily limit."];
    }
    if (reason === "API_KEY_INVALID" || err.status === 401 || err.status === 403) {
      return [401, "Your Gemini key isn't valid. Check it on the setup page."];
    }
    if (err.status === 400 && /image/i.test(message)) return [400, "That photo couldn't be opened. Take another one and try again."];
    return [502, `Gemini error ${err.status}: ${message}`];
  }
  if (err instanceof Anthropic.AuthenticationError) return [401, "Anthropic API key missing or invalid (set ANTHROPIC_API_KEY)."];
  if (err instanceof Anthropic.RateLimitError) return [429, "Rate limited by the Anthropic API - slow the scan rate."];
  if (err instanceof Anthropic.APIError) return [502, `Anthropic API error ${err.status}: ${err.message}`];
  if (/resolve authentication|api key|apiKey/i.test(err.message)) {
    return [401, "No Gemini key yet. Open the setup page and add your free key."];
  }
  return [err.status || 500, err.message];
}

const STATIC = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const PAGES = { "/": "home.html", "/play": "play.html", "/test": "test.html", "/setup": "setup.html" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const gameId = url.searchParams.get("game") || req.headers["x-game-id"] || "default";
  const apiKey = (req.headers["x-gemini-key"] || "").trim() || undefined;
  // Shared-key allowances are per person; behind Render's proxy the client's IP is the first forwarded one.
  const who = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, x-gemini-key, x-game-id",
        "access-control-allow-methods": "GET,POST",
      });
      return res.end();
    }

    if (url.pathname.startsWith("/api/") && !GAME_ID.test(gameId) && gameId !== "default") {
      return send(res, 400, { ok: false, error: "Bad game id", say: "Your chess link looks wrong. Copy it again from the setup page." });
    }

    if (url.pathname === "/api/events") {
      const g = getGame(gameId);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hi\n\n");
      if (g.last) res.write(`data: ${JSON.stringify({ ...g.last, replay: true })}\n\n`);
      g.clients.add(res);
      // Keep the stream alive through proxies that close idle connections.
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => {
        clearInterval(ping);
        g.clients.delete(res);
      });
      return;
    }

    if (url.pathname === "/api/status") {
      const g = getGame(gameId);
      return send(res, 200, {
        provider: visionInfo.provider,
        model: visionInfo.model,
        effort: visionInfo.effort,
        serverHasKey: visionInfo.hasKey,
        // Free scans left today on the shared key (null = unlimited, 0 when there's no shared key).
        sharedLeft: visionInfo.hasKey ? (Number.isFinite(sharedRemaining(who)) ? sharedRemaining(who) : null) : 0,
        sharedPerDay: Number.isFinite(sharedLimits.perUser) ? sharedLimits.perUser : null,
        myColor: g.tracker.myColor,
        movetime: g.movetime,
        fen: g.tracker.chess?.fen() ?? null,
        shortcutUrl: process.env.SHORTCUT_URL || null,
      });
    }

    // Setup page: is this Gemini key valid? Lists one model, which costs nothing against quota.
    if (url.pathname === "/api/checkkey" && req.method === "POST") {
      if (!apiKey) return send(res, 400, { ok: false, error: "Paste a key first." });
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) return send(res, 200, { ok: true });
      return send(res, 200, { ok: false, error: r.status === 400 || r.status === 403 ? "Google says that key isn't valid. Copy it again from AI Studio." : `Google returned ${r.status}. Try again.` });
    }

    // Web UI: JSON { image: "<data URL or base64>", mediaType? }
    if (url.pathname === "/api/scan" && req.method === "POST") {
      const g = getGame(gameId);
      const body = JSON.parse((await readBody(req)).toString());
      const m = /^data:(image\/[\w+]+);base64,(.*)$/s.exec(body.image ?? "");
      const result = await scanImage(g, m ? m[2] : body.image, m ? m[1] : body.mediaType || "image/jpeg", apiKey, who);
      broadcast(g, result);
      return send(res, 200, result);
    }

    // iPhone Shortcut / native companion app: raw image body. Returns the same JSON plus `say`,
    // one sentence that is always worth speaking aloud.
    if (url.pathname === "/api/frame" && req.method === "POST") {
      const g = getGame(gameId);
      const buf = await readBody(req);
      const mediaType = sniffImageType(buf) || (req.headers["content-type"] || "image/jpeg").split(";")[0];
      console.log(`[frame] game ${gameId.slice(0, 6)}… ${(buf.length / 1024).toFixed(0)} KB ${mediaType}`);
      try {
        const result = await scanImage(g, buf.toString("base64"), mediaType, apiKey, who);
        broadcast(g, result);
        const say = sayFor(result);
        console.log(`[frame] -> ${result.placement ?? "no board"} | "${say}"`);
        return send(res, 200, { ...result, say });
      } catch (err) {
        // Shortcuts can't easily branch on HTTP status, so errors come back as 200 with something to say.
        const [status, message] = apiError(err);
        if (status >= 500) console.error(err);
        else console.log(`[frame] -> ${status}: ${message}`);
        const result = { at: Date.now(), ok: false, error: message };
        if (err.status !== 409) broadcast(g, result);
        return send(res, 200, { ...result, say: message });
      }
    }

    // Manual correction: JSON { fen }
    if (url.pathname === "/api/fen" && req.method === "POST") {
      const g = getGame(gameId);
      const { fen } = JSON.parse((await readBody(req)).toString());
      const result = await analyze(g, g.tracker.setFen(fen.trim()), { manual: true });
      broadcast(g, result);
      return send(res, 200, result);
    }

    // Settings / new game: JSON { myColor?: "w"|"b", movetime?: ms, newGame?: true }
    if (url.pathname === "/api/settings" && req.method === "POST") {
      const g = getGame(gameId);
      const s = JSON.parse((await readBody(req)).toString());
      if (s.movetime) g.movetime = Math.min(6000, Math.max(200, Number(s.movetime)));
      if (s.myColor === "w" || s.myColor === "b") g.tracker.myColor = s.myColor;
      if (s.newGame) {
        g.tracker.reset();
        g.last = null;
      }
      return send(res, 200, { ok: true, myColor: g.tracker.myColor, movetime: g.movetime });
    }

    // chess.js for the test-board page (self-contained ES module).
    if (url.pathname === "/vendor/chess.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(await fs.readFile(path.join(here, "node_modules/chess.js/dist/esm/chess.js")));
    }

    if (url.pathname === "/healthz") return send(res, 200, { ok: true });

    // The live board used to live at "/": keep old links like /?speaker=1 working.
    if (url.pathname === "/" && (url.searchParams.has("speaker") || url.searchParams.has("game"))) {
      res.writeHead(302, { location: `/play${url.search}` });
      return res.end();
    }

    if (req.method === "GET") {
      const file = PAGES[url.pathname] ?? url.pathname.slice(1);
      const full = path.join(here, "public", path.normalize(file));
      if (!full.startsWith(path.join(here, "public"))) return send(res, 403, { error: "forbidden" });
      const data = await fs.readFile(full).catch(() => null);
      if (!data) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": STATIC[path.extname(full)] || "application/octet-stream" });
      return res.end(data);
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    const [status, message] = apiError(err);
    if (status >= 500) console.error(err);
    send(res, status, { at: Date.now(), ok: false, error: message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  // Skip virtual adapters (WSL, Hyper-V, VPNs) and link-local addresses a phone can't reach.
  const lan = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback/i.test(name))
    .flatMap(([, addrs]) => addrs)
    .filter((i) => i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
    .map((i) => `http://${i.address}:${PORT}`);
  console.log(`Chess Glasses running:\n  this computer: http://localhost:${PORT}`);
  for (const u of lan) console.log(`  phone (same Wi-Fi): ${u}/play?speaker=1`);
  console.log(`  board reader: ${visionInfo.provider} (${visionInfo.model})`);
  if (!visionInfo.hasKey) console.log("  no server key: each user adds their own Gemini key on /setup");
});

process.on("SIGINT", () => {
  engine.quit();
  process.exit(0);
});
process.on("SIGTERM", () => {
  engine.quit();
  process.exit(0);
});
