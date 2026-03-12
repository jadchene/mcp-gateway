import assert from "node:assert/strict";
import test from "node:test";

import { SHUTDOWN_SIGNALS } from "../src/index.ts";

test("SHUTDOWN_SIGNALS includes SIGHUP for terminal-close shutdown on Windows", () => {
  assert.deepEqual(SHUTDOWN_SIGNALS, ["SIGINT", "SIGTERM", "SIGHUP"]);
});
