import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "../index.js");
const fixture = path.resolve(here, "../../fixtures/shop");

test("MCP server exposes tools and answers scan_project / generate_diagram", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["audit_findings", "explain_feature", "extract_access_control", "extract_data_model", "extract_endpoints", "generate_diagram", "generate_report", "list_use_cases", "scan_project"]);
  const prompts = await client.listPrompts();
  assert.equal(prompts.prompts.length, 3);
  const scan = await client.callTool({ name: "scan_project", arguments: { root: fixture } });
  const txt = (scan.content as { type: string; text: string }[])[0].text;
  assert.match(txt, /acme-shop/);
  assert.match(txt, /NestJS/);
  const ep = await client.callTool({ name: "extract_endpoints", arguments: { root: fixture, format: "json" } });
  const eps = JSON.parse((ep.content as { type: string; text: string }[])[0].text) as { method: string; path: string; roles: string[] }[];
  const approve = eps.find((e) => e.path === "/orders/:id/approve");
  assert.ok(approve, "approve endpoint found");
  assert.deepEqual(approve!.roles, ["manager"]);
  const create = eps.find((e) => e.path === "/orders" && e.method === "POST");
  assert.deepEqual(create!.roles.sort(), ["customer", "manager"]);
  const dia = await client.callTool({ name: "generate_diagram", arguments: { root: fixture, type: "erd", write: false } });
  assert.match((dia.content as { type: string; text: string }[])[0].text, /erDiagram/);
  const uc = await client.callTool({ name: "list_use_cases", arguments: { root: fixture } });
  assert.match((uc.content as { type: string; text: string }[])[0].text, /Approve order/);
  await client.close();
});
