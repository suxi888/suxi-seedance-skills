import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    args[key] = next && !next.startsWith("--") ? argv[++index] : true;
  }
  return args;
}

function existingChrome(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error("没有找到 Google Chrome。可通过 --chrome 指定 chrome.exe 路径。");
  return found;
}

function safeBaseName(value) {
  return path.basename(value, path.extname(value)).replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-").trim() || "video";
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(Number(left) || 0);
  let b = Math.abs(Number(right) || 0);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function sampleTimes(duration, interval, maxFrames) {
  const safeDuration = Math.max(0, Number(duration) || 0);
  const safeMax = Math.max(3, Math.min(120, Number(maxFrames) || 60));
  const minimumInterval = safeDuration > 0 ? safeDuration / Math.max(1, safeMax - 1) : interval;
  const step = Math.max(0.2, Number(interval) || 0.5, minimumInterval);
  const values = [];
  for (let time = 0; time < safeDuration - 0.02; time += step) values.push(Number(time.toFixed(3)));
  const last = Number(Math.max(0, safeDuration - 0.05).toFixed(3));
  if (!values.length || last - values.at(-1) > step * 0.35) values.push(last);
  return [...new Set(values)].slice(0, safeMax);
}

async function seekVideo(page, time) {
  await page.$eval("video", (video, wanted) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`跳转到 ${wanted}s 超时`)), 7000);
    const done = () => { clearTimeout(timeout); resolve(); };
    video.addEventListener("seeked", done, { once: true });
    video.currentTime = wanted;
  }), time);
}

async function createContactSheets(frames, outputDir) {
  const columns = 4;
  const rows = 4;
  const cellWidth = 200;
  const imageHeight = 356;
  const labelHeight = 34;
  const sheetPaths = [];

  for (let sheetIndex = 0; sheetIndex < Math.ceil(frames.length / (columns * rows)); sheetIndex += 1) {
    const subset = frames.slice(sheetIndex * columns * rows, (sheetIndex + 1) * columns * rows);
    const canvas = sharp({
      create: {
        width: columns * cellWidth,
        height: rows * (imageHeight + labelHeight),
        channels: 3,
        background: "#10151b"
      }
    });
    const composites = [];
    for (let index = 0; index < subset.length; index += 1) {
      const frame = subset[index];
      const left = (index % columns) * cellWidth;
      const top = Math.floor(index / columns) * (imageHeight + labelHeight);
      const image = await sharp(frame.absolutePath).resize(cellWidth, imageHeight, { fit: "contain", background: "#000000" }).png().toBuffer();
      const label = Buffer.from(`<svg width="${cellWidth}" height="${labelHeight}"><rect width="100%" height="100%" fill="#10151b"/><text x="8" y="23" font-family="Arial" font-size="17" fill="#ffffff">${frame.timestampSeconds.toFixed(2)}s</text></svg>`);
      composites.push({ input: image, left, top }, { input: label, left, top: top + imageHeight });
    }
    const sheetPath = path.join(outputDir, `候选画面索引-${String(sheetIndex + 1).padStart(2, "0")}.jpg`);
    await canvas.composite(composites).jpeg({ quality: 90 }).toFile(sheetPath);
    sheetPaths.push(sheetPath);
  }
  return sheetPaths;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    throw new Error("用法：node extract-video-evidence.mjs --input <视频路径> --output <输出目录> [--interval 0.5] [--max 60] [--chrome <chrome.exe>]");
  }
  const inputPath = path.resolve(String(args.input));
  const outputDir = path.resolve(String(args.output));
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) throw new Error(`没有找到视频：${inputPath}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: existingChrome(args.chrome),
    headless: true,
    args: ["--allow-file-access-from-files"]
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1280 } });
    await page.goto(pathToFileURL(inputPath).href, { waitUntil: "domcontentloaded", timeout: 20000 });
    const metadata = await page.$eval("video", video => new Promise((resolve, reject) => {
      const read = () => resolve({
        durationSeconds: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        readyState: video.readyState
      });
      if (video.readyState >= 1 && Number.isFinite(video.duration)) return read();
      const timeout = setTimeout(() => reject(new Error("读取视频元数据超时")), 12000);
      video.addEventListener("loadedmetadata", () => { clearTimeout(timeout); read(); }, { once: true });
      video.addEventListener("error", () => reject(new Error(video.error?.message || "浏览器无法解码视频")), { once: true });
    }));
    if (!metadata.durationSeconds || !metadata.width || !metadata.height) throw new Error("视频缺少可读取的时长或画面尺寸");

    await page.setViewportSize({ width: metadata.width, height: metadata.height });
    await page.$eval("video", (video, size) => {
      video.controls = false;
      video.muted = true;
      video.pause();
      video.style.width = `${size.width}px`;
      video.style.height = `${size.height}px`;
      video.style.objectFit = "contain";
      document.body.style.margin = "0";
      document.body.style.background = "#000";
    }, metadata);

    const candidateDir = path.join(outputDir, "候选画面");
    fs.mkdirSync(candidateDir, { recursive: true });
    const times = sampleTimes(metadata.durationSeconds, args.interval, args.max);
    const frames = [];
    for (let index = 0; index < times.length; index += 1) {
      const timestampSeconds = times[index];
      await seekVideo(page, timestampSeconds);
      const fileName = `候选-${String(index + 1).padStart(3, "0")}-${timestampSeconds.toFixed(2)}s.png`;
      const absolutePath = path.join(candidateDir, fileName);
      await page.locator("video").screenshot({ path: absolutePath });
      frames.push({ fileName, absolutePath, timestampSeconds });
    }
    const contactSheets = await createContactSheets(frames, outputDir);
    const divisor = greatestCommonDivisor(metadata.width, metadata.height);
    const manifest = {
      schemaVersion: 1,
      source: { path: inputPath, fileName: path.basename(inputPath), name: safeBaseName(inputPath), sizeBytes: fs.statSync(inputPath).size },
      extractedAt: new Date().toISOString(),
      metadata: {
        ...metadata,
        ratio: metadata.width && metadata.height ? `${metadata.width / divisor}:${metadata.height / divisor}` : null,
        orientation: metadata.height > metadata.width ? "portrait" : metadata.width > metadata.height ? "landscape" : "square"
      },
      eligibility: {
        firstVersion: metadata.durationSeconds >= 4 && metadata.durationSeconds <= 15.1,
        reason: metadata.durationSeconds < 4 ? "视频短于第一版支持的4秒" : metadata.durationSeconds > 15.1 ? "视频超过第一版支持的15秒，需要拆段" : null
      },
      sampling: { intervalSeconds: Number(args.interval) || 0.5, candidateCount: frames.length, maximum: Math.max(3, Math.min(120, Number(args.max) || 60)) },
      candidates: frames.map(({ absolutePath, ...frame }) => ({ ...frame, relativePath: path.relative(outputDir, absolutePath).replace(/\\/g, "/") })),
      contactSheets: contactSheets.map(item => path.relative(outputDir, item).replace(/\\/g, "/")),
      selectedKeyframes: [],
      selectionStatus: "awaiting_semantic_review"
    };
    const manifestPath = path.join(outputDir, "视频证据.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    process.stdout.write(JSON.stringify({ ok: true, manifestPath, ...manifest }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
