import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Logger } from "../src/logger.ts";
import {
  StdioMcpClient,
  mergeEnvironment,
  resolvePowerShellHost,
  resolveWindowsNpmShim
} from "../src/mcp/client.ts";

test("mergeEnvironment excludes secrets unless explicitly allowed", () => {
  const previous = process.env.MCP_GATEWAY_TEST_SECRET;
  process.env.MCP_GATEWAY_TEST_SECRET = "secret";
  try {
    assert.equal(mergeEnvironment({}).MCP_GATEWAY_TEST_SECRET, undefined);
    assert.equal(mergeEnvironment({}, false, ["MCP_GATEWAY_TEST_SECRET"]).MCP_GATEWAY_TEST_SECRET, "secret");
    assert.equal(mergeEnvironment({}, true).MCP_GATEWAY_TEST_SECRET, "secret");
  } finally {
    if (previous === undefined) delete process.env.MCP_GATEWAY_TEST_SECRET;
    else process.env.MCP_GATEWAY_TEST_SECRET = previous;
  }
});

test("resolvePowerShellHost prefers pwsh when both PowerShell hosts are available", () => {
  const resolved = resolvePowerShellHost((command) => command === "pwsh" || command === "powershell.exe");
  assert.equal(resolved, "pwsh");
});

test("resolvePowerShellHost falls back to powershell.exe when pwsh is unavailable", () => {
  const resolved = resolvePowerShellHost((command) => command === "powershell.exe");
  assert.equal(resolved, "powershell.exe");
});

test("resolvePowerShellHost returns null when no PowerShell host is available", () => {
  const resolved = resolvePowerShellHost(() => false);
  assert.equal(resolved, null);
});

test("resolveWindowsNpmShim rejects an entry outside the shim directory", () => {
  const resolved = resolveWindowsNpmShim(
    resolve("test/fixtures/windows-stdio-shim/escaping.cmd"),
    process.execPath,
    []
  );
  assert.equal(resolved, null);
});

test("StdioMcpClient reaps both Windows npm-shim processes used by SDK negotiation", {
  skip: process.platform !== "win32"
}, async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "mcp-gateway-shim-test-"));
  const pidFile = join(tempDirectory, "pids.txt");
  const previousPath = process.env.PATH;
  const fixtureDirectory = resolve("test/fixtures/windows-stdio-shim");
  process.env.PATH = `${fixtureDirectory};${previousPath ?? ""}`;
  let client: StdioMcpClient | undefined;

  try {
    client = new StdioMcpClient({
      serviceId: "windows-npm-shim",
      enable: true,
      name: "Windows npm shim",
      transport: {
        type: "stdio",
        command: "mcp-stdio-fixture",
        env: {
          MCP_TEST_PID_FILE: pidFile
        }
      }
    }, new Logger());
    const metadata = await client.getMetadata();
    assert.equal(metadata.protocolVersion, "2025-11-25");
    assert.deepEqual(metadata.tools.map((tool) => tool.name), ["echo"]);
    assert.deepEqual(
      (await client.callTool("echo", { message: "shim" })).structuredContent,
      { echoed: "shim" }
    );
  } finally {
    await client?.dispose();
    process.env.PATH = previousPath;
  }

  let pids: number[] = [];
  try {
    pids = (await readFile(pidFile, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(Number);
    assert.equal(pids.length, 2, `Expected probe and session processes, received ${pids.join(", ")}`);
    await waitUntil(() => pids.every((pid) => !isProcessAlive(pid)), 3_000);
  } finally {
    for (const pid of pids.filter(isProcessAlive)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The process may have exited between the liveness check and the signal.
      }
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for Windows npm-shim processes to exit.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}
