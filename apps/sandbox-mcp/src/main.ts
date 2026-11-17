// `node /opt/beambox/mcp.js`: serve MCP on stdio for the harness in this sandbox.
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type SandboxInfo } from "./server.ts";

const file = process.env.BEAMBOX_SANDBOX_INFO ?? "/etc/beambox/sandbox.json";
const info = JSON.parse(readFileSync(file, "utf8")) as SandboxInfo;
void createServer(info).connect(new StdioServerTransport());
