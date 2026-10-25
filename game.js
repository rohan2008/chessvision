// Tracks the game across scans so we know whose turn it is, castling rights and en passant.
import { Chess, validateFen } from "chess.js";

const placementOf = (fen) => fen.split(" ")[0];
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
// How many squares a read may be wrong by and still snap to the nearest legal position.
// A real move changes 2-4 squares, so a few misreads still leave the true move clearly closest.
const MAX_FIX = 4;

const expand = (placement) => placement.replace(/\d/g, (n) => ".".repeat(+n)).replace(/\//g, "");

// Number of squares on which two placements differ.
export function placementDiff(a, b) {
  const x = expand(a), y = expand(b);
  let d = 0;
  for (let i = 0; i < 64; i++) if (x[i] !== y[i]) d++;
  return d;
}

// Guess castling rights from where kings and rooks stand.
function inferCastling(placement) {
  const c = new Chess();
  c.load(`${placement} w - - 0 1`, { skipValidation: true });
  const at = (sq) => c.get(sq);
  const is = (sq, type, color) => at(sq)?.type === type && at(sq)?.color === color;
  let rights = "";
  if (is("e1", "k", "w")) {
    if (is("h1", "r", "w")) rights += "K";
    if (is("a1", "r", "w")) rights += "Q";
  }
  if (is("e8", "k", "b")) {
    if (is("h8", "r", "b")) rights += "k";
    if (is("a8", "r", "b")) rights += "q";
  }
  return rights || "-";
}

// Builds a legal position from a bare placement, or explains why it is not legal.
export function positionFromPlacement(placement, turn) {
  const fen = `${placement} ${turn} ${inferCastling(placement)} - 0 1`;
  const check = validateFen(fen);
  if (!check.ok) return { error: check.error };
  const chess = new Chess(fen);
  // The side that just moved can't be left in check; if so the turn is probably the other way round.
  const other = new Chess(`${placement} ${turn === "w" ? "b" : "w"} ${inferCastling(placement)} - 0 1`, {
    skipValidation: true,
  });
  if (other.isCheck()) return { error: `${turn === "w" ? "Black" : "White"} is in check but it's not their move` };
  return { chess };
}

export class GameTracker {
  constructor() {
    this.chess = null;
    this.myColor = "w";
  }

  reset(myColor = this.myColor) {
    this.chess = null;
    this.myColor = myColor;
  }

  /**
   * Feeds a newly scanned placement.
   * Returns { status, chess, lastMove, corrected, error }, status is one of:
   *  "unchanged" | "moved" (a legal move from the last position) | "new" (fresh position) | "invalid"
   * `corrected` is how many misread squares were fixed by snapping to the nearest legal position.
   */
  update(placement) {
    if (this.chess) {
      const current = placementOf(this.chess.fen());
      if (current === placement) return { status: "unchanged", chess: this.chess };

      // Every position one legal move away, for the side to move or (if we missed a turn) the other side.
      const flipped = new Chess(this.chess.fen().replace(/ [wb] /, (t) => (t === " w " ? " b " : " w ")).replace(/ [a-h][36] /, " - "), {
        skipValidation: true,
      });
      const candidates = [];
      for (const [board, isFlipped] of [[this.chess, false], [flipped, true]]) {
        for (const m of board.moves({ verbose: true })) {
          candidates.push({ m, isFlipped, diff: placementDiff(placementOf(m.after), placement) });
        }
      }
      candidates.sort((a, b) => a.diff - b.diff || a.isFlipped - b.isFlipped);
      const [best, second] = candidates;

      // A few misread squares on an unchanged board (e.g. the camera moved) - keep the position.
      // On a tie with some move, assume nothing moved: that's the safer guess.
      const stay = placementDiff(current, placement);
      if (stay <= MAX_FIX && stay <= (best?.diff ?? Infinity)) {
        return { status: "unchanged", chess: this.chess, corrected: stay };
      }
      const ambiguous = second && second.diff === best.diff && placementOf(second.m.after) !== placementOf(best.m.after);
      if (best && best.diff <= MAX_FIX && !ambiguous) {
        if (best.isFlipped) {
          flipped.move(best.m);
          this.chess = new Chess(flipped.fen());
        } else {
          this.chess.move(best.m);
        }
        return { status: "moved", chess: this.chess, lastMove: best.m, corrected: best.diff };
      }
    } else {
      // First scan of a game that's just starting: snap small misreads to the starting position.
      const fromStart = placementDiff(placement, START);
      if (fromStart <= MAX_FIX) {
        this.chess = new Chess();
        return { status: "new", chess: this.chess, corrected: fromStart };
      }
    }
    // Unknown jump (first scan, missed moves, or a bad read): take the read as-is and assume it's my move.
    const { chess, error } = positionFromPlacement(placement, this.myColor);
    if (error) return { status: "invalid", error };
    this.chess = chess;
    return { status: "new", chess };
  }

  // Manual correction: trust a full FEN typed or edited by the user.
  setFen(fen) {
    const check = validateFen(fen);
    if (!check.ok) return { status: "invalid", error: check.error };
    this.chess = new Chess(fen);
    return { status: "new", chess: this.chess };
  }
}

const PIECE_NAMES = { p: "Pawn", n: "Knight", b: "Bishop", r: "Rook", q: "Queen", k: "King" };

// Turns a chess.js verbose move into something short and clear to hear.
export function speakMove(m) {
  let s;
  if (m.san.startsWith("O-O-O")) s = "Castle queenside";
  else if (m.san.startsWith("O-O")) s = "Castle kingside";
  else {
    s = `${PIECE_NAMES[m.piece]} ${m.from} ${m.captured ? "takes" : "to"} ${m.to}`;
    if (m.promotion) s += `, promote to ${PIECE_NAMES[m.promotion].toLowerCase()}`;
  }
  if (m.san.endsWith("#")) s += ", checkmate";
  else if (m.san.endsWith("+")) s += ", check";
  return s;
}
