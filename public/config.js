// Where the API server is. When these pages are served by the Node server itself (your PC, or Render)
// it's the same origin, so the base is empty. On GitHub Pages (rohannamdhari.com/chessvision)
// the pages are static and the API runs on Render.
window.CG_API_BASE = ["rohannamdhari.com", "www.rohannamdhari.com", "rohan2008.github.io"].includes(location.hostname)
  ? "https://chessvision.onrender.com"
  : "";
