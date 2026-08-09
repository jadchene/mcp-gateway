import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../src/logger.ts";

/**
 * Verifies that the logger stays inert until file logging is enabled.
 */
test("Logger stays disabled by default", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-logger-"));
  const logPath = join(tempDir, "gateway.log");
  const logger = new Logger();

  logger.info("disabled.log");

  await assert.rejects(access(logPath));
});

/**
 * Verifies that the logger appends structured JSON lines to the configured file.
 */
test("Logger writes JSON lines to the configured file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-logger-"));
  const logPath = join(tempDir, "gateway.log");
  const logger = new Logger();

  logger.configure({
    enable: true,
    path: logPath
  });
  logger.warn("gateway.test", { value: 1 });
  await logger.flush();

  const content = await readFile(logPath, "utf8");
  const entries = content.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.level, "warn");
  assert.equal(entries[0]?.event, "gateway.test");
  assert.equal(entries[0]?.value, 1);
});

test("Logger redacts secrets and truncates attacker-controlled strings", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-logger-"));
  const logPath = join(tempDir, "gateway.log");
  const logger = new Logger();
  logger.configure({ enable: true, path: logPath, maxBytes: 50_000 });
  logger.error("gateway.test", { authorization: "Bearer secret", message: "x".repeat(9_000) });
  await logger.flush();
  const entry = JSON.parse(await readFile(logPath, "utf8")) as Record<string, unknown>;
  assert.equal(entry.authorization, "[REDACTED]");
  assert.match(entry.message as string, /\[truncated\]$/);
});
