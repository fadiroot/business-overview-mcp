import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAnalysis } from "../analyze.js";
import { generateDiagram } from "../diagrams/mermaid.js";
import { writeReport } from "../report/html.js";
import { endpointKey } from "../extractors/endpoints.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? path.resolve(here, "../../fixtures/shop");
const a = await getAnalysis(root, true);
console.log("project:", a.index.name, "| frameworks:", a.index.frameworks.join(", "), "| dbs:", a.index.databases.join(","), "| ext:", a.index.externalServices.join(","));
console.log("features:", a.features.map((f) => `${f.name}(${f.endpoints}ep,${f.entities.length}ent,${f.loc}loc)`).join(" "));
console.log("entities:", a.model.entities.map((e) => `${e.name}[${e.fields.length}]`).join(" "));
console.log("relations:", a.model.relations.map((r) => `${r.from}-${r.kind}->${r.to}`).join(" "));
console.log("endpoints:");
for (const e of a.endpoints) console.log("  ", endpointKey(e).padEnd(34), e.isPublic ? "PUBLIC" : e.roles.length ? `roles=${e.roles.join("|")}` : e.permissions.length ? `perms=${e.permissions.join("|")}` : "auth", "guards=" + e.guards.join("|"), `${e.source.file}:${e.source.line}`, e.handler);
console.log("roles:", a.access.roles.map((r) => `${r.name}(${r.kind})`).join(" "));
console.log("perms:", a.access.permissions.map((p) => p.name).join(" "));
console.log("guards:", a.access.guards.map((g) => g.name).join(" "));
console.log("checks:", a.access.checks.length, "frontend:", a.access.frontendChecks.length, a.access.frontendChecks.map((c) => `${c.kind}:${c.roles.join("/")}`).join(" "));
console.log("matrix:", JSON.stringify(a.access.matrix.map((r) => [r.feature, r.access])));
console.log("use cases:"); for (const u of a.useCases) console.log("  ", u.id, u.name, "|", u.actors.join(","), "|", u.restrictions[0]);
console.log("findings:"); for (const f of a.findings) console.log("  ", f.severity, f.category, f.title);
for (const t of ["erd", "use_case", "architecture", "role_access", "overview", "module_dependencies", "sequence", "feature_map"] as const) { const d = generateDiagram(a, t, "mermaid", { endpoint: "POST /orders" }); console.log(`--- ${t} (${d.source.split("\n").length} lines)`); if (process.env.SHOW) console.log(d.source); }
if (process.env.SHOW) { console.log(generateDiagram(a, "use_case", "plantuml", {}).source); console.log(generateDiagram(a, "erd", "plantuml", {}).source); }
const out = writeReport(a, path.join(process.env.OUT ?? "/tmp", "bl-report"), undefined, ["html", "md", "json"]);
console.log("report:", out.join(", "));
// write each diagram for external syntax validation
import fs from "node:fs";
const ddir = path.join(process.env.OUT ?? "/tmp", "diagrams"); fs.mkdirSync(ddir, { recursive: true });
for (const t of ["erd", "use_case", "architecture", "role_access", "overview", "module_dependencies", "sequence", "feature_map"] as const) fs.writeFileSync(path.join(ddir, `${t}.mmd`), generateDiagram(a, t, "mermaid", { endpoint: "POST /orders" }).source);
for (const t of ["erd", "use_case", "architecture"] as const) fs.writeFileSync(path.join(ddir, `${t}.puml`), generateDiagram(a, t, "plantuml", {}).source);
