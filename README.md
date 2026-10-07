# ReproKit

A Chrome extension for QA that turns "it broke a minute ago" into a complete bug report. It quietly keeps the last few minutes of every tab in memory. When something goes wrong, press **Alt+Shift+B** and you get:

- **A DOM replay** of what happened (not a video, so it's small and sharp at any zoom)
- **Console logs**, uncaught errors and failed resource loads
- **Network requests** (fetch and XHR) with headers, bodies, status and timing
- **Your actions**: clicks, typing, dropdowns, checkboxes, key presses, navigation
- **A screenshot** you can annotate (box, arrow, draw, pixelate)
- **Environment**: browser, OS, viewport, screen, language, time zone, connection

You can also record your screen (or a window/tab), take a screenshot during recording, and add a title and description. Reports include a video player with standard playback controls.

From the report you can export:

| Button | What you get |
|---|---|
| Copy for ticket | Markdown with steps, expected/actual, environment, console errors and a failed-requests table. Paste into Jira, Linear, GitHub or Slack. |
| Playwright test | A `.spec.ts` regression test that replays your actions and fails if the same console errors or failed requests happen again. |
| HAR | Standard HAR 1.2 file for any network tool. |
| Share link | Uploads the self-contained report and copies a time-limited URL developers can open in a browser. Configure Supabase once from the popup. |
| Download report | One self-contained `.html` file with the replay, screen recording, logs and screenshot. Send the file to developers; they can open it without the extension. |
| Copy as cURL | On any network request, to rerun it in a terminal. |

## Install

1. Unzip `reprokit.zip`.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `reprokit` folder.
4. Pin ReproKit from the puzzle-piece menu.

Tabs that were already open start recording right away. Pages load the recorder at startup, so for the most complete capture, reload a tab before testing it.

Works in Chrome 111+ and other Chromium browsers (Edge, Brave, Arc).

## Use

1. Test as usual. ReproKit is always recording the last 1, 2 or 5 minutes (choose in the popup).
2. When you hit a bug, press **Alt+Shift+B** or click **Capture bug** in the popup. To make a video, click **Record screen**, choose a screen/window/tab, then stop to save the report.
3. The report opens in a new tab, starting just before the first error. Click any marker on the timeline or any row to jump the replay to that moment.
4. Fix up the title, steps (auto-written from your actions), expected and actual results.
5. Use **Share link** to copy a link for developers, or **Download report** to send a standalone file. **Copy for ticket** and the Playwright test are also available.

Change the shortcut at `chrome://extensions/shortcuts`.

## Privacy

Reports stay on your machine until you explicitly choose **Share link**. Link sharing uploads the self-contained report to a non-public Supabase Storage bucket and creates a signed link that expires after 24 hours, 7 days or 30 days. Link expiry does not delete the stored report; remove old report objects from the bucket when no longer needed. Screen recording begins only after you choose what to share in the browser's screen picker. Screen video is not automatically redacted, so review it before uploading or sharing.

To set up link sharing, click **Configure share links** in the extension popup, enter a Supabase project URL and its publishable/anon key, and run the displayed SQL in that project's SQL Editor. The setup creates a dedicated non-public bucket with a 50 MB per-file limit. **The simple anon policies are not access-controlled:** anyone who can call your project can upload, list report paths and create signed links for reports in this bucket. Do not treat uploaded reports as private or store sensitive recordings. Use a dedicated Supabase project/bucket and monitor storage usage. Never paste a secret or `service_role` key into ReproKit.

At capture time ReproKit redacts:
- Headers: `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, CSRF and auth tokens
- JSON/form body fields and URL query parameters named like password, token, secret, api key, card number, CVV or SSN
- Password, card and one-time-code input values (never stored, in actions or replay)

To hide more of your app from replays, add the class `reprokit-block` (element is replaced by a placeholder) or `reprokit-mask` (text is masked) to any element.

## Known limits

- Only the top-level frame is recorded. Iframe contents, `<canvas>` and `<video>` pixels aren't replayed.
- Network capture covers `fetch` and `XMLHttpRequest`. Images, WebSockets and service-worker traffic aren't listed (failed images and scripts still show as console errors).
- Response bodies are capped at 20 KB each. Streaming responses (server-sent events) are logged without bodies.
- Across full page reloads, the previous page's buffer is handed off as the page unloads. This is best effort; single-page apps are captured seamlessly.
- Chrome pages, the Web Store and other extensions' pages can't be captured.

## How it works

```
page (MAIN world)          content script            service worker            report tab
inpage.js ────────────────▶ bridge.js ──────────────▶ background.js ──────────▶ report.html
console/fetch/XHR patches   sync DOM events +         screenshot, merges         replay (rrweb-player),
user-action listeners       chrome.runtime            pages, saves report        timeline, inspector,
rrweb rolling recorder      messaging                 to IndexedDB               exporters
```

- `src/capture-core.js` is the recorder. It's bundled with rrweb into `inpage.js` by `build.sh`, inside a closure, so nothing leaks into the page's globals.
- The rrweb buffer keeps a full checkpoint every 30 seconds and drops segments older than the look-back window, so memory stays flat.
- Replays run in a sandboxed iframe, so recorded page scripts never execute.
- `lib/exporters.js` holds the pure functions for steps, Markdown, HAR, cURL and Playwright.

## Develop

```bash
npm install
npm run build        # regenerates inpage.js and vendor/ from src/ + node_modules
```

Then click the reload icon on the extension card in `chrome://extensions`. Edit `src/capture-core.js`, not `inpage.js`.

## Ideas for next steps

- One-click Jira / Linear / GitHub issue creation (with the HTML report attached)
- AI-written title, summary and likely cause from the errors and network log
- Duplicate detection against open tickets
- A session-ID header on requests to jump from a report to your backend logs
- Capturing iframes and Firefox support
