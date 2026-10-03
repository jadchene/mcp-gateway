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

test("gateway decorates its own confirmation with actual arguments and removes persist", () => {
  const params: ElicitRequestFormParams = {
    mode: "form", message: "Review database script", requestedSchema: { type: "object", properties: {} },
    _meta: {
      codex_request_type: "approval_request", codex_approval_kind: "mcp_tool_call",
      tool_name: "execute_script", tool_params: { databaseKey: "test", resolvedSql: "delete from demo where id = 1" },
      tool_description: "Delete exactly one test row", codex_sensitive_action: true,
      persist: "always", trace: "approval-trace"
    }
  };
  const result = withCodexApprovalMeta(params, { name: "codex" }, "execute_script", { databaseKey: "test" }, "database", undefined, true);
  assert.equal(result._meta?.codex_strict_auto_review, true);
  assert.equal(result._meta?.persist, undefined);
  assert.equal(result._meta?.trace, "approval-trace");
  assert.equal(result._meta?.codex_sensitive_action, true);
  assert.deepEqual(result._meta?.tool_params, { databaseKey: "test" });
  assert.equal(params._meta?.persist, "always");
});

test("gateway requires synchronous approval for its own confirmations", () => {
  for (const meta of [undefined, { codex_request_type: "approval_request", codex_sensitive_action: false }]) {
    const params: ElicitRequestFormParams = {
      mode: "form", message: "Review SQL", requestedSchema: { type: "object", properties: {} },
      ...(meta ? { _meta: meta } : {})
    };
    const args = { databaseKey: "test", sql: "DROP TABLE approval_test" };
    const result = withCodexApprovalMeta(params, { name: "codex-mcp-client" }, "execute_statement", args, "database", undefined, true);
    assert.equal(result._meta?.codex_sensitive_action, true);
    assert.deepEqual(result._meta?.tool_params, args);
    assert.equal(params._meta?.codex_sensitive_action, meta?.codex_sensitive_action);
  }
});

test("gateway defaults to disabled and leaves existing metadata unchanged when disabled", () => {
  for (const enabled of [undefined, false]) {
    const params: ElicitRequestFormParams = {
      mode: "form", message: "Review SQL", requestedSchema: { type: "object", properties: {} },
      _meta: { codex_request_type: "approval_request", trace: "original", persist: "always" }
    };
    assert.equal(withCodexApprovalMeta(params, { name: "codex" }, "execute_statement", {}, "database", undefined, enabled), params);
  }
  const plain: ElicitRequestFormParams = {
    mode: "form", message: "Review", requestedSchema: { type: "object", properties: {} }
  };
  assert.equal(withCodexApprovalMeta(plain, { name: "codex" }, "deploy", {}, "demo"), plain);
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
    assert.equal(withCodexApprovalMeta(params, { name: "codex" }, "deploy", {}, "demo", undefined, true), params);
  }
  assert.equal(withCodexApprovalMeta(base, { name: "claude" }, "deploy", {}, "demo", undefined, true), base);
});
