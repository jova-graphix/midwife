# ClipForge

ClipForge is a premium dark-theme web app that lets users select exact start and end points on a timeline and export only that segment of an authorized YouTube video.

## Stack

- Frontend: `index.html` (single-page UI with Tailwind CDN + vanilla JavaScript)
- Backend: `server.js` (Node.js + Express)
- Processing: `yt-dlp` for media access and `ffmpeg` for precise clip export

## Features

- Paste URL and fetch title, duration, thumbnail, and qualities
- Interactive dual-handle timeline with precise time inputs
- Live selection summary (start, end, clip length)
- Selected-range preview in the embedded player
- Real clip processing with progress polling
- Download output file when export completes
- Explicit errors when authorized access is unavailable

## Prerequisites

Install these binaries on your server/container:

- Node.js 18+
- `ffmpeg`
- `yt-dlp`

Optional for restricted but authorized videos:

- `YTDLP_COOKIES` environment variable pointing to a Netscape-format cookies file

## Local Run

1. Install packages:

   `npm install`

2. Start the server:

   `npm start`

3. Open:

   `http://localhost:3000`

## Production Deployment Notes

1. Deploy `index.html`, `server.js`, and `package.json`.
2. Ensure `ffmpeg` and `yt-dlp` are installed in the runtime image/VM.
3. Expose port `3000` or set `PORT` environment variable.
4. Persist write access for the `output/` directory during runtime.
5. Set `YTDLP_COOKIES` only if you have permission and need authenticated extraction.

## Compliance Note

A YouTube URL does not automatically grant download rights. The app only proceeds when media can be fetched through authorized methods and reports limitations otherwise.