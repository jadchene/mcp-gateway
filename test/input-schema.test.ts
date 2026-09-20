import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildGatewayTools } from "../src/gateway-engine.ts";
import { createInputSchema } from "../src/mcp/input-schema.ts";
import { createGatewayMcpServer } from "../src/mcp/server.ts";

test("input errors identify parameters without exposing values or union internals", async () => {
  const definitions = Object.fromEntries(buildGatewayTools().map(tool => [tool.name, tool]));
  for (const [name, args, expected] of [
    ["gateway_list_services", { serviceId: "secret-value" }, /Unsupported parameter "serviceId".*serviceIdFilter, descFilter, availableFilter/],
    ["gateway_list_tools", { serviceId: "demo", toolNameFilter: [] }, /toolNameFilter: Array must not be empty/],
    ["gateway_list_tools", { serviceId: "demo", toolNameFilter: ["a", "a"] }, /toolNameFilter: Array items must be unique/],
    ["gateway_list_tools", { serviceId: "demo", toolNameFilter: ["a", 1] }, /toolNameFilter: Item at index 1/],
    ["gateway_list_tools", { serviceId: "demo", toolNameFilter: " " }, /toolNameFilter: Expected non-blank string/],
    ["gateway_list_tools", {}, /Missing required parameter "serviceId"/],
    ["gateway_list_services", { availableFilter: "secret-value" }, /availableFilter: Expected boolean or null/],
    ["gateway_manage_service", { serviceId: "demo", action: "secret-value" }, /action: Expected "reconnect" \| "enable" \| "disable"/],
    ["gateway_call_tool", { serviceId: "demo", toolName: "read", arguments: [] }, /arguments: Expected object/],
    ["gateway_get_tool_schema", { serviceId: "demo", toolName: null }, /toolName: Expected non-blank string or non-empty unique string array/]
  ] as const) {
    const schema = createInputSchema(definitions[name].inputSchema);
    const result = await schema["~standard"].validate(args);
    const message = result.issues?.map(issue => issue.message).join("; ") ?? "";
    assert.match(message, expected);
    assert.doesNotMatch(message, /secret-value|anyOf/);
  }
});

test("input schema preserves published contracts and valid parameter values", async () => {
  for (const tool of buildGatewayTools()) {
    const schema = createInputSchema(tool.inputSchema);
    assert.deepEqual(schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }), tool.inputSchema);
  }
  const tool = buildGatewayTools().find(tool => tool.name === "gateway_list_tools")!;
  const schema = createInputSchema(tool.inputSchema);
  for (const value of ["search", ["search"], null, undefined]) {
    const input = { serviceId: "demo", toolNameFilter: value, includeSchema: null };
    const result = await schema["~standard"].validate(input);
    assert.equal(result.issues, undefined);
    assert.deepEqual(result.value, input);
  }
});

for (const protocolVersion of ["2025-11-25", "2025-06-18"] as const) {
  test(`input error hints reach MCP clients on ${protocolVersion} without invoking tools`, async () => {
    let calls = 0;
    const server = createGatewayMcpServer({
      executeTool: async () => {
        calls += 1;
        return { content: [{ type: "text", text: "ok" }] };
      }
    } as never);
    const client = new Client({ name: "input-validation-test", version: "1.0.0" }, {
      supportedProtocolVersions: [protocolVersion]
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const [name, args, expected] of [
        ["gateway_list_services", { serviceId: "demo" }, /Unsupported parameter "serviceId".*serviceIdFilter/],
        ["gateway_list_tools", { serviceId: "demo", toolNameFilter: [] }, /toolNameFilter: Array must not be empty/]
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true);
        const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
        assert.match(text, expected);
        assert.doesNotMatch(text, /anyOf/);
      }
      assert.equal(calls, 0);
      const result = await client.callTool({
        name: "gateway_call_tool", arguments: { serviceId: "demo", toolName: "read", arguments: {} }
      });
      assert.notEqual(result.isError, true);
      assert.equal(calls, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });
}
