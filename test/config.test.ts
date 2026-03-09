import test from "node:test";
import assert from "node:assert/strict";
import { validateGatewayConfig } from "../src/config.ts";

test("validateGatewayConfig accepts a minimal valid stdio config", () => {
  const config = validateGatewayConfig({
    services: [
      {
        serviceId: "demo",
        name: "Demo",
        transport: {
          type: "stdio",
          command: "node"
        }
      }
    ]
  });

  assert.equal(config.services[0]?.serviceId, "demo");
});

test("validateGatewayConfig rejects duplicate service identifiers", () => {
  assert.throws(() => {
    validateGatewayConfig({
      services: [
        {
          serviceId: "demo",
          name: "Demo 1",
          transport: {
            type: "stdio",
            command: "node"
          }
        },
        {
          serviceId: "demo",
          name: "Demo 2",
          transport: {
            type: "stdio",
            command: "node"
          }
        }
      ]
    });
  }, /Duplicate serviceId/);
});

test("validateGatewayConfig rejects services without a transport", () => {
  assert.throws(() => {
    validateGatewayConfig({
      services: [
        {
          serviceId: "demo",
          name: "Demo"
        }
      ]
    });
  }, /transport must be a JSON object/);
});
