import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** What Beambox tells the agent about its own sandbox. Written to `/etc/beambox/sandbox.json` at start. */
export type SandboxInfo = { name: string; harness: string; desktop: boolean };

/** Beambox's MCP server for the harness inside a sandbox. Add custom tools here. */
export function createServer(info: SandboxInfo): McpServer {
  const server = new McpServer({ name: "beambox", version: "0.1.0" });
  server.registerTool(
    "sandbox_info",
    {
      description: "This sandbox's name, which agent harness runs in it, and whether it has a desktop.",
    },
    () => ({ content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info }),
  );
  return server;
}
