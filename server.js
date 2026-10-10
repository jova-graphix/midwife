const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const jobs = new Map();

const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `${command} exited with code ${code}`));
      }
    });
  });
}

function secondsToTimestamp(sec) {
  const safe = Math.max(0, Number(sec) || 0);
  const h = String(Math.floor(safe / 3600)).padStart(2, "0");
  const m = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
  const s = (safe % 60).toFixed(3).padStart(6, "0");
  return `${h}:${m}:${s}`;
}

function parseFfmpegTime(value) {
  const parts = value.split(":");
  if (parts.length !== 3) return 0;
  const [h, m, s] = parts.map(Number);
  if ([h, m, s].some((n) => Number.isNaN(n))) return 0;
  return h * 3600 + m * 60 + s;
}

function extractYoutubeVideoId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.slice(1);
    }
    return parsed.searchParams.get("v");
  } catch {
    return null;
  }
}

function sanitizeName(text) {
  return String(text || "clip")
    .replace(/[^a-z0-9-_ ]/gi, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 70) || "clip";
}

function getYtdlpArgs(baseArgs) {
  const args = [...baseArgs, "--no-playlist"];
  if (process.env.YTDLP_COOKIES) {
    args.push("--cookies", process.env.YTDLP_COOKIES);
  }
  return args;
}

app.post("/api/fetch", async (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: "Video URL is required." });
  }

  try {
    const args = getYtdlpArgs(["-J", url]);
    const { stdout } = await runCommand("yt-dlp", args);
    const info = JSON.parse(stdout);

    const formats = (info.formats || [])
      .filter((f) => f.ext === "mp4" && f.vcodec !== "none" && f.acodec !== "none" && Number(f.height))
      .sort((a, b) => (b.height - a.height) || ((b.tbr || 0) - (a.tbr || 0)));

    const formatMap = new Map();
    formats.forEach((f) => {
      if (![360, 480, 720, 1080].includes(f.height)) return;
      if (!formatMap.has(f.height)) {
        formatMap.set(f.height, {
          formatId: f.format_id,
          label: `${f.height}p`,
          ext: f.ext,
          height: f.height
        });
      }
    });

    const qualities = Array.from(formatMap.values()).sort((a, b) => a.height - b.height);
    if (!qualities.length) {
      return res.status(400).json({
        error: "No authorized MP4 quality options (360p-1080p) are available for this video. Some YouTube videos restrict direct download access."
      });
    }

    const videoId = extractYoutubeVideoId(url);
    if (!videoId) {
      return res.status(400).json({
        error: "This URL is not a supported YouTube watch link. Use a standard YouTube video URL that you are authorized to download."
      });
    }

    if (!Number(info.duration)) {
      return res.status(400).json({
        error: "This video does not expose a fixed duration (for example, live streams) and cannot be clipped reliably."
      });
    }

    const embedUrl = `https://www.youtube.com/embed/${videoId}`;
    return res.json({
      title: info.title || "Untitled Video",
      duration: Number(info.duration) || 0,
      thumbnail: info.thumbnail || "",
      embedUrl,
      qualities
    });
  } catch (error) {
    return res.status(400).json({
      error: `Unable to fetch video details. ${error.message.includes("Sign in") ? "This video likely requires authenticated access and valid cookies." : "Check URL and permissions."}`
    });
  }
});

async function processClip(jobId, payload) {
  const job = jobs.get(jobId);
  if (!job) return;

  const duration = payload.end - payload.start;
  try {
    job.status = "running";
    job.stage = "Resolving authorized stream URL";
    job.message = "Resolving source stream";
    job.progress = 5;

    const streamArgs = getYtdlpArgs(["-f", payload.formatId, "-g", payload.url]);
    const streamResult = await runCommand("yt-dlp", streamArgs);
    const mediaUrl = streamResult.stdout.split("\n").map((x) => x.trim()).find(Boolean);

    if (!mediaUrl) {
      throw new Error("No playable media stream URL was returned for that quality.");
    }

    const outputName = `${sanitizeName(payload.title)}-${Math.floor(payload.start)}-${Math.floor(payload.end)}.mp4`;
    const outputPath = path.join(outputDir, `${jobId}.mp4`);

    job.stage = "Trimming selected segment";
    job.message = "Encoding selected section";
    job.progress = 10;
    job.fileName = outputName;

    await new Promise((resolve, reject) => {
      const ffmpegArgs = [
        "-y",
        "-ss", secondsToTimestamp(payload.start),
        "-i", mediaUrl,
        "-t", secondsToTimestamp(duration),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "22",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outputPath
      ];

      const ffmpeg = spawn("ffmpeg", ffmpegArgs);

      ffmpeg.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        const match = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
        if (match) {
          const done = parseFfmpegTime(match[1]);
          const progress = Math.min(98, Math.max(10, (done / duration) * 100));
          job.progress = progress;
          job.message = `Encoding ${Math.floor(progress)}%`;
        }
      });

      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("FFmpeg failed while trimming this segment."));
      });
    });

    job.status = "done";
    job.stage = "Complete";
    job.progress = 100;
    job.message = "Clip is ready";
    job.path = outputPath;
    job.downloadUrl = `/api/download/${jobId}`;
    job.expiresAt = Date.now() + 60 * 60 * 1000;
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    job.message = "Export failed";
    job.progress = 0;
  }
}

app.post("/api/clip", async (req, res) => {
  const { url, start, end, formatId, title } = req.body || {};

  if (!url || !formatId || start === undefined || end === undefined) {
    return res.status(400).json({ error: "url, start, end, and formatId are required." });
  }

  const startSec = Number(start);
  const endSec = Number(end);
  if (Number.isNaN(startSec) || Number.isNaN(endSec) || startSec < 0 || endSec <= startSec) {
    return res.status(400).json({ error: "Invalid start/end values." });
  }

  const clipDuration = endSec - startSec;
  if (clipDuration > 60 * 30) {
    return res.status(400).json({ error: "Please keep clips under 30 minutes per export." });
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    stage: "Queued",
    message: "Waiting to process",
    progress: 1,
    createdAt: Date.now(),
    fileName: "clip.mp4",
    path: "",
    downloadUrl: "",
    error: ""
  });

  processClip(jobId, {
    url,
    start: startSec,
    end: endSec,
    formatId,
    title: title || "clip"
  });

  return res.json({ jobId });
});

app.get("/api/job/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }
  return res.json({
    status: job.status,
    stage: job.stage,
    message: job.message,
    progress: job.progress,
    downloadUrl: job.downloadUrl,
    fileName: job.fileName,
    error: job.error
  });
});

app.get("/api/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done" || !job.path) {
    return res.status(404).json({ error: "Clip is not ready for download." });
  }
  if (!fs.existsSync(job.path)) {
    return res.status(404).json({ error: "Output file no longer exists." });
  }

  return res.download(job.path, job.fileName);
});

setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    const expired = job.expiresAt && job.expiresAt <= now;
    const staleFailed = job.status === "failed" && job.createdAt + 30 * 60 * 1000 < now;
    if (expired || staleFailed) {
      if (job.path) {
        try {
          await fsp.unlink(job.path);
        } catch {
          // File can already be deleted.
        }
      }
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`ClipForge server running on http://localhost:${PORT}`);
});