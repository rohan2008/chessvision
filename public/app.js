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
let lastFen = null;
let lastBest = null;

// ---------- server state ----------
CG.api("/api/status").then((r) => r.json()).then((s) => {
  setColorUI(s.myColor);
  $("movetime").value = String(s.movetime);
  const own = s.provider === "gemini" && CG.key;
  const ready = own || s.serverHasKey;
  const pill = $("statusPill");
  pill.className = `chip ${ready ? "ok" : "bad"}`;
  if (!ready) {
    pill.textContent = "Add a Gemini key";
    pill.style.cursor = "pointer";
    pill.onclick = () => (location.href = "/setup");
  } else if (!own && s.sharedPerDay) {
    pill.textContent = `${s.sharedLeft} free scans left today`;
  } else {
    pill.textContent = own ? "Ready · your key" : "Ready";
  }
  drawBoard(s.fen);
});

const events = CG.events();
events.onmessage = (e) => show(JSON.parse(e.data));

// ---------- result display ----------
function fmtScore(l) {
  if (l.mate != null) return l.mate > 0 ? `M${l.mate}` : `−M${-l.mate}`;
  if (l.scoreCp == null) return "";
  const v = l.scoreCp / 100;
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2);
}

function setState(text, cls = "") {
  $("turnState").textContent = text;
  $("turnState").className = `state ${cls}`;
}

function setLines(lines) {
  $("lines").innerHTML = "";
  for (const l of lines) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="ev"></span><span class="pv"></span>`;
    li.children[0].textContent = fmtScore(l);
    li.children[1].textContent = l.san;
    $("lines").append(li);
  }
  $("linesEmpty").hidden = lines.length > 0;
}

function show(r) {
  if (r.at <= lastResultAt) return;
  lastResultAt = r.at;
  const meta = [];
  if (r.corrected) meta.push(`Fixed ${r.corrected} misread square${r.corrected > 1 ? "s" : ""} using the game so far`);
  if (r.visionMs) meta.push(`read in ${(r.visionMs / 1000).toFixed(1)} s`);
  if (r.confidence && r.confidence !== "high") meta.push(`${r.confidence} confidence`);
  if (r.notes) meta.push(r.notes);
  $("meta").textContent = meta.join(" · ");

  if (!r.ok) {
    setState("Couldn't use that photo", "bad");
    $("move").textContent = "—";
    $("speech").innerHTML = `<span class="error"></span>`;
    $("speech").firstChild.textContent = r.error;
    return;
  }
  if (r.fen) {
    $("fen").value = r.fen;
    drawBoard(r.fen, r.best);
  }
  if (r.gameOver) {
    setState("Game over");
    $("move").textContent = r.speech?.startsWith("Checkmate") ? "Checkmate" : "Draw";
    $("speech").textContent = r.speech || "";
    setLines([]);
  } else if (!r.yourTurn) {
    setState("Opponent to move", "theirs");
    $("move").textContent = r.lastMove || "…";
    $("speech").textContent = r.lastMove ? `You played ${r.lastMove}. Take a photo after your opponent moves.` : r.message || "";
    setLines([]);
  } else {
    setState("Your move", "mine");
    $("move").textContent = r.best ? r.best.san : "—";
    $("speech").textContent = r.lastMove && !r.unchanged ? `They played ${r.lastMove}. ${r.speech}` : r.speech;
    setLines(r.lines || []);
  }
  if (r.speech && r.yourTurn && !r.unchanged && !r.replay) say(r.speech);
}

// ---------- board ----------
function drawBoard(fen, best = null) {
  lastFen = fen;
  lastBest = best;
  ChessBoard.render($("board"), $("arrows"), fen, { flip: myColor === "b", best });
}

// ---------- voice ----------
function say(text) {
  lastSpeech = text;
  if (!voiceOn || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
$("btnSpeak").onclick = () => {
  voiceOn = !voiceOn;
  $("btnSpeak").textContent = voiceOn ? "🔊 Voice on" : "🔇 Voice off";
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
    alert(`Camera unavailable: ${e.message}\n(Browsers only allow the camera on https or localhost. Use "Photo…" instead.)`);
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
  setState("Reading the board…");
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
  $("btnAuto").textContent = `Auto-scan ${on ? "on" : "off"}`;
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
function setColorUI(c) {
  myColor = c;
  for (const b of $("colorSeg").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.color === c);
}
for (const b of $("colorSeg").querySelectorAll("button")) {
  b.onclick = async () => {
    setColorUI(b.dataset.color);
    await settings({ myColor });
    drawBoard(lastFen, lastBest);
  };
}
$("movetime").onchange = () => settings({ movetime: Number($("movetime").value) });
$("btnNew").onclick = async () => {
  await settings({ newGame: true, myColor });
  $("fen").value = "";
  $("move").textContent = "—";
  setState("Waiting for your first photo");
  $("speech").textContent = "New game. Take a photo when it's your move.";
  $("meta").textContent = "";
  setLines([]);
  drawBoard(null);
};
$("btnFen").onclick = async () => {
  const fen = $("fen").value.trim();
  if (!fen) return;
  const r = await CG.api("/api/fen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fen }) });
  show(await r.json());
};

drawBoard(null);
