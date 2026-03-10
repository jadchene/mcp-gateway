import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { LoggingConfig } from "./types.ts";

/**
 * Provides a minimal structured logger that appends newline-delimited JSON to a file.
 */
export class Logger {
  /**
   * Stores the current effective logging config.
   */
  private config: LoggingConfig = {
    enable: false,
    path: null
  };

  /**
   * Updates the effective logging config at runtime.
   */
  public configure(config: LoggingConfig): void {
    this.config = {
      enable: config.enable,
      path: config.path ? resolve(config.path) : null
    };

    if (!this.config.enable || !this.config.path) {
      return;
    }

    try {
      mkdirSync(dirname(this.config.path), { recursive: true });
    } catch {
      /**
       * Ignores directory creation failures so logging never blocks MCP traffic.
       */
    }
  }

  /**
   * Logs one structured info event.
   */
  public info(event: string, details: Record<string, unknown> = {}): void {
    this.write("info", event, details);
  }

  /**
   * Logs one structured warning event.
   */
  public warn(event: string, details: Record<string, unknown> = {}): void {
    this.write("warn", event, details);
  }

  /**
   * Logs one structured error event.
   */
  public error(event: string, details: Record<string, unknown> = {}): void {
    this.write("error", event, details);
  }

  /**
   * Serializes one log entry to the configured file without touching MCP stdio streams.
   */
  private write(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>): void {
    if (!this.config.enable || !this.config.path) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...details
    };

    try {
      appendFileSync(this.config.path, `${JSON.stringify(payload)}\n`, "utf8");
    } catch {
      /**
       * Ignores append failures so the gateway stays usable even if logging breaks.
       */
    }
  }
}
