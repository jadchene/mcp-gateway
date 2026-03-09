import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, "../package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  name?: string;
  version?: string;
};

export const NAME = packageJson.name ?? "mcp-gateway-service";
export const VERSION = packageJson.version ?? "0.0.0";
