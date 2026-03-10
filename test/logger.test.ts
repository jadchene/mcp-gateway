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

  const content = await readFile(logPath, "utf8");
  const entries = content.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.level, "warn");
  assert.equal(entries[0]?.event, "gateway.test");
  assert.equal(entries[0]?.value, 1);
});
