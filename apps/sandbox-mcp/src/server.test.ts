import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.ts";

async function connect(info = { name: "web", harness: "claude-code", desktop: true }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(info).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

test("answers initialize as beambox", async () => {
  const client = await connect();
  assert.equal(client.getServerVersion()?.name, "beambox");
  assert.ok(client.getServerCapabilities()?.tools);
});

test("lists sandbox_info as its one tool", async () => {
  const { tools } = await (await connect()).listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["sandbox_info"],
  );
});

test("sandbox_info returns the sandbox's name, harness and desktop", async () => {
  const result = await (await connect({ name: "api", harness: "codex", desktop: false })).callTool({
    name: "sandbox_info",
    arguments: {},
  });
  assert.deepEqual(result.structuredContent, { name: "api", harness: "codex", desktop: false });
  assert.deepEqual(result.content, [
    { type: "text", text: JSON.stringify({ name: "api", harness: "codex", desktop: false }) },
  ]);
});
