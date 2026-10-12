import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");

function optional(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  apiKey: optional("PROVIDER_API_KEY"),
  port: Number(optional("PORT", "3210")),
  uploadNamespace: optional("OXEN_UPLOAD_NAMESPACE"),
  uploadRepo: optional("OXEN_UPLOAD_REPO", "seedance-uploads"),
  commitName: optional("OXEN_COMMIT_NAME", "Seedance Studio"),
  commitEmail: optional("OXEN_COMMIT_EMAIL", "seedance-studio@localhost"),
  targetNamespace: optional("TARGET_NAMESPACE") || undefined,
  dataDir: path.join(ROOT, "data"),
  outputsDir: path.join(ROOT, "outputs"),
  uploadsDir: path.join(ROOT, "uploads"),
  publicDir: path.join(ROOT, "public"),
};

export function assertApiKey(): void {
  if (!config.apiKey) {
    throw new ProviderError(
      "PROVIDER_API_KEY is not set. Copy .env.example to .env and add your Oxen.ai API key.",
      { status: 500, type: "config" },
    );
  }
}

/** Error surfaced to the UI. `detail` is the provider's own message whenever one exists. */
export class ProviderError extends Error {
  status: number;
  type: string;
  detail?: string;
  extra?: Record<string, unknown>;
  constructor(
    message: string,
    opts: { status?: number; type?: string; detail?: string; extra?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.status = opts.status ?? 500;
    this.type = opts.type ?? "unknown_error";
    this.detail = opts.detail;
    this.extra = opts.extra;
  }
  toJSON() {
    return { message: this.message, type: this.type, detail: this.detail, ...this.extra };
  }
}
