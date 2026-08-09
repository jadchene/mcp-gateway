import { mkdirSync } from "node:fs";
import { appendFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LoggingConfig } from "./types.ts";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_STRING_LENGTH = 8_192;
const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|api[-_]?key|credential)/i;

/** Provides queued, bounded, redacting structured file logging. */
export class Logger {
  private config: LoggingConfig = { enable: false, path: null, maxBytes: DEFAULT_MAX_BYTES };
  private queue: Promise<void> = Promise.resolve();
  private readonly stderr: boolean;

  public constructor(stderr = false) {
    this.stderr = stderr;
  }

  public configure(config: LoggingConfig): void {
    this.config = {
      enable: config.enable,
      path: config.path ? resolve(config.path) : null,
      maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES
    };
    if (this.config.enable && this.config.path) {
      try {
        mkdirSync(dirname(this.config.path), { recursive: true });
      } catch {
        // Logging failures must not block protocol traffic.
      }
    }
  }

  public info(event: string, details: Record<string, unknown> = {}): void {
    this.write("info", event, details);
  }

  public warn(event: string, details: Record<string, unknown> = {}): void {
    this.write("warn", event, details);
  }

  public error(event: string, details: Record<string, unknown> = {}): void {
    this.write("error", event, details);
  }

  /** Waits until all queued log entries have been attempted. */
  public async flush(): Promise<void> {
    await this.queue;
  }

  private write(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>): void {
    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(sanitize(details) as Record<string, unknown>)
    });
    const config = { ...this.config };

    if (level === "error" && this.stderr) {
      process.stderr.write(`${payload}\n`);
    }
    if (!config.enable || !config.path) {
      return;
    }
    this.queue = this.queue.catch(() => undefined).then(async () => {
      try {
        const size = await stat(config.path as string).then((value) => value.size).catch(() => 0);
        if (size + Buffer.byteLength(payload, "utf8") + 1 > (config.maxBytes ?? DEFAULT_MAX_BYTES)) {
          await unlink(`${config.path}.1`).catch(() => undefined);
          await rename(config.path as string, `${config.path}.1`).catch(() => undefined);
        }
        await appendFile(config.path as string, `${payload}\n`, "utf8");
      } catch {
        // Logging failures must not block protocol traffic.
      }
    });
  }
}

/** Redacts sensitive fields and limits attacker-controlled log volume. */
function sanitize(
  value: unknown,
  key = "",
  seen = new WeakSet<object>(),
  budget = { remaining: 200 },
  depth = 0
): unknown {
  if (budget.remaining <= 0 || depth > 8) {
    return "[Truncated]";
  }
  budget.remaining -= 1;
  if (SENSITIVE_KEY.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    const redacted = value
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/\b(api[-_]?key|token|password|secret)=([^\s&]+)/gi, "$1=[REDACTED]");
    return redacted.length > MAX_STRING_LENGTH
      ? `${redacted.slice(0, MAX_STRING_LENGTH)}...[truncated]`
      : redacted;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitize(item, key, seen, budget, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey, seen, budget, depth + 1)])
  );
}
