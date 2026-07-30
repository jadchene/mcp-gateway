import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from "../src/mcp/versions.ts";

test("gateway protocol allow-list contains only 2026-07-28 and 2025-06-18", () => {
  assert.deepEqual(SUPPORTED_MCP_PROTOCOL_VERSIONS, ["2026-07-28", "2025-06-18"]);
});
