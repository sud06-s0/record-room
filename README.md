<!-- README.md -->
# FrameCast — screen + camera recorder

Records 1080p MP4 (H.264 + AAC) straight to a folder on your PC. No server, no database.

## Features
- **3 layouts**: Camera only · Screen + round camera bubble · 50/50 split. You can switch layouts live, even mid-recording.
- **Share a tab, a window or the entire screen**, with tab or PC sound.
- **AI noise cancellation on the mic only**: Standard (RNNoise) or Strong AI (GTCRN). PC and tab sound is mixed in untouched.
- **Recording keeps full speed in the background.** Compositing and encoding run in a Web Worker.
- **Floating always-on-top controls** show your camera, a timer, and Pause / Stop.
- **Streams to disk while recording**, so long recordings don't eat RAM.
- **Recordings page** lists, plays, renames and deletes the files in your folder.

## Requirements
Desktop **Chrome or Edge** (latest). Firefox and Safari are not supported.

## Run locally
```bash
npm install
npm run dev
```
Open http://localhost:5173. Camera and screen capture need `localhost` or HTTPS.

Written in TypeScript. `npm run typecheck` checks types; `npm run build` type-checks first, so a type error stops a bad deploy.

## Deploy to Vercel
1. Push this folder to a GitHub repo.
2. In Vercel, go to **Add New → Project**, import the repo, and keep the detected **Vite** preset.
   - Build: `npm run build`
   - Output: `dist`
3. Deploy. No environment variables are needed.

## Phone as camera & mic
Scan a QR code on the PC and your phone becomes the camera and mic. The video goes phone → PC directly over your WiFi (WebRTC, 1080p, up to 25 Mbps H.264, 128 kbps audio). It never goes through a server.

The one-time pairing handshake uses **Supabase Realtime**. No tables and no storage are used.
1. Create a free project at supabase.com.
2. Open **Project Settings → API** and copy the **Project URL** and the **anon / publishable key**.
3. Open **Realtime → Settings** and make sure public channel access is allowed.
4. Add both keys to Vercel as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then redeploy. For local dev, put them in `.env.local` (see `.env.example`).

Tips:
- Keep both devices on the same WiFi. Guest WiFi and VPNs usually block the direct link.
- Hold the phone sideways and keep it plugged in.

## Notes
- **Audio codec:** on Windows and macOS, Chrome and Edge encode AAC audio. On Linux, Chrome has no AAC encoder, so the app automatically uses Opus inside the MP4.
- **Avoiding echo:** use headphones when recording PC sound. Otherwise the speakers leak into the mic.
- **File size:** about 76 MB per minute at 1080p30 and about 122 MB per minute at 1080p60.
- **Folder access:** after a browser restart, Chrome asks once to allow folder access again. That takes one click.
