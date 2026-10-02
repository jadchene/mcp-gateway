import assert from "node:assert/strict";
import test from "node:test";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/client";
import { buildCodexApprovalMeta, withCodexApprovalMeta } from "../src/mcp/codex-approval.ts";

test("Codex approval metadata selects only Codex client names and snapshots actual arguments", () => {
  for (const name of ["codex", "Codex", "codex-cli", "codex-mcp-client", "codex_vscode"]) {
    const args = { environment: "test", files: ["approved.txt"] };
    const meta = buildCodexApprovalMeta({ name }, "deploy", args, "Deploy the test environment", true);
    assert.equal(meta?.codex_request_type, "approval_request");
    assert.equal(meta?.codex_approval_kind, "mcp_tool_call");
    assert.equal(meta?.codex_strict_auto_review, true);
    assert.equal(meta?.codex_sensitive_action, true);
    assert.equal(meta?.tool_name, "deploy");
    assert.deepEqual(meta?.tool_params, args);
    assert.equal(meta?.persist, undefined);
    args.files.push("unapproved.txt");
    assert.deepEqual(meta?.tool_params, { environment: "test", files: ["approved.txt"] });
  }
  for (const info of [undefined, null, {}, [], { name: 1 }, { name: "claude" }, { name: "codexia" }, { name: "not-codex" }]) {
    assert.equal(buildCodexApprovalMeta(info, "deploy", {}, "Deploy test"), undefined);
  }
});

test("gateway preserves exact downstream approval context and removes persist for strict review", () => {
  const params: ElicitRequestFormParams = {
    mode: "form", message: "Review database script", requestedSchema: { type: "object", properties: {} },
    _meta: {
      codex_request_type: "approval_request", codex_approval_kind: "mcp_tool_call",
      tool_name: "execute_script", tool_params: { databaseKey: "test", resolvedSql: "delete from demo where id = 1" },
      tool_description: "Delete exactly one test row", codex_sensitive_action: true,
      persist: "always", trace: "approval-trace"
    }
  };
  const result = withCodexApprovalMeta(params, { name: "codex" }, "execute_script", { databaseKey: "test" }, "database");
  assert.equal(result._meta?.codex_strict_auto_review, true);
  assert.equal(result._meta?.persist, undefined);
  assert.equal(result._meta?.trace, "approval-trace");
  assert.equal(result._meta?.codex_sensitive_action, true);
  assert.deepEqual(result._meta?.tool_params, params._meta?.tool_params);
  assert.equal(params._meta?.persist, "always");
});

test("gateway requires synchronous approval even when downstream omits or disables the sensitive flag", () => {
  for (const meta of [undefined, { codex_request_type: "approval_request", codex_sensitive_action: false }]) {
    const params: ElicitRequestFormParams = {
      mode: "form", message: "Review SQL", requestedSchema: { type: "object", properties: {} },
      ...(meta ? { _meta: meta } : {})
    };
    const args = { databaseKey: "test", sql: "DROP TABLE approval_test" };
    const result = withCodexApprovalMeta(params, { name: "codex-mcp-client" }, "execute_statement", args, "database");
    assert.equal(result._meta?.codex_sensitive_action, true);
    assert.deepEqual(result._meta?.tool_params, args);
    assert.equal(params._meta?.codex_sensitive_action, meta?.codex_sensitive_action);
  }
});

test("gateway leaves ordinary inputs and explicit user-input requests unchanged", () => {
  const base: ElicitRequestFormParams = {
    mode: "form", message: "Enter a value", requestedSchema: { type: "object", properties: {} }
  };
  for (const params of [
    { ...base, requestedSchema: { type: "object" as const, properties: { name: { type: "string" as const } } } },
    { ...base, _meta: { codex_requires_user_input: true } },
    { ...base, _meta: { codex_approval_kind: "browser_auth" } }
  ]) {
    assert.equal(withCodexApprovalMeta(params, { name: "codex" }, "deploy", {}, "demo"), params);
  }
  assert.equal(withCodexApprovalMeta(base, { name: "claude" }, "deploy", {}, "demo"), base);
});
