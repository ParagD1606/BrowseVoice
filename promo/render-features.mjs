#!/usr/bin/env node
/**
 * Renders promo/comp-features.html to an MP4 with optional narration.
 * Usage: node promo/render-features.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname);
const COMP = path.join(ROOT, "comp-features.html");
const FRAMES = path.join(ROOT, "_frames_features");
const OUT = path.join(ROOT, "browse-voice-features.mp4");
const WAV = path.join(ROOT, "browse-voice-features.wav");
const NARRATION = path.join(ROOT, "narration-features.txt");

const FPS = 10; // talk-style feature film: readable motion, faster render
const WIDTH = 1920;
const HEIGHT = 1080;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });

  await page.goto(pathToFileURL(COMP).href, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    if (window.__ready) await window.__ready;
  });
  const meta = await page.evaluate(() => window.__meta);
  const duration = meta?.dur || 105;
  const totalFrames = Math.ceil(duration * FPS);

  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });

  console.log(`Rendering ${totalFrames} frames @ ${FPS}fps (${duration}s)...`);
  const started = Date.now();
  for (let i = 0; i < totalFrames; i++) {
    const t = i / FPS;
    await page.evaluate(async (time) => {
      await window.__seek(time);
    }, t);
    const file = path.join(FRAMES, `frame-${String(i).padStart(5, "0")}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 88 });
    if (i % 50 === 0 || i === totalFrames - 1) {
      const pct = ((i + 1) / totalFrames * 100).toFixed(1);
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`  ${i + 1}/${totalFrames} (${pct}%) · ${elapsed}s`);
    }
  }
  await browser.close();

  const hasAudio = await exists(WAV);
  const ffmpegArgs = [
    "-y",
    "-framerate", String(FPS),
    "-i", path.join(FRAMES, "frame-%05d.jpg"),
  ];
  if (hasAudio) {
    ffmpegArgs.push("-i", WAV, "-c:a", "aac", "-b:a", "192k", "-shortest");
  }
  ffmpegArgs.push(
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-crf", "18",
    "-preset", "medium",
    "-movflags", "+faststart",
    OUT,
  );

  console.log("Encoding MP4...");
  await run("ffmpeg", ffmpegArgs);
  await writeFile(
    path.join(ROOT, "browse-voice-features.render.json"),
    JSON.stringify({ comp: COMP, fps: FPS, size: [WIDTH, HEIGHT], frames: totalFrames, seconds: duration, final: true, audio: hasAudio }, null, 1),
  );
  console.log(`Done → ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
