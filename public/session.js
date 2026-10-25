// Who am I to the server: a private game id and (optionally) my own Gemini key.
// Both live only in this browser's storage; the key is sent with each request, never stored server-side.
(() => {
  const store = {
    get(k) {
      try { return localStorage.getItem(k); } catch { return null; }
    },
    set(k, v) {
      try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {}
    },
  };
  const newId = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
  };

  // A ?game= link (e.g. opened from the Shortcut setup) wins, so phone and PC can share one game.
  const fromUrl = new URLSearchParams(location.search).get("game");
  if (fromUrl && /^[A-Za-z0-9_-]{4,40}$/.test(fromUrl)) store.set("cg-game", fromUrl);
  if (!store.get("cg-game")) store.set("cg-game", newId());

  window.CG = {
    get gameId() { return store.get("cg-game"); },
    get key() { return store.get("cg-key") || ""; },
    setKey(k) { store.set("cg-key", (k || "").trim()); },
    newGameId() { store.set("cg-game", newId()); return store.get("cg-game"); },
    // fetch() with the game id and key attached.
    api(path, opts = {}) {
      const headers = { ...(opts.headers || {}), "x-game-id": this.gameId };
      if (this.key) headers["x-gemini-key"] = this.key;
      return fetch(path, { ...opts, headers });
    },
    events() {
      return new EventSource(`/api/events?game=${encodeURIComponent(this.gameId)}`);
    },
  };
})();
