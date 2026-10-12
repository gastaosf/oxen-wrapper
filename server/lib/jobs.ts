/** Job lifecycle: enqueue, server-side polling with backoff, download of finished videos. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config, ProviderError } from "./config.js";
import * as provider from "./provider.js";
import { store, type Job, type JobError } from "./store.js";

const POLL_START_MS = 5_000;
const POLL_CAP_MS = 30_000;
const POLL_FACTOR = 1.5;

const timers = new Map<string, NodeJS.Timeout>();

function toJobError(e: unknown): JobError {
  if (e instanceof ProviderError) {
    return { message: e.message, detail: e.detail, type: e.type, provider: e.extra?.provider as string | undefined, provider_code: e.extra?.provider_code as string | undefined, retryable: e.extra?.retryable as boolean | undefined };
  }
  return { message: e instanceof Error ? e.message : String(e) };
}

export async function createJob(mode: provider.Mode, params: provider.GenerationParams): Promise<Job> {
  const request = provider.buildRequest(mode, params);
  const generationId = await provider.enqueue(request);
  const job: Job = {
    id: randomUUID(),
    mode,
    model: provider.MODES[mode].model,
    prompt: String(request.prompt ?? ""),
    params,
    request,
    status: "queued",
    providerStatus: "queued",
    generationId,
    createdAt: Date.now(),
    isDraft: Boolean(params.draft),
    pollCount: 0,
  };
  store.insert(job);
  schedulePoll(job.id, POLL_START_MS);
  return job;
}

/** Render the 1080p final of a draft job. Settings are locked to the draft; only model + draft_task_id are sent. */
export async function createFinalJob(draftJobId: string): Promise<Job> {
  const draft = store.get(draftJobId);
  if (!draft) throw new ProviderError("Draft job not found.", { status: 404, type: "not_found" });
  if (!draft.draftTaskId) throw new ProviderError("This job has no draft_task_id to render a final from.", { status: 400, type: "invalid_params" });
  if (draft.draftExpiresAt && new Date(draft.draftExpiresAt).getTime() <= Date.now()) {
    throw new ProviderError("Draft expired.", { status: 400, type: "invalid_params", detail: `The draft_task_id expired at ${draft.draftExpiresAt}. Render a new draft.` });
  }
  const request = provider.buildFinalRequest(draft.mode, draft.draftTaskId);
  const generationId = await provider.enqueue(request);
  const job: Job = {
    id: randomUUID(),
    mode: draft.mode,
    model: draft.model,
    prompt: draft.prompt,
    params: { ...draft.params, draft: false, resolution: "1080p" },
    request,
    status: "queued",
    providerStatus: "queued",
    generationId,
    createdAt: Date.now(),
    isFinal: true,
    fromDraftJobId: draft.id,
    draftTaskId: draft.draftTaskId,
    pollCount: 0,
  };
  store.insert(job);
  schedulePoll(job.id, POLL_START_MS);
  return job;
}

export async function cancelJob(id: string): Promise<Job> {
  const job = store.get(id);
  if (!job) throw new ProviderError("Job not found.", { status: 404, type: "not_found" });
  if (job.status !== "queued" && job.status !== "running") return job;
  if (job.generationId) await provider.cancelGeneration(job.generationId);
  stopPolling(id);
  return store.update(id, { status: "cancelled", providerStatus: "cancelled", completedAt: Date.now() })!;
}

export async function deleteJob(id: string): Promise<void> {
  const job = store.get(id);
  if (!job) return;
  if ((job.status === "queued" || job.status === "running") && job.generationId) {
    try { await provider.cancelGeneration(job.generationId); } catch { /* best effort */ }
  }
  stopPolling(id);
  if (job.localPath) {
    try { fs.unlinkSync(job.localPath); } catch { /* already gone */ }
  }
  store.remove(id);
}

function stopPolling(id: string): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

function schedulePoll(id: string, delayMs: number): void {
  stopPolling(id);
  timers.set(id, setTimeout(() => void poll(id, delayMs), delayMs));
}

async function poll(id: string, lastDelay: number): Promise<void> {
  timers.delete(id);
  const job = store.get(id);
  if (!job || !job.generationId || (job.status !== "queued" && job.status !== "running")) return;
  let gen: provider.Generation;
  try {
    gen = await provider.getGeneration(job.generationId);
  } catch (e) {
    // Transient failure (network, 5xx, rate limit): keep polling with backoff. 404 means the record is gone.
    if (e instanceof ProviderError && e.status === 404) {
      store.update(id, { status: "failed", completedAt: Date.now(), error: { message: "Generation not found at provider", type: "resource_not_found" } });
      return;
    }
    store.update(id, { lastPolledAt: Date.now(), pollCount: (job.pollCount ?? 0) + 1 });
    schedulePoll(id, Math.min(POLL_CAP_MS, lastDelay * POLL_FACTOR));
    return;
  }

  const patch: Partial<Job> = { providerStatus: gen.status, lastPolledAt: Date.now(), pollCount: (job.pollCount ?? 0) + 1 };
  if (gen.started_at && !job.startedAt) patch.startedAt = gen.started_at * 1000;

  switch (gen.status) {
    case "queued":
      patch.status = "queued";
      store.update(id, patch);
      schedulePoll(id, Math.min(POLL_CAP_MS, lastDelay * POLL_FACTOR));
      return;
    case "processing":
      patch.status = "running";
      store.update(id, patch);
      schedulePoll(id, Math.min(POLL_CAP_MS, lastDelay * POLL_FACTOR));
      return;
    case "cancelled":
      patch.status = "cancelled";
      patch.completedAt = (gen.completed_at ?? Date.now() / 1000) * 1000;
      store.update(id, patch);
      return;
    case "failed":
      patch.status = "failed";
      patch.completedAt = (gen.completed_at ?? Date.now() / 1000) * 1000;
      patch.error = {
        message: gen.error_message ?? "Generation failed",
        source: gen.error_source ?? null,
        provider: gen.error_provider ?? null,
        provider_code: gen.error_provider_code ?? null,
        retryable: gen.error_retryable ?? null,
      };
      store.update(id, patch);
      return;
    case "succeeded": {
      const video = gen.videos?.[0];
      const url = video?.url ?? gen.result_url ?? null;
      if (!url) {
        // Docs: treat an empty videos list as not ready yet.
        store.update(id, patch);
        schedulePoll(id, Math.min(POLL_CAP_MS, lastDelay * POLL_FACTOR));
        return;
      }
      patch.resultUrl = url;
      patch.completedAt = (gen.completed_at ?? Date.now() / 1000) * 1000;
      if (video?.draft_task_id) {
        patch.draftTaskId = video.draft_task_id;
        patch.draftExpiresAt = video.draft_expires_at ?? undefined;
      }
      store.update(id, patch);
      try {
        const { bytes, contentType } = await provider.downloadResult(url);
        fs.mkdirSync(config.outputsDir, { recursive: true });
        const ext = contentType.includes("quicktime") || url.split("?")[0].endsWith(".mov") ? "mov" : "mp4";
        const fileName = `${id}.${ext}`;
        const localPath = path.join(config.outputsDir, fileName);
        fs.writeFileSync(localPath, bytes);
        store.update(id, { status: "done", localPath, localUrl: `/outputs/${fileName}` });
      } catch (e) {
        // Keep the job as done with the provider URL; surface the download problem.
        store.update(id, { status: "done", error: { ...toJobError(e), message: `Video generated but local download failed: ${toJobError(e).message}` } });
      }
      void provider.getGenerationCost(job.generationId).then((cost) => { if (cost !== null) store.update(id, { cost }); });
      return;
    }
  }
}

/** Resume polling for jobs that were active when the server last stopped. */
export function resumeActiveJobs(): number {
  const active = store.active();
  for (const j of active) schedulePoll(j.id, 1_000);
  return active.length;
}
