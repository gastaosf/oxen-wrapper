/** Tiny JSON-file job store with atomic writes. */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Mode, GenerationParams } from "./provider.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobError {
  message: string;
  detail?: string;
  type?: string;
  source?: string | null;
  provider?: string | null;
  provider_code?: string | null;
  retryable?: boolean | null;
}

export interface Job {
  id: string;
  mode: Mode;
  model: string;
  prompt: string;
  params: GenerationParams;
  /** Exact body sent to the provider (for "copy settings"). */
  request: Record<string, unknown>;
  status: JobStatus;
  providerStatus?: string;
  generationId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Provider URL (may expire) and local copy served from /outputs. */
  resultUrl?: string;
  localPath?: string;
  localUrl?: string;
  error?: JobError;
  cost?: string | null;
  isDraft?: boolean;
  draftTaskId?: string;
  draftExpiresAt?: string;
  /** For finals: the draft job this was rendered from. */
  fromDraftJobId?: string;
  isFinal?: boolean;
  lastPolledAt?: number;
  pollCount?: number;
}

const FILE = path.join(config.dataDir, "jobs.json");

let jobs: Job[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    jobs = Array.isArray(parsed) ? parsed : [];
  } catch {
    jobs = [];
  }
}

let writeTimer: NodeJS.Timeout | null = null;
function persist(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
    fs.renameSync(tmp, FILE);
  }, 50);
}

export const store = {
  all(): Job[] {
    load();
    return [...jobs].sort((a, b) => b.createdAt - a.createdAt);
  },
  get(id: string): Job | undefined {
    load();
    return jobs.find((j) => j.id === id);
  },
  insert(job: Job): Job {
    load();
    jobs.unshift(job);
    persist();
    return job;
  },
  update(id: string, patch: Partial<Job>): Job | undefined {
    load();
    const j = jobs.find((x) => x.id === id);
    if (!j) return undefined;
    Object.assign(j, patch);
    persist();
    return j;
  },
  remove(id: string): Job | undefined {
    load();
    const i = jobs.findIndex((x) => x.id === id);
    if (i < 0) return undefined;
    const [j] = jobs.splice(i, 1);
    persist();
    return j;
  },
  active(): Job[] {
    load();
    return jobs.filter((j) => j.status === "queued" || j.status === "running");
  },
};
