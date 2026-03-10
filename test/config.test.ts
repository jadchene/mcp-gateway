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
  assert.equal(config.services[0]?.enable, true);
  assert.deepEqual(config.logging, {
    enable: false,
    path: null
  });
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

test("validateGatewayConfig filters disabled services and keeps enabled ones", () => {
  const config = validateGatewayConfig({
    services: [
      {
        serviceId: "enabled-demo",
        name: "Enabled Demo",
        transport: {
          type: "stdio",
          command: "node"
        }
      },
      {
        serviceId: "disabled-demo",
        enable: false,
        name: "Disabled Demo",
        transport: {
          type: "stdio",
          command: "node"
        }
      }
    ]
  });

  assert.deepEqual(
    config.services.map((service) => service.serviceId),
    ["enabled-demo"]
  );
});

test("validateGatewayConfig resolves an enabled log file path from the config directory", () => {
  const config = validateGatewayConfig({
    logging: {
      enable: true,
      path: "./logs/gateway.log"
    },
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
  }, "E:/Study/mcp-gateway");

  assert.equal(config.logging.enable, true);
  assert.equal(config.logging.path, "E:\\Study\\mcp-gateway\\logs\\gateway.log");
});

test("validateGatewayConfig rejects enabled logging without a path", () => {
  assert.throws(() => {
    validateGatewayConfig({
      logging: {
        enable: true
      },
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
  }, /logging\.path/);
});
