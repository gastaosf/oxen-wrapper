import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { config, ProviderError } from "./lib/config.js";
import * as provider from "./lib/provider.js";
import { store } from "./lib/store.js";
import { createJob, createFinalJob, cancelJob, deleteJob, resumeActiveJobs } from "./lib/jobs.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

for (const d of [config.dataDir, config.outputsDir, config.uploadsDir]) fs.mkdirSync(d, { recursive: true });

app.use(express.static(config.publicDir));
app.use("/outputs", express.static(config.outputsDir, { maxAge: "1h" }));
app.use("/uploads", express.static(config.uploadsDir, { maxAge: "1h" }));

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

// --- Static configuration for the UI ---------------------------------------
app.get("/api/config", (_req, res) => {
  res.json({
    provider: provider.PROVIDER_NAME,
    modes: Object.values(provider.MODES),
    limits: {
      aspectRatios: provider.ASPECT_RATIOS,
      resolutions: provider.RESOLUTIONS,
      outputFormats: provider.OUTPUT_FORMATS,
      duration: provider.DURATION,
      media: provider.MEDIA_LIMITS,
    },
    uploadsConfigured: provider.uploadsConfigured(),
    apiKeyConfigured: Boolean(config.apiKey),
    targetNamespace: config.targetNamespace ?? null,
  });
});

// --- Model details (pricing + accepted fields) -----------------------------
app.get("/api/models/:mode", wrap(async (req, res) => {
  const mode = req.params.mode as provider.Mode;
  const spec = provider.MODES[mode];
  if (!spec) throw new ProviderError("Unknown mode", { status: 404, type: "not_found" });
  const model = await provider.getModel(spec.model);
  res.json({ id: model.id, display_name: model.display_name, pricing: model.pricing ?? null, fields: provider.schemaFields(model) });
}));

app.post("/api/estimate", wrap(async (req, res) => {
  const { mode, duration, resolution, generate_audio, draft } = req.body ?? {};
  const spec = provider.MODES[mode as provider.Mode];
  if (!spec) throw new ProviderError("Unknown mode", { status: 400, type: "invalid_params" });
  const model = await provider.getModel(spec.model);
  res.json(provider.estimateCost(model.pricing, { duration, resolution, generate_audio, draft }));
}));

app.get("/api/spend", wrap(async (_req, res) => {
  res.json(await provider.getSpend());
}));

// --- Uploads ----------------------------------------------------------------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024, files: 10 } });

function kindOf(mime: string, name: string): "image" | "video" | "audio" | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const L = provider.MEDIA_LIMITS;
  if (L.image.mime.includes(mime) || L.image.ext.includes(ext)) return "image";
  if (L.video.mime.includes(mime) || L.video.ext.includes(ext)) return "video";
  if (L.audio.mime.includes(mime) || L.audio.ext.includes(ext)) return "audio";
  return null;
}

app.post("/api/upload", upload.array("files", 10), wrap(async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw new ProviderError("No files received.", { status: 400, type: "invalid_params" });
  const out = [];
  for (const f of files) {
    const kind = kindOf(f.mimetype, f.originalname);
    if (!kind) throw new ProviderError("Unsupported file type", { status: 400, type: "invalid_params", detail: `${f.originalname}: use JPEG/PNG/WebP images, MP4/MOV videos or MP3/WAV audio.` });
    if (kind === "image" && f.size > provider.MEDIA_LIMITS.image.maxBytes) {
      throw new ProviderError("Image too large", { status: 400, type: "invalid_params", detail: `${f.originalname} is ${(f.size / 1024 / 1024).toFixed(1)} MB; images must be at most 30 MB.` });
    }
    const uploaded = await provider.uploadMedia(f.buffer, f.originalname, f.mimetype);
    // Keep a local copy for previews so the UI never depends on the remote URL.
    const localName = uploaded.path.split("/").pop()!;
    fs.writeFileSync(path.join(config.uploadsDir, localName), f.buffer);
    out.push({ url: uploaded.url, previewUrl: `/uploads/${localName}`, name: f.originalname, kind, size: f.size, mime: f.mimetype });
  }
  res.json({ files: out });
}));

// --- Jobs -------------------------------------------------------------------
app.get("/api/jobs", (req, res) => {
  const mode = typeof req.query.mode === "string" && req.query.mode ? req.query.mode : null;
  const jobs = store.all().filter((j) => !mode || j.mode === mode);
  res.json({ jobs });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: { message: "Job not found", type: "not_found" } });
  res.json(job);
});

app.post("/api/jobs", wrap(async (req, res) => {
  const { mode, params } = req.body ?? {};
  if (!provider.MODES[mode as provider.Mode]) throw new ProviderError("Unknown mode", { status: 400, type: "invalid_params" });
  const job = await createJob(mode, params ?? {});
  res.status(201).json(job);
}));

app.post("/api/jobs/:id/final", wrap(async (req, res) => {
  res.status(201).json(await createFinalJob(req.params.id));
}));

app.post("/api/jobs/:id/cancel", wrap(async (req, res) => {
  res.json(await cancelJob(req.params.id));
}));

app.delete("/api/jobs/:id", wrap(async (req, res) => {
  await deleteJob(req.params.id);
  res.json({ ok: true });
}));

// --- Errors -----------------------------------------------------------------
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ProviderError) return res.status(err.status >= 400 && err.status < 600 ? err.status : 500).json({ error: err.toJSON() });
  if (err && typeof err === "object" && (err as any).code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: { message: "File too large", type: "invalid_params", detail: "Uploads are capped at 200 MB per file." } });
  console.error(err);
  res.status(500).json({ error: { message: err instanceof Error ? err.message : "Unexpected error", type: "unknown_error" } });
});

const resumed = resumeActiveJobs();
app.listen(config.port, () => {
  console.log(`Seedance Studio running at http://localhost:${config.port}`);
  if (!config.apiKey) console.warn("Warning: PROVIDER_API_KEY is not set. Copy .env.example to .env.");
  if (!provider.uploadsConfigured()) console.warn("Warning: OXEN_UPLOAD_NAMESPACE not set. File uploads are disabled; paste public URLs instead.");
  if (resumed) console.log(`Resumed polling for ${resumed} active job(s).`);
});
