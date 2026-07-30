import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs, SHUTDOWN_SIGNALS } from "../src/index.ts";

test("SHUTDOWN_SIGNALS includes SIGHUP for terminal-close shutdown on Windows", () => {
  assert.deepEqual(SHUTDOWN_SIGNALS, ["SIGINT", "SIGTERM", "SIGHUP"]);
});

test("parseCliArgs enables HTTP only when --http is present", () => {
  assert.equal(parseCliArgs(["--config", "./config.json", "--port", "3100"]).server, undefined);

  assert.deepEqual(parseCliArgs(["--http"]), {
    configPath: "config.json",
    server: {
      enable: true,
      host: "127.0.0.1",
      port: 3000,
      path: "/mcp"
    }
  });

  assert.deepEqual(parseCliArgs(["--config", "./config.json", "--http", "--port", "3100", "--path", "/mcp"]), {
    configPath: "./config.json",
    server: {
      enable: true,
      host: "127.0.0.1",
      port: 3100,
      path: "/mcp"
    }
  });
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
