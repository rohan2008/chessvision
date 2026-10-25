// Draws a position into a .board element (and an optional arrow into an <svg class="arrows">).
// White pieces are a solid glyph in white under an outline glyph; black pieces are a solid glyph.
// "︎" asks for the text (not emoji) form so CSS colours apply.
(() => {
  const SOLID = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  const OUTLINE = { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" };
  const FILES = "abcdefgh";
  const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

  function pieceHtml(p) {
    const t = p.toLowerCase();
    return p === t
      ? `<span class="pb">${SOLID[t]}︎</span>`
      : `<span class="wfill">${SOLID[t]}︎</span><span class="wline">${OUTLINE[t]}︎</span>`;
  }

  /**
   * @param {HTMLElement} boardEl
   * @param {SVGElement|null} svgEl
   * @param {string|null} fen  null draws the starting position, faded (nothing scanned yet)
   * @param {{ flip?: boolean, best?: {from:string,to:string}|null, coords?: boolean }} opts
   */
  function render(boardEl, svgEl, fen, { flip = false, best = null, coords = true } = {}) {
    const placement = (fen || START).split(" ")[0];
    const grid = placement.split("/").map((row) => row.replace(/\d/g, (n) => ".".repeat(+n)).split(""));
    boardEl.classList.toggle("idle", !fen);
    let html = "";
    for (let vr = 0; vr < 8; vr++) {
      for (let vf = 0; vf < 8; vf++) {
        const r = flip ? 7 - vr : vr; // index into grid (0 = rank 8)
        const f = flip ? 7 - vf : vf;
        const sq = FILES[f] + (8 - r);
        const hl = best && (sq === best.from || sq === best.to) ? " hl" : "";
        let inner = grid[r][f] === "." ? "" : pieceHtml(grid[r][f]);
        if (coords && vr === 7) inner += `<span class="coord f">${FILES[f]}</span>`;
        if (coords && vf === 0) inner += `<span class="coord r">${8 - r}</span>`;
        html += `<div class="sq ${(r + f) % 2 === 0 ? "l" : "d"}${hl}">${inner}</div>`;
      }
    }
    boardEl.innerHTML = html;
    // Size pieces to the squares, whatever size the board is drawn at.
    boardEl.style.setProperty("--piece-size", `${Math.max(14, boardEl.clientWidth / 8 * 0.78)}px`);

    if (!svgEl) return;
    svgEl.innerHTML = "";
    if (!best) return;
    const pos = (s) => {
      let x = FILES.indexOf(s[0]) + 0.5, y = 8 - Number(s[1]) + 0.5;
      if (flip) { x = 8 - x; y = 8 - y; }
      return [x, y];
    };
    const [x1, y1] = pos(best.from), [x2, y2] = pos(best.to);
    const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const hx = x2 - ux * 0.38, hy = y2 - uy * 0.38;
    svgEl.innerHTML = `
      <line x1="${x1}" y1="${y1}" x2="${hx}" y2="${hy}" style="stroke: var(--brass); stroke-width: .2; stroke-linecap: round; opacity: .9"/>
      <polygon points="${x2},${y2} ${hx - uy * 0.3},${hy + ux * 0.3} ${hx + uy * 0.3},${hy - ux * 0.3}" style="fill: var(--brass); opacity: .9"/>`;
  }

  // Keep piece size right when the window is resized.
  const boards = new Set();
  window.addEventListener("resize", () => {
    for (const b of boards) b.style.setProperty("--piece-size", `${Math.max(14, b.clientWidth / 8 * 0.78)}px`);
  });

  window.ChessBoard = {
    render(boardEl, ...rest) {
      boards.add(boardEl);
      render(boardEl, ...rest);
    },
  };
})();
