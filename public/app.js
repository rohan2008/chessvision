const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const speakerMode = params.has("speaker");
if (speakerMode) document.body.classList.add("speaker");

const video = $("video");
const still = $("still");
let stream = null;
let busy = false;
let autoOn = false;
let voiceOn = true;
let myColor = "w";
let lastSpeech = "";
let lastResultAt = 0;

// ---------- server state ----------
CG.api("/api/status").then((r) => r.json()).then((s) => {
  myColor = s.myColor;
  $("myColor").value = s.myColor;
  $("movetime").value = String(s.movetime);
  const own = s.provider === "gemini" && CG.key;
  const ready = own || s.serverHasKey;
  const pill = $("statusPill");
  const left = !own && s.sharedPerDay ? ` · ${s.sharedLeft} free scans left` : "";
  pill.textContent = ready ? `${s.model} · ready${left}` : "add your Gemini key";
  pill.classList.toggle("bad", !ready);
  if (!ready) {
    pill.style.cursor = "pointer";
    pill.onclick = () => (location.href = "/setup");
  }
  renderBoard(s.fen);
});

const events = CG.events();
events.onmessage = (e) => show(JSON.parse(e.data));

// ---------- result display ----------
function fmtScore(l) {
  if (l.mate != null) return l.mate > 0 ? `M${l.mate}` : `-M${-l.mate}`;
  if (l.scoreCp == null) return "";
  const v = l.scoreCp / 100;
  return (v > 0 ? "+" : "") + v.toFixed(2);
}

function show(r) {
  if (r.at <= lastResultAt) return;
  lastResultAt = r.at;
  const meta = [];
  if (r.lastMove) meta.push(`Opponent played ${r.lastMove}`);
  if (r.confidence) meta.push(`read confidence: ${r.confidence}`);
  if (r.corrected) meta.push(`fixed ${r.corrected} misread square${r.corrected > 1 ? "s" : ""} using the game so far`);
  if (r.visionMs) meta.push(`${(r.visionMs / 1000).toFixed(1)}s to read${r.visionModel ? ` (${r.visionModel})` : ""}`);
  if (r.notes) meta.push(r.notes);

  if (!r.ok) {
    $("move").textContent = "—";
    $("speech").innerHTML = `<span class="error"></span>`;
    $("speech").firstChild.textContent = r.error;
    $("meta").textContent = meta.join(" · ");
    return;
  }
  if (r.fen) {
    $("fen").value = r.fen;
    renderBoard(r.fen, r.best);
  }
  $("meta").textContent = meta.join(" · ");
  if (r.gameOver || !r.yourTurn) {
    $("move").textContent = r.gameOver ? "Game over" : "…";
    $("speech").textContent = r.speech || r.message || "";
    $("lines").innerHTML = "";
  } else {
    $("move").textContent = r.best ? r.best.san : "—";
    $("speech").textContent = r.speech;
    $("lines").innerHTML = "";
    for (const l of r.lines || []) {
      const li = document.createElement("li");
      li.textContent = `${fmtScore(l)}  ${l.san}`;
      $("lines").append(li);
    }
  }
  if (r.speech && !r.unchanged && !r.replay) say(r.speech);
}

// ---------- board ----------
const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

function renderBoard(fen, best) {
  const board = $("board");
  board.innerHTML = "";
  const placement = (fen || "8/8/8/8/8/8/8/8").split(" ")[0];
  const grid = placement.split("/").map((row) => row.replace(/\d/g, (n) => ".".repeat(+n)).split(""));
  const flip = myColor === "b";
  const files = "abcdefgh";
  for (let vr = 0; vr < 8; vr++) {
    for (let vf = 0; vf < 8; vf++) {
      const r = flip ? 7 - vr : vr; // index into grid (0 = rank 8)
      const f = flip ? 7 - vf : vf;
      const sqName = files[f] + (8 - r);
      const el = document.createElement("div");
      el.className = "sq " + ((r + f) % 2 === 0 ? "l" : "d");
      if (best && (sqName === best.from || sqName === best.to)) el.classList.add("hl");
      const p = grid[r][f];
      if (p !== ".") {
        const s = document.createElement("span");
        s.textContent = GLYPH[p.toLowerCase()] + "︎"; // text presentation, not emoji
        s.className = p === p.toUpperCase() ? "pw" : "pb";
        el.append(s);
      }
      if (vr === 7) el.insertAdjacentHTML("beforeend", `<span class="coord f">${files[f]}</span>`);
      if (vf === 0) el.insertAdjacentHTML("beforeend", `<span class="coord r">${8 - r}</span>`);
      board.append(el);
    }
  }
  const svg = $("arrows");
  svg.innerHTML = "";
  if (best) {
    const pos = (sq) => {
      let x = files.indexOf(sq[0]) + 0.5, y = 8 - Number(sq[1]) + 0.5;
      if (flip) { x = 8 - x; y = 8 - y; }
      return [x, y];
    };
    const [x1, y1] = pos(best.from), [x2, y2] = pos(best.to);
    const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const hx = x2 - ux * 0.35, hy = y2 - uy * 0.35;
    svg.innerHTML = `
      <line x1="${x1}" y1="${y1}" x2="${hx}" y2="${hy}" stroke="#2f6f4fcc" stroke-width=".18" stroke-linecap="round"/>
      <polygon points="${x2},${y2} ${hx - uy * 0.28},${hy + ux * 0.28} ${hx + uy * 0.28},${hy - ux * 0.28}" fill="#2f6f4fcc"/>`;
  }
}

// ---------- voice ----------
function say(text) {
  lastSpeech = text;
  if (!voiceOn || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  speechSynthesis.speak(u);
}
$("btnSpeak").onclick = () => {
  voiceOn = !voiceOn;
  $("btnSpeak").textContent = `Voice: ${voiceOn ? "on" : "off"}`;
  $("btnSpeak").setAttribute("aria-pressed", voiceOn);
};
$("btnRepeat").onclick = () => lastSpeech && say(lastSpeech);
if (speakerMode && "speechSynthesis" in window) {
  // iOS/Android only allow speech after a user gesture.
  $("tap").style.display = "grid";
  $("tap").onclick = () => {
    speechSynthesis.speak(new SpeechSynthesisUtterance("Ready"));
    $("tap").style.display = "none";
  };
}

// ---------- sources ----------
async function useStream(s) {
  stream?.getTracks().forEach((t) => t.stop());
  stream = s;
  video.srcObject = s;
  video.hidden = false;
  still.hidden = true;
  $("videoHint").hidden = true;
  $("btnScan").disabled = false;
  $("btnAuto").disabled = false;
  s.getVideoTracks()[0].addEventListener("ended", () => setAuto(false));
}
$("btnCam").onclick = async () => {
  try {
    await useStream(await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } } }));
  } catch (e) {
    alert(`Camera unavailable: ${e.message}\n(Browsers only allow the camera on https or localhost - on a phone use "Photo…" instead.)`);
  }
};
$("btnScreen").onclick = async () => {
  try {
    await useStream(await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false }));
  } catch (e) {
    if (e.name !== "NotAllowedError") alert(`Window capture failed: ${e.message}`);
  }
};
$("file").onchange = async () => {
  const f = $("file").files[0];
  if (!f) return;
  const img = new Image();
  img.src = URL.createObjectURL(f);
  await img.decode();
  still.src = img.src;
  still.hidden = false;
  video.hidden = true;
  $("videoHint").hidden = true;
  $("file").value = "";
  scan(img, img.naturalWidth, img.naturalHeight);
};

// ---------- scanning ----------
function frameToJpeg(src, w, h, maxSide = 1400) {
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

async function scan(src = video, w = video.videoWidth, h = video.videoHeight) {
  if (busy || !w) return;
  busy = true;
  $("scanning").style.display = "block";
  $("btnScan").disabled = true;
  try {
    const r = await CG.api("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: frameToJpeg(src, w, h) }),
    });
    show(await r.json()); // also arrives over SSE; show() ignores the duplicate
  } catch (e) {
    show({ at: Date.now(), ok: false, error: `Network error: ${e.message}` });
  } finally {
    busy = false;
    $("scanning").style.display = "none";
    $("btnScan").disabled = !stream;
    lastScanThumb = thumb();
    lastScanTime = Date.now();
  }
}
$("btnScan").onclick = () => scan();

// Auto-scan: only call the API when the view has changed since the last scan
// and has been still for a moment (so we don't scan a hand mid-move).
const TW = 32, TH = 24;
const tc = document.createElement("canvas");
tc.width = TW; tc.height = TH;
const tctx = tc.getContext("2d", { willReadFrequently: true });
let prevThumb = null, lastScanThumb = null, lastScanTime = 0, stillCount = 0, autoTimer = null;

function thumb() {
  if (!video.videoWidth) return null;
  tctx.drawImage(video, 0, 0, TW, TH);
  const d = tctx.getImageData(0, 0, TW, TH).data;
  const g = new Float32Array(TW * TH);
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return g;
}
const diff = (a, b) => {
  if (!a || !b) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

function tick() {
  const t = thumb();
  const motion = diff(t, prevThumb);
  prevThumb = t;
  stillCount = motion < 3 ? stillCount + 1 : 0;
  const changed = diff(t, lastScanThumb) > 5;
  const gapOk = Date.now() - lastScanTime > Number($("gap").value) * 1000;
  if (!busy && stillCount >= 2 && changed && gapOk) scan();
}
function setAuto(on) {
  autoOn = on;
  $("btnAuto").textContent = `Auto-scan: ${on ? "on" : "off"}`;
  $("btnAuto").setAttribute("aria-pressed", on);
  clearInterval(autoTimer);
  if (on) {
    lastScanThumb = null;
    autoTimer = setInterval(tick, 600);
  }
}
$("btnAuto").onclick = () => setAuto(!autoOn);

// ---------- settings ----------
async function settings(body) {
  const r = await CG.api("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
$("myColor").onchange = async () => {
  myColor = $("myColor").value;
  await settings({ myColor });
  renderBoard($("fen").value);
};
$("movetime").onchange = () => settings({ movetime: Number($("movetime").value) });
$("btnNew").onclick = async () => {
  await settings({ newGame: true, myColor: $("myColor").value });
  $("fen").value = "";
  $("move").textContent = "—";
  $("speech").textContent = "New game. Scan the board when it's your move.";
  $("meta").textContent = "";
  $("lines").innerHTML = "";
  renderBoard(null);
};
$("btnFen").onclick = async () => {
  const fen = $("fen").value.trim();
  if (!fen) return;
  const r = await CG.api("/api/fen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fen }) });
  show(await r.json());
};

renderBoard(null);
