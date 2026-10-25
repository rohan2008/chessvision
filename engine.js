// Persistent Stockfish (WASM, lite single-threaded) running as a child process speaking UCI.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const enginePath = require("stockfish").findEngine("lite-single");

export class Engine {
  constructor() {
    this.proc = spawn(process.execPath, [enginePath], { stdio: "pipe" });
    this.buffer = "";
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        for (const fn of this.listeners) fn(line);
      }
    });
    this.ready = this.#waitFor(["uci"], (l) => l === "uciok").then(() =>
      this.#waitFor(["setoption name MultiPV value 3", "isready"], (l) => l === "readyok"),
    );
  }

  #send(cmd) {
    this.proc.stdin.write(cmd + "\n");
  }

  // Sends commands and resolves with every line seen until `done(line)` is true.
  #waitFor(cmds, done) {
    return new Promise((resolve) => {
      const lines = [];
      const fn = (line) => {
        lines.push(line);
        if (done(line)) {
          this.listeners.delete(fn);
          resolve(lines);
        }
      };
      this.listeners.add(fn);
      for (const c of cmds) this.#send(c);
    });
  }

  // Returns { bestmove, ponder, lines: [{ multipv, depth, scoreCp, mate, pv: [uci...] }] }.
  analyze(fen, movetimeMs = 1500) {
    const job = this.queue.then(async () => {
      await this.ready;
      const out = await this.#waitFor(
        ["ucinewgame", `position fen ${fen}`, `go movetime ${movetimeMs}`],
        (l) => l.startsWith("bestmove"),
      );
      const byPv = new Map();
      for (const line of out) {
        if (!line.startsWith("info") || !line.includes(" pv ")) continue;
        const multipv = Number(line.match(/ multipv (\d+)/)?.[1] ?? 1);
        const depth = Number(line.match(/ depth (\d+)/)?.[1] ?? 0);
        const cp = line.match(/ score cp (-?\d+)/);
        const mate = line.match(/ score mate (-?\d+)/);
        const pv = line.split(" pv ")[1].trim().split(/\s+/);
        byPv.set(multipv, {
          multipv,
          depth,
          scoreCp: cp ? Number(cp[1]) : null,
          mate: mate ? Number(mate[1]) : null,
          pv,
        });
      }
      const [, bestmove, , ponder] = out.at(-1).split(/\s+/);
      return {
        bestmove: bestmove === "(none)" ? null : bestmove,
        ponder: ponder ?? null,
        lines: [...byPv.values()].sort((a, b) => a.multipv - b.multipv),
      };
    });
    this.queue = job.catch(() => {});
    return job;
  }

  quit() {
    this.#send("quit");
    this.proc.kill();
  }
}
