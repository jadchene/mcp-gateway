import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from "../src/mcp/versions.ts";

test("gateway protocol allow-list contains only the three supported standard revisions", () => {
  assert.deepEqual(SUPPORTED_MCP_PROTOCOL_VERSIONS, ["2026-07-28", "2025-11-25", "2025-06-18"]);
});
