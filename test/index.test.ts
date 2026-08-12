import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs, SHUTDOWN_SIGNALS } from "../src/index.ts";

test("SHUTDOWN_SIGNALS includes SIGHUP for terminal-close shutdown on Windows", () => {
  assert.deepEqual(SHUTDOWN_SIGNALS, ["SIGINT", "SIGTERM", "SIGHUP"]);
});

test("parseCliArgs enables HTTP only when --http is present", () => {
  assert.throws(() => parseCliArgs(["--config", "./config.json", "--port", "3100"]), /require --http/);

  assert.deepEqual(parseCliArgs(["--http"]), {
    configPath: "config.json",
    server: {
      enable: true,
      host: "127.0.0.1",
      port: 3000,
      path: "/mcp",
      authToken: undefined,
      enableAdminTools: false,
      maxConcurrentRequests: 64,
      maxRequestBodyBytes: 16 * 1024 * 1024,
      maxLegacySessions: 256
    }
  });

  assert.deepEqual(parseCliArgs(["--config", "./config.json", "--http", "--port", "3100", "--path", "/mcp"]), {
    configPath: "./config.json",
    server: {
      enable: true,
      host: "127.0.0.1",
      port: 3100,
      path: "/mcp",
      authToken: undefined,
      enableAdminTools: false,
      maxConcurrentRequests: 64,
      maxRequestBodyBytes: 16 * 1024 * 1024,
      maxLegacySessions: 256
    }
  });
});

test("parseCliArgs rejects unknown and duplicate options", () => {
  assert.throws(() => parseCliArgs(["--wat"]), /Unknown option/);
  assert.throws(() => parseCliArgs(["--http", "--http"]), /more than once/);
});

test("parseCliArgs bounds the HTTP request body option", () => {
  assert.equal(
    parseCliArgs(["--http", "--max-request-body-bytes", "4096"]).server?.maxRequestBodyBytes,
    4096
  );
  assert.throws(
    () => parseCliArgs(["--http", "--max-request-body-bytes", String(64 * 1024 * 1024 + 1)]),
    /1 to 67108864/
  );
  assert.throws(
    () => parseCliArgs(["--max-request-body-bytes", "4096"]),
    /require --http/
  );
});

test("parseCliArgs rejects invalid HTTP path values", () => {
  assert.throws(() => {
    parseCliArgs(["--http", "--path", "mcp"]);
  }, /--path must start/);
});

test("parseCliArgs rejects the removed manual protocol mode", () => {
  assert.throws(() => {
    parseCliArgs(["--protocol-mode", "legacy"]);
  }, /protocol negotiation is automatic/);
});
