/**
 * Provides a minimal structured logger that writes newline-delimited JSON to stderr.
 */
export class Logger {
  /**
   * Logs one structured event.
   */
  public info(event: string, details: Record<string, unknown> = {}): void {
    this.write("info", event, details);
  }

  /**
   * Logs one warning event.
   */
  public warn(event: string, details: Record<string, unknown> = {}): void {
    this.write("warn", event, details);
  }

  /**
   * Logs one error event.
   */
  public error(event: string, details: Record<string, unknown> = {}): void {
    this.write("error", event, details);
  }

  /**
   * Serializes a log entry to stderr without polluting stdout-based MCP traffic.
   */
  private write(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>): void {
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...details
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  }
}
