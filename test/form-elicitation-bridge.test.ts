import assert from "node:assert/strict";
import test from "node:test";
import { FormElicitationBridge } from "../src/mcp/form-elicitation-bridge.ts";

test("FormElicitationBridge rejects an expired continuation token", async () => {
  const bridge = new FormElicitationBridge();
  await assert.rejects(
    bridge.execute(
      "confirm",
      {},
      { requestState: "mcp-gateway-form-elicitation-v1.expired" },
      async () => ({ content: [] })
    ),
    /state is invalid or has expired/
  );
});

test("FormElicitationBridge releases a waiting call when its connection resets", async () => {
  const bridge = new FormElicitationBridge();
  const pending = bridge.execute(
    "slow",
    {},
    {},
    (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  );

  await new Promise((resolveWait) => setImmediate(resolveWait));
  bridge.reset(new Error("fixture connection closed"));
  await assert.rejects(pending, /fixture connection closed/);

  const recovered = await bridge.execute(
    "next",
    {},
    {},
    async () => ({ content: [{ type: "text", text: "ready" }] })
  );
  assert.deepEqual(recovered.content, [{ type: "text", text: "ready" }]);
});

test("FormElicitationBridge releases a parked call after the downstream request fails", async () => {
  const bridge = new FormElicitationBridge();
  let rejectDownstream!: (reason: Error) => void;
  const downstreamFailure = new Promise<never>((_resolve, reject) => {
    rejectDownstream = reject;
  });
  const first = await bridge.execute(
    "first",
    {},
    {},
    async (signal) => {
      void bridge.handle({
        mode: "form",
        message: "Confirm first",
        requestedSchema: {
          type: "object",
          properties: { confirmed: { type: "boolean" } },
          required: ["confirmed"]
        }
      }, signal).catch(() => undefined);
      return downstreamFailure;
    }
  );
  assert.equal(first.resultType, "input_required");

  const second = bridge.execute(
    "second",
    {},
    {},
    async () => ({ content: [{ type: "text", text: "second-ready" }] })
  );
  rejectDownstream(new Error("downstream timed out"));

  assert.deepEqual((await second).content, [{ type: "text", text: "second-ready" }]);
});
