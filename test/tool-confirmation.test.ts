import assert from "node:assert/strict";
import test from "node:test";
import type { InputRequiredResult } from "@modelcontextprotocol/client";
import type { DownstreamCallContext, DownstreamToolResult } from "../src/mcp/client-types.ts";
import { ToolConfirmationInterceptor } from "../src/mcp/tool-confirmation.ts";

const FORM_CAPABILITIES = { elicitation: { form: {} } };

test("ToolConfirmationInterceptor errors before invocation when elicitation is unsupported", async () => {
  const interceptor = new ToolConfirmationInterceptor();
  let calls = 0;

  await assert.rejects(
    () => interceptor.execute("demo", "deploy", {}, {}, async () => {
      calls += 1;
      return { content: [] };
    }),
    /does not support form elicitation/
  );
  assert.equal(calls, 0);
});

test("ToolConfirmationInterceptor invokes only after explicit acceptance", async () => {
  const interceptor = new ToolConfirmationInterceptor();
  const args = { environment: "production" };
  const contexts: DownstreamCallContext[] = [];
  const invoke = async (context: DownstreamCallContext): Promise<DownstreamToolResult> => {
    contexts.push(context);
    return { content: [{ type: "text", text: "deployed" }] };
  };

  const first = await interceptor.execute(
    "demo",
    "deploy",
    args,
    { clientCapabilities: FORM_CAPABILITIES },
    invoke
  ) as InputRequiredResult;
  assert.equal(first.resultType, "input_required");
  assert.ok(first.requestState);
  assert.match(first.requestState, /^mcp-gateway-tool-confirmation-v1\./);
  const request = first.inputRequests?.confirm;
  assert.equal(request?.method, "elicitation/create");
  const params = request?.params as {
    message?: string;
    requestedSchema?: { properties?: { decision?: { enum?: string[] } } };
  } | undefined;
  assert.match(params?.message ?? "", /Service: "demo"/);
  assert.match(params?.message ?? "", /Tool: "deploy"/);
  assert.match(params?.message ?? "", /"environment": "production"/);
  assert.match(params?.message ?? "", /Risk: Gateway policy requires explicit confirmation/);
  assert.deepEqual(params?.requestedSchema?.properties?.decision?.enum, ["yes", "no"]);
  assert.equal(contexts.length, 0);

  const result = await interceptor.execute(
    "demo",
    "deploy",
    args,
    {
      clientCapabilities: FORM_CAPABILITIES,
      requestState: first.requestState,
      inputResponses: {
        confirm: { action: "accept", content: { decision: "yes" } }
      }
    },
    invoke
  );
  assert.deepEqual(result, { content: [{ type: "text", text: "deployed" }] });
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.requestState, undefined);
  assert.equal(contexts[0]?.inputResponses, undefined);
});

test("ToolConfirmationInterceptor does not invoke after decline or a no decision", async () => {
  for (const response of [
    { action: "decline" },
    { action: "cancel" },
    { action: "accept", content: { decision: "no" } }
  ]) {
    const interceptor = new ToolConfirmationInterceptor();
    let calls = 0;
    const first = await interceptor.execute(
      "demo",
      "delete_file",
      { path: "important.txt" },
      { clientCapabilities: FORM_CAPABILITIES },
      async () => {
        calls += 1;
        return { content: [] };
      }
    ) as InputRequiredResult;

    await assert.rejects(
      () => interceptor.execute(
        "demo",
        "delete_file",
        { path: "important.txt" },
        {
          clientCapabilities: FORM_CAPABILITIES,
          requestState: first.requestState,
          inputResponses: { confirm: response }
        },
        async () => {
          calls += 1;
          return { content: [] };
        }
      ),
      /user rejected the confirmation request/
    );
    assert.equal(calls, 0);
  }
});

test("ToolConfirmationInterceptor rejects a retry whose invocation changed", async () => {
  const interceptor = new ToolConfirmationInterceptor();
  const first = await interceptor.execute(
    "demo",
    "deploy",
    { environment: "staging" },
    { clientCapabilities: FORM_CAPABILITIES },
    async () => ({ content: [] })
  ) as InputRequiredResult;

  await assert.rejects(
    () => interceptor.execute(
      "demo",
      "deploy",
      { environment: "production" },
      {
        clientCapabilities: FORM_CAPABILITIES,
        requestState: first.requestState,
        inputResponses: {
          confirm: { action: "accept", content: { decision: "yes" } }
        }
      },
      async () => ({ content: [] })
    ),
    /state is invalid or has expired/
  );
});

test("ToolConfirmationInterceptor preserves approval across downstream input-required rounds", async () => {
  const interceptor = new ToolConfirmationInterceptor();
  const args = { operation: "deploy" };
  let calls = 0;
  const first = await interceptor.execute(
    "demo",
    "deploy",
    args,
    { clientCapabilities: FORM_CAPABILITIES },
    async () => ({ content: [] })
  ) as InputRequiredResult;

  const downstreamRound = await interceptor.execute(
    "demo",
    "deploy",
    args,
    {
      clientCapabilities: FORM_CAPABILITIES,
      requestState: first.requestState,
      inputResponses: {
        confirm: { action: "accept", content: { decision: "yes" } }
      }
    },
    async () => {
      calls += 1;
      return {
        resultType: "input_required",
        inputRequests: {},
        requestState: "downstream-state"
      };
    }
  ) as InputRequiredResult;
  assert.match(downstreamRound.requestState ?? "", /^mcp-gateway-approved-tool-continuation-v1\./);

  const completed = await interceptor.execute(
    "demo",
    "deploy",
    args,
    {
      clientCapabilities: FORM_CAPABILITIES,
      requestState: downstreamRound.requestState,
      inputResponses: { downstream: { action: "accept" } }
    },
    async (context) => {
      calls += 1;
      assert.equal(context.requestState, "downstream-state");
      return { content: [{ type: "text", text: "done" }] };
    }
  );
  assert.deepEqual(completed, { content: [{ type: "text", text: "done" }] });
  assert.equal(calls, 2);
});

test("ToolConfirmationInterceptor bounds parked confirmation state", async () => {
  const interceptor = new ToolConfirmationInterceptor({ maxStates: 1 });
  const first = await interceptor.execute(
    "demo",
    "deploy",
    {},
    { clientCapabilities: FORM_CAPABILITIES },
    async () => ({ content: [] })
  ) as InputRequiredResult;

  await assert.rejects(
    () => interceptor.execute(
      "demo",
      "delete_file",
      {},
      { clientCapabilities: FORM_CAPABILITIES },
      async () => ({ content: [] })
    ),
    /state capacity of 1 has been reached/
  );

  await assert.rejects(
    () => interceptor.execute(
      "demo",
      "deploy",
      {},
      {
        clientCapabilities: FORM_CAPABILITIES,
        requestState: first.requestState,
        inputResponses: { confirm: { action: "decline" } }
      },
      async () => ({ content: [] })
    ),
    /user rejected the confirmation request/
  );

  const next = await interceptor.execute(
    "demo",
    "delete_file",
    {},
    { clientCapabilities: FORM_CAPABILITIES },
    async () => ({ content: [] })
  ) as InputRequiredResult;
  assert.equal(next.resultType, "input_required");
});
