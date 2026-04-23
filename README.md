# Shared Drawing App

This is a standalone Vite + React version of the shared drawing prototype.

## What works

- Host screen on a laptop or projector
- Participant screen on a phone browser
- Room codes and join links
- Local same-browser syncing through BroadcastChannel + localStorage

## Important limitation

This version is accessible outside ChatGPT and can run in a normal browser, but the sync layer is still local-browser only. It works well for testing across tabs on the same machine. It does **not** yet support true phone-to-laptop realtime syncing across separate devices.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL shown by Vite.

## Test on your phone

On the same Wi-Fi network, open your computer's local IP on port 3000.

Example:

```text
http://192.168.1.5:3000
```

## Deploy

You can deploy this to Vercel, Netlify, or any static host.

## Next step for real cross-device sync

Replace the transport layer in `src/App.jsx` with one of these:

- Firebase Realtime Database
- Supabase Realtime
- small WebSocket server

Firebase is the fastest next step.
