# Chess Vision

Point any camera at a chess board (phone, laptop webcam, USB camera or Meta glasses) and get the best move, spoken out loud and drawn on screen.

Live at **https://rohannamdhari.com/chessvision/**

```
any camera ──► Chess Vision ──► Gemini (or Claude) reads the board ──► chess.js checks it's legal
                                                                        │  and tracks whose turn it is
   voice + arrow on screen ◄── Stockfish 19 picks the best move
```

**Using it:** open the **Play** page, pick a camera from the list (back or front camera, any webcam by name, a photo, a shared window, or Meta glasses), press **Start camera**, then **Scan board**. You can also turn on **Auto-scan**. The move appears over the camera preview, on the board and in the engine's top lines.

- **Board reading:** a vision model turns the photo into an exact 8x8 placement and works out which way the board faces. By default this is Google's Gemini (`gemini-3.8-flash`) on its free tier. Claude (`claude-opus-5-5`, paid) is an optional alternative.
- **Engine:** Stockfish 19 (WASM, lite single-threaded) runs locally. You get the best move, the evaluation and the top 3 lines.
- **Game tracking:** each new scan is matched against the last position. The app knows when your opponent has moved (it tells you what they played), when it's their turn (it stays quiet), and it keeps castling and en-passant rights correct.
- **Auto-scan:** the app only calls the API when the view has changed *and* has been still for about a second, so it doesn't scan a hand mid-move.
- **Voice:** the move is spoken as e.g. "Knight g1 to f3, check". If your phone is paired with Bluetooth earbuds or Meta glasses, you hear it there.

## Run it

Requires Node 22+ and a free Gemini API key. Stockfish needs no key.

1. Get a free key: sign in at https://aistudio.google.com/apikey with a Google account and click **Create API key**. No card is needed for the free tier.
2. Copy `.env.example` to `.env` and paste the key after `GEMINI_API_KEY=`.
3. Install and start:

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. The home page explains the app; **/play** is where you pick a camera and play, **/setup** holds the settings (key, colour, Meta glasses) and **/test** is a test board. The terminal also prints a `http://<your-LAN-IP>:3000/play?speaker=1` address. Open that on your phone for a big-text page that speaks every move.

**Free-tier limits:** Google caps free requests per minute and per day, and the caps change over time. You can see yours in AI Studio. Free models are also often "experiencing high demand". The app tries `gemini-3.8-flash`, then `gemini-3.5-flash`, then `gemini-3.5-flash-lite`. The model that answered last time is tried first. Each attempt gets 20 seconds (35 for the last), a model that times out sits out for 10 minutes, and a busy or rate-limited one for 2 minutes. Expect roughly 5 to 20 seconds per scan. Each scan is one request. Auto-scan only fires when the board view changes, and waits at least 10 seconds between scans by default. If you hit the limit, the app tells you; raise **min gap** or wait. On the free tier, Google may use what you send to improve its products. The app sends only the board photo.

Optional env vars: `PORT`; `GEMINI_MODEL` (pin one model and turn off the fallback chain); `CHESS_EFFORT` (`low` | `medium` | `high`, default `medium`; `low` reads faster); `VISION_PROVIDER=claude` with `ANTHROPIC_API_KEY` to use Claude instead (paid); `CHESS_MODEL` (Claude model, default `claude-opus-5-5`).

## Cameras

Any camera the browser can use works straight from the **Play** page. Browsers only allow cameras on `https` pages or on `localhost`. The published site is https, so phones work there. On a phone opening your PC's `http://` address, use **A photo…** instead.

## Meta glasses (optional)

Meta's glasses don't expose their camera to web pages, so there are a few ways in.

### 0. Connect the phone and the PC
Your phone has to reach the PC running the server.
- **Home Wi-Fi:** put both on the same network, and use the `http://<PC address>:3000` that `npm start` prints.
- **School or work Wi-Fi** (eduroam and similar): these usually block devices from reaching each other. Turn on **Personal Hotspot** on the iPhone and connect the PC to it, then restart the server and use the new address it prints (usually `http://172.20.10.x:3000`). Scans then use a little mobile data, about 0.2 MB each.
- **Test:** open `http://<PC address>:3000/api/status` in Safari on the phone. If you see text starting with `{"provider"`, you're connected.

### iPhone: "Hey Meta, take a photo" → hear the move (no Mac or app needed)
This uses an Apple **Shortcut**. The glasses take the photo, the iPhone sends it to the server, and the iPhone speaks the reply. That audio plays through the glasses.

**One-time setup**
1. In the **Meta AI** app, turn on automatic import of photos to your iPhone's Photos app (in the app's media/gallery settings), so glasses photos land in your camera roll.
2. Open the **Shortcuts** app, tap **+**, and name the shortcut **Chess move**. Add these actions in order:
   1. **Get Latest Photos**: count 1, Include Screenshots off.
   2. **Convert Image**: convert to **JPEG** (iPhone photos are often HEIC).
   3. **Resize Image**: width **1400**. Smaller uploads are faster.
   4. **Get Contents of URL**: URL `http://<PC address>:3000/api/frame`. Tap ▸ to expand it, then set **Method** to **POST**, set **Request Body** to **File**, and pick the **Resized Image**.
   5. **Get Dictionary Value**: get **Value** for key `say` in **Contents of URL**.
   6. **Speak Text**: speak the **Dictionary Value**.
3. Choose a hands-free trigger:
   - **Back Tap:** Settings → Accessibility → Touch → Back Tap → Double Tap → **Chess move**
   - **Action Button**, on iPhones that have one
   - **"Hey Siri, chess move"**

**During a game:** when it's your move, say **"Hey Meta, take a photo"**. Wait for the photo to import (usually a few seconds), then trigger **Chess move**. You'll hear something like "They played Nf6. Knight g1 to f3". The app tracks the game between photos, so take one after every move: after your opponent's, to get your best move, and after your own, so it knows you made it.

The `/api/frame` reply always has a `say` field that's worth speaking. It covers the best move, "Waiting for your opponent", or a plain-English error such as a rate limit.

### 1. Video call → window capture (works today, no extra code)
1. On the computer running the app, sign in to WhatsApp Desktop or Messenger. Use a second account, or a contact who leaves the call open on that computer.
2. From your phone, start a **video call** to that account. Then switch the call's camera to the glasses: double-press the capture button on the glasses, or use the camera-switch control in the call.
3. Answer the call on the computer. In Chess Vision, click **Capture a window**, pick the call window, and turn on **Auto-scan**.
4. On your phone, open the `/play?speaker=1` page and tap once to enable voice. Some phones duck browser audio during a call. If yours does, leave **Voice** on in the computer's page and wear earbuds, or simply glance at the phone.

### 2. Photo mode (simplest)
Say "Hey Meta, take a photo". The photo syncs to your phone through the Meta AI app. Open the app's page on your phone, tap **Photo…** and pick the image. This is slower, but needs no setup.

### 3. Native companion app (best experience; iPhone builds need a Mac with Xcode)
Meta's [Wearables Device Access Toolkit](https://developers.meta.com/wearables/faq) (developer preview; [Android](https://github.com/facebook/meta-wearables-dat-android) / [iOS](https://github.com/facebook/meta-wearables-dat-ios) SDKs) lets a phone app stream the glasses' camera (up to 720p/30fps). A minimal companion app:

1. Start a camera stream with the toolkit (see Meta's sample apps for the session and stream setup).
2. Every few seconds, or when you press a button, encode one frame as JPEG and `POST` it to `http://<computer-ip>:3000/api/frame` with `Content-Type: image/jpeg`.
3. Read the `speech` field of the JSON response aloud with the phone's text-to-speech. It plays through the glasses over Bluetooth.

```kotlin
// Android sketch: `jpegBytes` comes from a frame of the DAT camera stream.
val req = Request.Builder()
    .url("http://192.168.1.20:3000/api/frame")
    .post(jpegBytes.toRequestBody("image/jpeg".toMediaType()))
    .build()
client.newCall(req).execute().use { resp ->
    val json = JSONObject(resp.body!!.string())
    json.optString("speech").takeIf { it.isNotEmpty() && !json.optBoolean("unchanged") }
        ?.let { tts.speak(it, TextToSpeech.QUEUE_FLUSH, null, "move") }
}
```

During the preview, Meta only lets you share builds with your own testers.

## No board? Use the test board
Open the **Test board** on a computer. It shows a position full-screen. Point any camera at the screen and scan: a phone on the Play page, or your glasses with the Shortcut. The page checks what the app read against the real position, outlining wrong squares in red. Use the **I played the suggested move** and **Opponent makes a move** buttons to play through a game and test move tracking.

## Tips for good reads
- Start scanning from the beginning of the game when you can. Once the app knows the position, each new photo only has to pick out which legal move was played. If the read is up to 4 squares off, the app snaps to the closest legal move and quietly fixes the misreads. The very first photo of a mid-game position has no history to check against, so misreads there need fixing by hand.
- Set **I play** correctly before you start. The app uses it to guess which way the board faces and whose move it is on the first scan.
- Keep the whole board in view. Holding or mounting the camera above the board works best. Steep side angles make similar pieces (bishop and pawn, queen and king) harder to tell apart.
- If a square is misread, edit the **FEN** box and press **Analyze**. Tracking continues from the corrected position.
- Press **New game** between games.

## Publishing (rohannamdhari.com/chessvision)

The site is split in two:
- **Website** (`public/`): published by GitHub Pages from this repo, `rohan2008/chessvision`. Your user site (`rohan2008.github.io`) already has the custom domain rohannamdhari.com, so this project's Pages site appears at **rohannamdhari.com/chessvision/** with no DNS changes. The workflow in `.github/workflows/pages.yml` deploys `public/` on every push to `main`.
- **API server** (board reading, Stockfish, game tracking, the Shortcut's photo uploads): GitHub Pages can't run it, so it runs on [Render](https://render.com) (free) at `chessvision-6s6i.onrender.com`. `public/config.js` sends the Pages site's requests there. When the same pages are served by the Node server (on your PC or on Render), they talk to that server instead.

Everyone gets a private game. For board reading, the `/setup` page gives each person two choices:
- **Free shared key (default):** visitors use your Gemini key with no setup. Each person (by IP address) gets `SHARED_DAILY_PER_USER` scans a day (30), and everyone together gets `SHARED_DAILY_TOTAL` (500). Scans Google was too busy to read don't count. When a limit is reached, the app says so and points to the setup page. The counts reset at midnight UTC, and also when the server restarts.
- **Their own free key:** unlimited, and it doesn't touch your quota. The key stays on their device and is sent with each photo.

Because the shared key is yours, all shared scans use your free Google quota, and Google may use free-tier images to improve its products. To turn sharing off, leave `GEMINI_API_KEY` empty on Render; then everyone needs their own key.

1. **GitHub:** create the repository `rohan2008/chessvision` and push this folder to it. `.gitignore` already keeps `.env` (your key) and `node_modules` out.
2. **GitHub Pages:** in the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**. The next push, or re-running the workflow, publishes the site to rohannamdhari.com/chessvision/.
3. **Render:** sign in with GitHub. Choose **New → Blueprint**, pick the repo, and click **Apply**. When it asks for `GEMINI_API_KEY`, paste your key to offer free shared scans, or leave it empty. `render.yaml` sets up everything else.
4. **Check the API address.** If Render's address isn't exactly `https://chessvision-6s6i.onrender.com` (it adds a suffix when a name is taken), put the real address in `public/config.js` and push.
5. **Share** `https://rohannamdhari.com/chessvision/`.

**Optional: a one-tap Shortcut for everyone.**
1. On your iPhone, build the Shortcut from `/setup`. Then **duplicate** it, and in the copy replace your key with the text `PASTE_KEY`, so your real key isn't shared.
2. In the copy, open **ⓘ → Setup (Import Questions)**. Add a question for the URL in *Get Contents of URL*: "Paste your chess link from the setup page". Add another for the `x-gemini-key` header value: "Paste your Gemini key, or delete this text to use the free shared key". An empty header means the shared key is used.
3. Choose **Share → Copy iCloud Link**, and set it as `SHORTCUT_URL` in Render's **Environment** settings. `/setup` then shows an **Add Shortcut** button.

The free Render plan sleeps after about 15 idle minutes, so the first photo after a break takes 30 to 60 seconds longer. Games are kept in memory, so a restart or redeploy forgets positions in progress. The next photo of a fresh game starts tracking again.

## API

Requests pick a private game with `?game=<id>` (or an `x-game-id` header); without one they share a `default` game. A user's own Gemini key goes in an `x-gemini-key` header. Otherwise the server's `GEMINI_API_KEY` is used, within the shared daily limits if they're set. They're off unless the `SHARED_DAILY_*` variables are set, so a personal install is unlimited.

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /api/scan` | `{ "image": "data:image/jpeg;base64,..." }` | Read the board from an image and analyze it |
| `POST /api/frame` | raw JPEG/PNG/HEIC bytes | Same, for the iPhone Shortcut and native apps; adds a `say` sentence |
| `POST /api/fen` | `{ "fen": "..." }` | Analyze or correct a position by hand |
| `POST /api/settings` | `{ "myColor": "w"\|"b", "movetime": 1500, "newGame": true }` | Game settings |
| `POST /api/checkkey` | (key in header) | Check a Gemini key is valid |
| `GET /api/events` | | Server-sent events: every result in this game, for speaker pages |

A response looks like `{ ok, fen, yourTurn, lastMove, best: { san, from, to }, speech, lines: [{ scoreCp, mate, san }], confidence, notes }`.

## Fair play
Use this for practice, studying your games, puzzles, or casual games where everyone knows. Using engine help in rated, online or over-the-board tournament games is cheating, and it gets accounts and players banned.

## Tests

```bash
npm test
```
