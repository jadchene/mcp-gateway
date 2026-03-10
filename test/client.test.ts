import assert from "node:assert/strict";
import test from "node:test";

import { resolvePowerShellHost } from "../src/mcp/client.ts";

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
