#!/usr/bin/env node
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getAnalysis, getSynthesis } from "./analyze.js";
import { generateDiagram, sequenceMermaid, type DiagramFormat, type DiagramType } from "./diagrams/mermaid.js";
import { writeDiagram } from "./diagrams/render.js";
import { writeReport } from "./report/html.js";
import { endpointKey } from "./extractors/endpoints.js";
import { mdTable, titleCase } from "./util.js";
import type { Analysis, Endpoint } from "./types.js";

const server = new McpServer({ name: "business-overview", version: "0.1.0" }, {
  instructions: `Business Overview scans a codebase and explains it in business terms: features, use cases, roles, restrictions, data model and architecture diagrams.
Typical flow: scan_project → extract_endpoints / extract_access_control / extract_data_model → list_use_cases → audit_findings → generate_diagram or generate_report.
Pass the absolute project path as "root". Results are cached per root; pass refresh=true after code changes.
Diagrams are Mermaid (renders in GitHub, VS Code, Notion, Confluence) or PlantUML (use case, ERD, C4). generate_report writes a self-contained HTML + Markdown report into <root>/docs/business-overview by default.
If ANTHROPIC_API_KEY is available to this server, list_use_cases/generate_report with mode="claude" add a narrative business analysis from Claude.`,
});

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));
const rootArg = z.string().describe("Absolute path of the project to analyse (a mounted path such as /workspace when running in Docker).");
const refreshArg = z.boolean().optional().describe("Re-scan the project instead of using the cached analysis.");
const fmtArg = z.enum(["markdown", "json"]).optional().describe("Output format (default markdown).");

function epLine(e: Endpoint): (string | number)[] {
  return [e.method, e.path, e.feature, e.isPublic ? "public" : e.roles.length ? `roles: ${e.roles.join(", ")}` : e.permissions.length ? `perms: ${e.permissions.join(", ")}` : "authenticated", e.guards.filter((g) => !g.startsWith("path-rule")).slice(0, 3).join(", "), `${e.source.file}:${e.source.line}`];
}

function summary(a: Analysis): string {
  const langs = Object.entries(a.index.languages).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(", ");
  const L = [
    `# ${a.index.name}`,
    "",
    `- Root: ${a.index.root}`,
    `- Frameworks: ${a.index.frameworks.join(", ") || "none detected"}`,
    `- Databases: ${a.index.databases.join(", ") || "not detected"} · ORMs: ${a.model.orms.join(", ") || "none"}`,
    `- External services: ${a.index.externalServices.join(", ") || "none detected"}`,
    `- Files: ${a.index.files.length.toLocaleString()} · LOC: ${a.index.totalLoc.toLocaleString()} (${langs})`,
    `- Endpoints: ${a.endpoints.length} (${a.endpoints.filter((e) => e.isPublic).length} public, ${a.endpoints.filter((e) => e.roles.length || e.permissions.length).length} role/permission restricted)`,
    `- Entities: ${a.model.entities.length} · Relations: ${a.model.relations.length}`,
    `- Roles: ${a.access.roles.map((r) => r.name).join(", ") || "none detected"}`,
    `- Permissions: ${a.access.permissions.length} · Backend checks: ${a.access.checks.length} · Frontend checks: ${a.access.frontendChecks.length}`,
    `- Use cases (heuristic): ${a.useCases.length} · Findings: ${a.findings.length} (${a.findings.filter((f) => f.severity === "high").length} high)`,
    "",
    `## Business features (${a.features.filter((f) => f.endpoints || f.entities.length).length})`,
    "",
    mdTable(["Feature", "Endpoints", "Entities", "Files", "LOC", "Paths"], a.features.filter((f) => f.endpoints || f.entities.length).map((f) => [f.name, f.endpoints, f.entities.slice(0, 5).join(", ") + (f.entities.length > 5 ? ` +${f.entities.length - 5}` : ""), f.files, f.loc, f.paths.slice(0, 2).join(", ")])),
    "",
    `## UI pages & support modules (${a.features.filter((f) => !f.endpoints && !f.entities.length).length}, no endpoints or entities)`,
    "",
    a.features.filter((f) => !f.endpoints && !f.entities.length).map((f) => `${f.name} (${f.loc})`).join(", ") || "_none_",
    "",
    "Next: extract_endpoints, extract_access_control, extract_data_model, list_use_cases, audit_findings, generate_diagram (erd | use_case | architecture | role_access | overview | module_dependencies | sequence | feature_map), generate_report.",
  ];
  return L.join("\n");
}

server.registerTool("scan_project", {
  title: "Scan project",
  description: "Index a codebase: languages, frameworks, databases, external services, features (modules) and headline counts of endpoints, entities, roles and findings. Run this first.",
  inputSchema: { root: rootArg, refresh: refreshArg, format: fmtArg },
}, async ({ root, refresh, format }) => {
  const a = await getAnalysis(root, refresh);
  if (format === "json") return json({ ...a.index, files: undefined, fileCount: a.index.files.length, features: a.features, counts: { endpoints: a.endpoints.length, entities: a.model.entities.length, roles: a.access.roles.length, useCases: a.useCases.length, findings: a.findings.length } });
  return text(summary(a));
});

server.registerTool("extract_data_model", {
  title: "Extract data model",
  description: "Entities, fields and relations from Prisma, TypeORM, Mongoose, Drizzle, Sequelize, Knex, SQLAlchemy, Django, Eloquent, Laravel migrations, JPA, GORM, SQL DDL and GraphQL SDL.",
  inputSchema: { root: rootArg, feature: z.string().optional().describe("Only entities belonging to this feature."), format: fmtArg, refresh: refreshArg },
}, async ({ root, feature, format, refresh }) => {
  const a = await getAnalysis(root, refresh);
  const ents = a.model.entities.filter((e) => !feature || e.feature === feature);
  const names = new Set(ents.map((e) => e.name));
  const rels = a.model.relations.filter((r) => names.has(r.from) || names.has(r.to));
  if (format === "json") return json({ orms: a.model.orms, databases: a.model.databases, entities: ents, relations: rels, enums: a.model.enums });
  const L = [`# Data model${feature ? ` — ${feature}` : ""}`, "", `ORMs: ${a.model.orms.join(", ") || "none"} · Databases: ${a.model.databases.join(", ") || "n/a"} · ${ents.length} entities · ${rels.length} relations`, ""];
  for (const e of ents) L.push(`## ${e.name}${e.table && e.table !== e.name ? ` (table ${e.table})` : ""}`, `_${e.orm} · feature ${e.feature} · ${e.source.file}:${e.source.line}_`, "", e.fields.map((f) => `- ${f.name}: ${f.type}${f.pk ? " **PK**" : ""}${f.fk ? ` → ${f.fk}` : ""}${f.nullable ? " (nullable)" : ""}${f.unique ? " (unique)" : ""}`).join("\n") || "- (no fields parsed)", "");
  if (rels.length) L.push("## Relations", "", mdTable(["From", "Kind", "To", "Field", "Source"], rels.map((r) => [r.from, r.kind, r.to, r.field ?? "", `${r.source.file}:${r.source.line}`])), "");
  if (a.model.enums.length) L.push("## Enums", "", ...a.model.enums.map((e) => `- ${e.name}: ${e.values.join(", ")}`));
  return text(L.join("\n"));
});

server.registerTool("extract_endpoints", {
  title: "Extract endpoints",
  description: "HTTP/GraphQL/tRPC endpoints with the guards, roles and permissions that protect them. Supports Express-style routers, NestJS, Next.js, tRPC, FastAPI, Flask, Django (+DRF), Laravel, Spring, ASP.NET Core, Go routers, Rails and GraphQL SDL.",
  inputSchema: { root: rootArg, feature: z.string().optional(), role: z.string().optional().describe("Only endpoints this role may call."), unprotected_only: z.boolean().optional().describe("Only endpoints with no detected authentication."), format: fmtArg, refresh: refreshArg },
}, async ({ root, feature, role, unprotected_only, format, refresh }) => {
  const a = await getAnalysis(root, refresh);
  let eps = a.endpoints;
  if (feature) eps = eps.filter((e) => e.feature === feature);
  if (unprotected_only) eps = eps.filter((e) => e.isPublic);
  if (role) eps = eps.filter((e) => e.isPublic || (!e.roles.length && !e.permissions.length) || e.roles.includes(role.toLowerCase()));
  if (format === "json") return json(eps);
  const byFw = new Map<string, number>();
  for (const e of eps) byFw.set(e.framework, (byFw.get(e.framework) ?? 0) + 1);
  return text([`# Endpoints (${eps.length})`, "", `Frameworks: ${Array.from(byFw.entries()).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`, "", mdTable(["Method", "Path", "Feature", "Access", "Guards", "Source"], eps.map(epLine))].join("\n"));
});

server.registerTool("extract_access_control", {
  title: "Extract access control",
  description: "Roles, permissions, guards/policies, path-level rules, backend and frontend access checks, and the role × feature access matrix.",
  inputSchema: { root: rootArg, format: fmtArg, refresh: refreshArg, include_checks: z.boolean().optional().describe("Include the raw list of inline checks (can be long).") },
}, async ({ root, format, refresh, include_checks }) => {
  const a = await getAnalysis(root, refresh);
  if (format === "json") return json(include_checks ? a.access : { ...a.access, checks: a.access.checks.length, frontendChecks: a.access.frontendChecks.length });
  const L = ["# Access control", "", "## Roles", "", a.access.roles.length ? mdTable(["Role", "Defined as", "Raw", "Endpoints allowing", "Where"], a.access.roles.map((r) => [r.name, r.kind, r.raw.slice(0, 3).join(" | "), a.endpoints.filter((e) => e.roles.includes(r.name)).length, r.sources.slice(0, 2).map((s) => `${s.file}:${s.line}`).join(", ")])) : "_No roles detected._", ""];
  L.push(`## Permissions (${a.access.permissions.length})`, "", a.access.permissions.slice(0, 100).map((p) => `\`${p.name}\``).join(" ") || "_none_", "");
  L.push(`## Guards / policies / middleware (${a.access.guards.length})`, "", a.access.guards.slice(0, 80).map((g) => `- ${g.name} (${g.kind}) — ${g.source.file}:${g.source.line}`).join("\n") || "_none_", "");
  L.push(`## Path rules (${a.access.pathRules.length})`, "", a.access.pathRules.length ? mdTable(["Pattern", "Effect", "Roles", "Permissions", "Source"], a.access.pathRules.map((p) => [p.pattern, p.effect, p.roles.join(", "), p.permissions.join(", "), `${p.source.file}:${p.source.line}`])) : "_none_", "");
  L.push("## Access matrix (● full · ◐ partial · ○ none · ? permission-based)", "", mdTable(["Feature", "Endpoints", ...a.access.actors.map(titleCase)], a.access.matrix.map((r) => [r.feature, `${r.endpoints}${r.publicEndpoints ? ` (${r.publicEndpoints} public)` : ""}`, ...a.access.actors.map((x) => ({ full: "●", partial: "◐", none: "○", unknown: "?" })[r.access[x]] ?? "?")])), "");
  L.push(`## Backend checks: ${a.access.checks.length} · Frontend checks: ${a.access.frontendChecks.length}`, "");
  if (include_checks) {
    L.push("### Backend", "", mdTable(["Kind", "Roles", "Permissions", "Feature", "Snippet", "Source"], a.access.checks.slice(0, 150).map((c) => [c.kind, c.roles.join(", "), c.permissions.join(", "), c.feature, c.snippet, `${c.source.file}:${c.source.line}`])), "");
    L.push("### Frontend", "", mdTable(["Kind", "Roles", "Feature", "Snippet", "Source"], a.access.frontendChecks.slice(0, 100).map((c) => [c.kind, c.roles.join(", "), c.feature, c.snippet, `${c.source.file}:${c.source.line}`])), "");
  } else L.push("_Pass include_checks=true to list every inline check with its snippet and location._");
  return text(L.join("\n"));
});

server.registerTool("list_use_cases", {
  title: "List use cases",
  description: "Business use cases derived from endpoints + roles. mode=heuristic is instant and deterministic; mode=claude asks Claude to merge/rename them into real business use cases with preconditions, flows, restrictions and a feature assessment (needs ANTHROPIC_API_KEY on the server).",
  inputSchema: { root: rootArg, feature: z.string().optional(), actor: z.string().optional().describe("Filter by actor/role name."), mode: z.enum(["heuristic", "claude"]).optional(), format: fmtArg, refresh: refreshArg },
}, async ({ root, feature, actor, mode, format, refresh }) => {
  let a = await getAnalysis(root, refresh);
  let note = "";
  let synthesis: Awaited<ReturnType<typeof getSynthesis>>["result"] | undefined;
  if (mode === "claude") {
    const s = await getSynthesis(root, false, feature ? `feature "${feature}"` : undefined);
    if (s.result.ok) { a = s.analysis; synthesis = s.result; note = `Claude synthesis by ${s.result.model}${s.result.servedBy ? ` (served by fallback ${s.result.servedBy})` : ""} · ${s.result.usage?.input_tokens} in / ${s.result.usage?.output_tokens} out${s.result.truncated?.length ? ` · facts truncated: ${s.result.truncated.join("; ")}` : ""}`; }
    else note = `Claude synthesis unavailable (${s.result.error}). Showing heuristic use cases.`;
  }
  let ucs = a.useCases;
  if (feature) ucs = ucs.filter((u) => u.feature === feature);
  if (actor) ucs = ucs.filter((u) => u.actors.some((x) => x.toLowerCase().includes(actor.toLowerCase())));
  if (format === "json") return json({ note, useCases: ucs, synthesis: synthesis?.synthesis });
  const L = [`# Use cases (${ucs.length})${feature ? ` — ${feature}` : ""}`, note ? `_${note}_` : "", ""];
  const byF = new Map<string, typeof ucs>();
  for (const u of ucs) { if (!byF.has(u.feature)) byF.set(u.feature, []); byF.get(u.feature)!.push(u); }
  for (const [f, list] of byF) { L.push(`## ${titleCase(f)}`, ""); for (const u of list) L.push(`### ${u.id} · ${u.name}`, `- Actors: ${u.actors.join(", ")}`, u.entities.length ? `- Data: ${u.entities.join(", ")}` : "", `- ${u.description}`, ...u.restrictions.map((r) => `- Restriction: ${r}`), u.endpoints.length ? `- Endpoints: ${u.endpoints.map((e) => `\`${e}\``).join(", ")}` : "", ""); }
  if (synthesis?.synthesis) {
    const s = synthesis.synthesis;
    L.push("## Executive summary (Claude)", "", s.executive_summary, "", ...s.what_the_product_does.map((x) => `- ${x}`), "", "## Roles (Claude)", "", ...s.roles.flatMap((r) => [`### ${titleCase(r.name)}`, r.description, `- Can: ${r.can.join("; ") || "—"}`, `- Cannot: ${r.cannot.join("; ") || "—"}`, ""]), "## Restrictions (Claude)", "", mdTable(["Rule", "Enforced at", "Risk", "Evidence"], s.restrictions.map((r) => [r.rule, r.enforced_at, r.risk ?? "—", r.evidence.slice(0, 2).join(", ")])), "", "## Feature assessment (Claude)", "", mdTable(["Feature", "Status", "Purpose", "Rationale"], s.feature_assessment.map((f) => [f.feature, f.status, f.business_purpose, f.rationale])), "", "## Over-build signals", "", ...s.over_build_signals.map((x) => `- ${x}`), "", "## Questions for the owner", "", ...s.open_questions_for_owner.map((x, i) => `${i + 1}. ${x}`));
  }
  return text(L.filter((l) => l !== undefined).join("\n"));
});

server.registerTool("audit_findings", {
  title: "Audit findings",
  description: "Over-build and access-control gaps: unprotected writes, roles/permissions defined but never checked, orphan entities, UI-only restrictions, inconsistent restrictions, duplicate endpoints, size outliers, features without behaviour.",
  inputSchema: { root: rootArg, severity: z.enum(["high", "medium", "low", "info"]).optional().describe("Minimum severity to include."), format: fmtArg, refresh: refreshArg },
}, async ({ root, severity, format, refresh }) => {
  const a = await getAnalysis(root, refresh);
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  const min = severity ? order[severity] : 3;
  const fs = a.findings.filter((f) => order[f.severity] <= min);
  if (format === "json") return json(fs);
  return text([`# Findings (${fs.length})`, "", ...fs.flatMap((f) => [`## [${f.severity.toUpperCase()}] ${f.id} · ${f.title}`, `_${f.category}${f.feature ? ` · ${f.feature}` : ""}_`, "", f.detail, f.evidence.length ? `Evidence: ${f.evidence.slice(0, 6).map((s) => `${s.file}:${s.line}`).join(", ")}` : "", ""])].join("\n"));
});

server.registerTool("explain_feature", {
  title: "Explain feature",
  description: "Deep dive on one feature: purpose signals, endpoints, use cases, roles, entities, files, findings and a sequence diagram for its main write endpoint.",
  inputSchema: { root: rootArg, feature: z.string().describe("Feature name as listed by scan_project."), refresh: refreshArg },
}, async ({ root, feature, refresh }) => {
  const a = await getAnalysis(root, refresh);
  const f = a.features.find((x) => x.name === feature) ?? a.features.find((x) => x.name.includes(feature.toLowerCase()));
  if (!f) return text(`Feature "${feature}" not found. Known features: ${a.features.map((x) => x.name).join(", ")}`);
  const eps = a.endpoints.filter((e) => e.feature === f.name);
  const ucs = a.useCases.filter((u) => u.feature === f.name);
  const roles = Array.from(new Set(eps.flatMap((e) => e.roles)));
  const ents = a.model.entities.filter((e) => f.entities.includes(e.name));
  const files = a.index.files.filter((x) => x.feature === f.name && !x.isTest).sort((x, y) => y.loc - x.loc);
  const checks = a.access.checks.filter((c) => c.feature === f.name);
  const fchecks = a.access.frontendChecks.filter((c) => c.feature === f.name);
  const findings = a.findings.filter((x) => x.feature === f.name || x.evidence.some((s) => files.some((fl) => fl.rel === s.file)));
  const main = eps.find((e) => e.method === "POST") ?? eps[0];
  const L = [`# Feature: ${titleCase(f.name)}`, "", `- Location: ${f.paths.join(", ")}`, `- ${f.files} files · ${f.loc.toLocaleString()} LOC · ${eps.length} endpoints · ${ents.length} entities`, `- Roles involved: ${roles.join(", ") || "none specific (authenticated or public only)"}`, `- Public endpoints: ${eps.filter((e) => e.isPublic).length} · Backend checks: ${checks.length} · Frontend checks: ${fchecks.length}`, "", "## Use cases", "", ...ucs.map((u) => `- **${u.name}** — ${u.actors.join(", ")}${u.restrictions.length ? ` · ${u.restrictions[0]}` : ""}`), "", "## Endpoints", "", eps.length ? mdTable(["Method", "Path", "Feature", "Access", "Guards", "Source"], eps.map(epLine)) : "_none_", "", "## Data", "", ...ents.map((e) => `- **${e.name}** (${e.orm}): ${e.fields.slice(0, 12).map((x) => x.name).join(", ")}${e.fields.length > 12 ? " …" : ""}`), "", "## Access checks in this feature", "", ...checks.slice(0, 20).map((c) => `- ${c.kind} → roles ${c.roles.join("/") || "-"} perms ${c.permissions.join("/") || "-"} · \`${c.snippet}\` (${c.source.file}:${c.source.line})`), ...fchecks.slice(0, 10).map((c) => `- UI ${c.kind} → ${c.roles.join("/") || "-"} · \`${c.snippet}\` (${c.source.file}:${c.source.line})`), "", "## Findings", "", ...(findings.length ? findings.map((x) => `- [${x.severity}] ${x.title}`) : ["_none_"]), "", "## Largest files", "", ...files.slice(0, 15).map((x) => `- ${x.rel} (${x.loc} LOC)`), ""];
  if (main) L.push(`## Sequence: ${endpointKey(main)}`, "", "```mermaid", sequenceMermaid(a, { endpoint: endpointKey(main) }), "```");
  return text(L.join("\n"));
});

server.registerTool("generate_diagram", {
  title: "Generate diagram",
  description: "Generate a diagram as Mermaid or PlantUML source. Types: erd (data model), use_case, architecture (C4 container), role_access (roles → features), overview (actors → features → data), module_dependencies (import graph between features), feature_map (mindmap), sequence (one endpoint's request flow). Writes .mmd/.puml + .html viewer to out_dir and returns instant preview links (mermaid.live, kroki.io, plantuml.com).",
  inputSchema: {
    root: rootArg,
    type: z.enum(["erd", "use_case", "architecture", "role_access", "overview", "module_dependencies", "feature_map", "sequence"]),
    format: z.enum(["mermaid", "plantuml"]).optional().describe("Default mermaid. PlantUML supported for erd, use_case, architecture."),
    feature: z.string().optional().describe("Restrict to one feature (erd, use_case, role_access, sequence)."),
    endpoint: z.string().optional().describe('For sequence: "METHOD /path".'),
    max_entities: z.number().int().positive().optional(),
    include_fields: z.boolean().optional().describe("ERD: include all fields (default true) or only keys."),
    out_dir: z.string().optional().describe("Where to write files (default <root>/docs/business-overview/diagrams)."),
    write: z.boolean().optional().describe("Write files to out_dir (default true)."),
    render_svg: z.boolean().optional().describe("Also render SVG with mermaid-cli (mmdc) if installed."),
    refresh: refreshArg,
  },
}, async ({ root, type, format, feature, endpoint, max_entities, include_fields, out_dir, write, render_svg, refresh }) => {
  const a = await getAnalysis(root, refresh);
  const d = generateDiagram(a, type as DiagramType, (format ?? "mermaid") as DiagramFormat, { feature, endpoint, maxEntities: max_entities, includeFields: include_fields });
  const L = [`# ${type} diagram (${d.format})`, d.note ? `_${d.note}_` : "", ""];
  if (write !== false) {
    const dir = out_dir ?? path.join(a.index.root, "docs", "business-overview", "diagrams");
    const base = [type, feature, endpoint?.replace(/[^\w]+/g, "_")].filter(Boolean).join("-");
    const w = writeDiagram(dir, base, d.source, d.format, `${a.index.name} · ${titleCase(type)}`, !!render_svg);
    L.push(`- Source: ${w.sourcePath}`);
    if (w.htmlPath) L.push(`- HTML viewer: ${w.htmlPath}`);
    if (w.svgPath) L.push(`- SVG: ${w.svgPath}`);
    if (w.liveUrl) L.push(`- Edit online: ${w.liveUrl}`);
    if (w.krokiUrl) L.push(`- SVG via Kroki: ${w.krokiUrl}`);
    if (w.plantumlUrl) L.push(`- PlantUML server: ${w.plantumlUrl}`);
    L.push("");
  }
  L.push("```" + d.format, d.source, "```");
  return text(L.join("\n"));
});

server.registerTool("generate_report", {
  title: "Generate enterprise report",
  description: "Write a self-contained HTML report (plus Markdown and optional JSON facts) with executive summary, feature inventory, actors & roles, use cases, role × feature access matrix, restrictions, ERD, C4 architecture, module dependencies, endpoint catalogue and findings. mode=claude adds Claude's narrative analysis and owner questions.",
  inputSchema: { root: rootArg, out_dir: z.string().optional().describe("Default <root>/docs/business-overview"), mode: z.enum(["heuristic", "claude"]).optional(), formats: z.array(z.enum(["html", "md", "json"])).optional(), refresh: refreshArg },
}, async ({ root, out_dir, mode, formats, refresh }) => {
  let a = await getAnalysis(root, refresh);
  let synthesis: import("./analysis/claude.js").Synthesis | undefined;
  let note = "";
  if (mode === "claude") {
    const s = await getSynthesis(root, false);
    if (s.result.ok) { a = s.analysis; synthesis = s.result.synthesis; note = `Claude synthesis: ${s.result.model} (${s.result.usage?.input_tokens} in / ${s.result.usage?.output_tokens} out)`; }
    else note = `Claude synthesis unavailable: ${s.result.error}. Report generated in heuristic mode.`;
  }
  const dir = out_dir ?? path.join(a.index.root, "docs", "business-overview");
  const written = writeReport(a, dir, synthesis, formats ?? ["html", "md"]);
  return text([`# Report written`, note ? `_${note}_` : "", "", ...written.map((p) => `- ${p}`), "", `Open the HTML file in a browser (diagrams render client-side via Mermaid). ${a.endpoints.length} endpoints, ${a.useCases.length} use cases, ${a.access.roles.length} roles, ${a.model.entities.length} entities, ${a.findings.length} findings.`].join("\n"));
});

// ---------- Prompts ----------
server.registerPrompt("business_overview", {
  title: "Business overview",
  description: "Explain a codebase to a business owner: what it does, who can do what, and where it is over-built.",
  argsSchema: { root: z.string().describe("Absolute project path") },
}, ({ root }) => ({
  messages: [{ role: "user", content: { type: "text", text: `Use the business-overview tools on the project at ${root}. Steps: 1) scan_project. 2) extract_access_control. 3) list_use_cases (mode=claude if available, else heuristic). 4) audit_findings. 5) generate_diagram type=overview and type=use_case. Then write, for a non-technical business owner: what the product does (one paragraph), the actors/roles and what each can and cannot do (table), the main use cases per feature, the top risks and over-built areas with file evidence, and 5 decisions the owner should make. Finish by calling generate_report so they get the HTML.` } }],
}));

server.registerPrompt("feature_deep_dive", {
  title: "Feature deep dive",
  description: "Understand one feature end to end: endpoints, roles, data, flow, findings.",
  argsSchema: { root: z.string(), feature: z.string() },
}, ({ root, feature }) => ({
  messages: [{ role: "user", content: { type: "text", text: `Use business-overview explain_feature on root=${root} feature=${feature}, then generate_diagram type=erd feature=${feature} and type=sequence feature=${feature}. Explain to a new engineer how the feature works, who may use it, the data it touches, and anything that looks unfinished, duplicated or unprotected. Cite files.` } }],
}));

server.registerPrompt("access_review", {
  title: "Access review",
  description: "Review roles, permissions and restrictions and produce a role × action matrix with gaps.",
  argsSchema: { root: z.string() },
}, ({ root }) => ({
  messages: [{ role: "user", content: { type: "text", text: `Run business-overview extract_access_control (include_checks=true), extract_endpoints, and audit_findings on ${root}. Produce: the role × feature matrix in plain words; every restriction that exists only in the frontend; every write endpoint without authentication; roles or permissions defined but never enforced; and a recommended target matrix for the owner to confirm. Generate generate_diagram type=role_access.` } }],
}));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => { console.error(e); process.exit(1); });
