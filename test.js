import { test } from "node:test";
import assert from "node:assert/strict";
import { gridToRanks, modelOrder, ranksToPlacement } from "./vision.js";
import { GameTracker, speakMove } from "./game.js";
import { Chess } from "chess.js";

const START = ["rnbqkbnr", "pppppppp", "........", "........", "....P...", "........", "PPPP.PPP", "RNBQKBNR"];
const START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR";

// Render ranks the way a camera would see them with White's home on a given edge.
function view(ranks, edge) {
  const sq = (f, r) => ranks[8 - r][f]; // f 0..7, r 1..8
  const rows = [];
  for (let row = 0; row < 8; row++) {
    let s = "";
    for (let col = 0; col < 8; col++) {
      if (edge === "bottom") s += sq(col, 8 - row);
      if (edge === "top") s += sq(7 - col, row + 1);
      if (edge === "left") s += sq(row, col + 1);
      if (edge === "right") s += sq(7 - row, 8 - col);
    }
    rows.push(s);
  }
  return rows;
}

test("grid rotation round-trips for every camera edge", () => {
  for (const edge of ["bottom", "top", "left", "right"]) {
    assert.equal(ranksToPlacement(gridToRanks(view(START, edge), edge)), START_PLACEMENT, edge);
  }
});

test("tracker follows moves and knows whose turn it is", () => {
  const g = new GameTracker();
  g.reset("w");
  const c = new Chess();
  let u = g.update(c.fen().split(" ")[0]);
  assert.equal(u.status, "new");
  assert.equal(u.chess.turn(), "w");

  c.move("e4"); // I play my suggested move
  u = g.update(c.fen().split(" ")[0]);
  assert.equal(u.status, "moved");
  assert.equal(u.chess.turn(), "b"); // opponent to move -> app waits

  c.move("c5");
  u = g.update(c.fen().split(" ")[0]);
  assert.equal(u.lastMove.san, "c5");
  assert.equal(u.chess.turn(), "w");

  assert.equal(g.update(c.fen().split(" ")[0]).status, "unchanged");
});

test("tracker tracks castling rights and en passant through history", () => {
  const g = new GameTracker();
  g.reset("w");
  const c = new Chess();
  g.update(c.fen().split(" ")[0]);
  for (const m of ["e4", "a6", "e5", "d5"]) {
    c.move(m);
    g.update(c.fen().split(" ")[0]);
  }
  assert.equal(g.chess.fen(), c.fen()); // includes en passant square d6
  assert.ok(g.chess.moves().includes("exd6"));
});

test("small misreads snap to the nearest legal move", () => {
  const g = new GameTracker();
  g.reset("w");
  const c = new Chess();
  let u = g.update(c.fen().split(" ")[0]);
  c.move("e4");
  g.update(c.fen().split(" ")[0]);
  c.move("c5");
  // Read of the board after ...c5, with two squares wrong (a stray piece and a missing pawn).
  const misread = c.fen().split(" ")[0].replace("pp1ppppp", "pp1pp1pp").replace("/4P3/", "/4P2N/");
  u = g.update(misread);
  assert.equal(u.status, "moved");
  assert.equal(u.lastMove.san, "c5");
  assert.equal(u.corrected, 2);
  assert.equal(g.chess.fen(), c.fen());
});

test("a misread unchanged board stays put", () => {
  const g = new GameTracker();
  g.reset("w");
  const c = new Chess("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
  g.setFen(c.fen());
  const misread = c.fen().split(" ")[0].replace("2n5", "3n4"); // knight shifted one square
  const u = g.update(misread);
  assert.equal(u.status, "unchanged");
  assert.equal(g.chess.fen(), c.fen());
});

test("first scan near the starting position snaps to it", () => {
  const g = new GameTracker();
  g.reset("w");
  const u = g.update("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBKQBNR"); // king and queen swapped
  assert.equal(u.status, "new");
  assert.equal(u.corrected, 2);
  assert.equal(g.chess.fen(), new Chess().fen());
});

test("illegal reads are rejected", () => {
  const g = new GameTracker();
  assert.equal(g.update("8/8/8/8/8/8/8/K7").status, "invalid"); // no black king
});

test("moves are spoken clearly", () => {
  const c = new Chess("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
  assert.equal(speakMove(c.move("Bb5")), "Bishop f1 to b5");
  const k = new Chess("4k3/8/8/8/8/8/8/4K2R w K - 0 1");
  assert.equal(speakMove(k.move("O-O")), "Castle kingside");
  const m = new Chess("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1");
  assert.equal(speakMove(m.move("Rd8#")), "Rook d1 to d8, checkmate");
});

test("model order: last working model first, resting models last", () => {
  const models = ["big", "mid", "lite"];
  const now = 1000;
  assert.deepEqual(modelOrder(models, {}, now), ["big", "mid", "lite"]);
  // After a slow scan that only "lite" answered, the next scan starts with it.
  const rest = new Map([["big", now + 600000], ["mid", now + 120000]]);
  assert.deepEqual(modelOrder(models, { rest, lastGood: "lite" }, now), ["lite", "big", "mid"]);
  // Once the rests are over, "lite" still leads because it's the one known to work.
  assert.deepEqual(modelOrder(models, { rest, lastGood: "lite" }, now + 700000), ["lite", "big", "mid"]);
  // A resting lastGood doesn't jump the queue.
  assert.deepEqual(modelOrder(models, { rest: new Map([["lite", now + 5]]), lastGood: "lite" }, now), ["big", "mid", "lite"]);
});
