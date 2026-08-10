import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
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
    path: null,
    maxBytes: 10 * 1024 * 1024
  });
});

test("validateGatewayConfig accepts unique confirmation-required tool names", () => {
  const config = validateGatewayConfig({
    services: [{
      serviceId: "demo",
      name: "Demo",
      confirmationRequiredTools: ["delete_file", "deploy"],
      transport: { type: "stdio", command: "node" }
    }]
  });

  assert.deepEqual(config.services[0]?.confirmationRequiredTools, ["delete_file", "deploy"]);
});

test("validateGatewayConfig accepts unique disabled tool glob patterns", () => {
  const config = validateGatewayConfig({
    services: [{
      serviceId: "demo",
      name: "Demo",
      disabledTools: ["internal_*", "legacy_?"],
      transport: { type: "stdio", command: "node" }
    }]
  });

  assert.deepEqual(config.services[0]?.disabledTools, ["internal_*", "legacy_?"]);
});

test("validateGatewayConfig rejects invalid disabled tool patterns", () => {
  const service = {
    serviceId: "demo",
    name: "Demo",
    transport: { type: "stdio", command: "node" }
  };

  for (const disabledTools of ["internal_*", [""], ["legacy_*", "legacy_*"]]) {
    assert.throws(
      () => validateGatewayConfig({ services: [{ ...service, disabledTools }] }),
      /disabledTools.*unique non-empty strings/
    );
  }
});

test("validateGatewayConfig rejects invalid confirmation-required tool names", () => {
  const service = {
    serviceId: "demo",
    name: "Demo",
    transport: { type: "stdio", command: "node" }
  };

  for (const confirmationRequiredTools of ["delete_file", [""], ["deploy", "deploy"]]) {
    assert.throws(
      () => validateGatewayConfig({ services: [{ ...service, confirmationRequiredTools }] }),
      /confirmationRequiredTools.*unique non-empty strings/
    );
  }
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
  }, process.cwd());

  assert.equal(config.logging.enable, true);
  assert.equal(config.logging.path, resolve(process.cwd(), "logs/gateway.log"));
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

test("validateGatewayConfig accepts Streamable HTTP downstream transport config", () => {
  const config = validateGatewayConfig({
    services: [
      {
        serviceId: "http-demo",
        name: "HTTP Demo",
        transport: {
          type: "http",
          url: "http://127.0.0.1:3200/mcp",
          headers: {
            Authorization: "Bearer test"
          }
        }
      }
    ]
  });

  const transport = config.services[0]?.transport;
  assert.equal(transport?.type, "http");
});

test("validateGatewayConfig normalizes HTTP defaults", () => {
  const automatic = validateGatewayConfig({
    services: [{
      serviceId: "auto-http",
      name: "Automatic HTTP",
      transport: { type: "http", url: "http://127.0.0.1:3200/mcp" }
    }]
  });
  const automaticTransport = automatic.services[0]?.transport;
  assert.equal(automaticTransport?.type, "http");
});

test("validateGatewayConfig rejects removed non-standard transport options", () => {
  const baseService = {
    serviceId: "demo",
    name: "Demo"
  };

  assert.throws(() => validateGatewayConfig({
    services: [{
      ...baseService,
      transport: {
        type: "stdio",
        command: "node",
        framing: "content-length"
      }
    }]
  }), /framing is no longer supported/);

  assert.throws(() => validateGatewayConfig({
    services: [{
      ...baseService,
      transport: {
        type: "http",
        url: "http://127.0.0.1:3200/sse",
        mode: "sse"
      }
    }]
  }), /mode is no longer supported/);
});

test("validateGatewayConfig rejects removed protocol pinning", () => {
  assert.throws(() => validateGatewayConfig({
    services: [{
      serviceId: "invalid-protocol",
      name: "Invalid Protocol",
      transport: { type: "stdio", command: "node", protocolMode: "legacy" }
    }]
  }), /protocolMode is no longer supported/);

  assert.throws(() => validateGatewayConfig({
    services: [{
      serviceId: "pinned-http",
      name: "Pinned HTTP",
      transport: { type: "http", url: "http://127.0.0.1:3200/mcp", protocolMode: "modern" }
    }]
  }), /protocolMode is no longer supported/);
});

test("validateGatewayConfig rejects invalid Streamable HTTP downstream settings", () => {
  assert.throws(() => {
    validateGatewayConfig({
      services: [
        {
          serviceId: "http-demo",
          name: "HTTP Demo",
          transport: {
            type: "http",
            url: "file:///tmp/mcp"
          }
        }
      ]
    });
  }, /valid http or https URL/);
});

test("validateGatewayConfig bounds services, timeouts, and log size", () => {
  const service = { serviceId: "demo", name: "Demo", transport: { type: "stdio", command: "node" } };
  assert.throws(() => validateGatewayConfig({ services: Array.from({ length: 129 }, (_, index) => ({
    ...service,
    serviceId: `demo-${index}`
  })) }), /more than 128/);
  assert.throws(() => validateGatewayConfig({ services: [{ ...service, callTimeoutMs: 0 }] }), /callTimeoutMs/);
  assert.throws(() => validateGatewayConfig({ logging: { enable: false, maxBytes: 100 }, services: [] }), /maxBytes/);
});
