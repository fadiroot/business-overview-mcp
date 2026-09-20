import fs from "node:fs";
import path from "node:path";
import type { Analysis } from "../types.js";
import type { Synthesis } from "../analysis/claude.js";
import { architectureMermaid, erdMermaid, moduleDependencyMermaid, overviewMermaid, roleAccessMermaid, useCaseMermaid, useCasePlantUml } from "../diagrams/mermaid.js";
import { escapeHtml, plantumlServerUrl } from "../diagrams/render.js";
import { endpointKey } from "../extractors/endpoints.js";
import { mdTable, titleCase } from "../util.js";

const esc = escapeHtml;

function accessCell(level: string): string {
  const map: Record<string, [string, string]> = { full: ["●", "Full access"], partial: ["◐", "Partial access"], none: ["○", "No access"], unknown: ["?", "Permission-based, unresolved"] };
  const [sym, title] = map[level] ?? ["?", level];
  return `<td class="acc acc-${level}" title="${title}">${sym}</td>`;
}

export function buildHtmlReport(a: Analysis, synthesis?: Synthesis): string {
  const feats = a.features;
  const biz = feats.filter((f) => f.endpoints || f.entities.length);
  const support = feats.filter((f) => !f.endpoints && !f.entities.length);
  const publicEps = a.endpoints.filter((e) => e.isPublic).length;
  const restrictedEps = a.endpoints.filter((e) => e.roles.length || e.permissions.length).length;
  const diagrams: [string, string, string][] = [
    ["overview", "System overview: actors → features → data", overviewMermaid(a)],
    ["usecases", "Use case diagram", useCaseMermaid(a, { maxUseCases: 60 })],
    ["roles", "Role access graph", roleAccessMermaid(a, {})],
    ["erd", "Data model (ERD)", erdMermaid(a, { maxEntities: 45 })],
    ["arch", "Architecture (C4 container)", architectureMermaid(a)],
    ["deps", "Module dependencies", moduleDependencyMermaid(a)],
  ];
  const pumlUrl = plantumlServerUrl(useCasePlantUml(a, { maxUseCases: 60 }));
  const sevBadge = (s: string) => `<span class="badge sev-${s}">${s}</span>`;
  const useCases = a.useCases;
  const byFeatureUC = new Map<string, typeof useCases>();
  for (const u of useCases) { if (!byFeatureUC.has(u.feature)) byFeatureUC.set(u.feature, []); byFeatureUC.get(u.feature)!.push(u); }

  const nav = ["summary", "features", "actors", "usecases", "matrix", "restrictions", "data", "architecture", "endpoints", "findings", synthesis ? "questions" : ""].filter(Boolean);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.index.name)} · Business Overview</title>
<style>
:root{--bg:#f6f7fb;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--acc:#2563eb;--full:#16a34a;--partial:#d97706;--none:#cbd5e1;--unk:#7c3aed;--high:#dc2626;--medium:#d97706;--low:#2563eb;--info:#64748b}
@media(prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#111a2e;--ink:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--none:#334155}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:32px 24px 16px;max-width:1200px;margin:0 auto}header h1{margin:0 0 4px;font-size:28px}header p{margin:0;color:var(--muted)}
nav{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);z-index:5}nav div{max-width:1200px;margin:0 auto;padding:8px 24px;display:flex;gap:14px;flex-wrap:wrap;font-size:13px}nav a{color:var(--muted);text-decoration:none}nav a:hover{color:var(--acc)}
main{max-width:1200px;margin:0 auto;padding:16px 24px 64px}section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin:18px 0}
h2{margin:0 0 12px;font-size:20px}h3{margin:18px 0 8px;font-size:16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:12px 0}.kpi{border:1px solid var(--line);border-radius:12px;padding:12px 14px}.kpi b{display:block;font-size:24px}.kpi span{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.acc{text-align:center;font-size:16px}.acc-full{color:var(--full)}.acc-partial{color:var(--partial)}.acc-none{color:var(--none)}.acc-unknown{color:var(--unk)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;color:#fff;text-transform:uppercase}.sev-high{background:var(--high)}.sev-medium{background:var(--medium)}.sev-low{background:var(--low)}.sev-info{background:var(--info)}
.tag{display:inline-block;padding:1px 7px;border:1px solid var(--line);border-radius:6px;font-size:12px;margin:1px 2px;color:var(--muted)}.lock{color:var(--partial)}.pub{color:var(--full)}
.muted{color:var(--muted)}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:rgba(100,116,139,.12);padding:1px 5px;border-radius:5px}
.dia{overflow:auto;border:1px dashed var(--line);border-radius:12px;padding:10px;margin:8px 0 4px;background:var(--card)}pre.mermaid{margin:0;visibility:hidden}pre.mermaid[data-processed]{visibility:visible}
details summary{cursor:pointer;color:var(--acc)}.uc{border-left:3px solid var(--acc);padding:6px 12px;margin:8px 0}.uc b{display:block}.uc small{color:var(--muted)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:18px}@media(max-width:800px){.two{grid-template-columns:1fr}}
ul{margin:6px 0;padding-left:20px}li{margin:3px 0}.wrap{overflow:auto}
@media print{nav{display:none}section{break-inside:avoid;border:none}body{background:#fff}}
</style></head><body>
<header><h1>${esc(a.index.name)} — Business Overview report</h1><p>Generated ${new Date(a.index.scannedAt).toLocaleString()} · ${a.index.frameworks.join(", ") || "frameworks not detected"} · ${a.index.totalLoc.toLocaleString()} lines of code · ${synthesis ? "with Claude synthesis" : "heuristic mode (no LLM)"}</p></header>
<nav><div>${nav.map((n) => `<a href="#${n}">${titleCase(n)}</a>`).join("")}</div></nav>
<main>
<section id="summary"><h2>Executive summary</h2>
${synthesis ? `<p>${esc(synthesis.executive_summary)}</p><h3>What the product does</h3><ul>${synthesis.what_the_product_does.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : `<p>This report was produced by scanning the source code. It lists what the software can do (use cases), who can do it (roles and restrictions), what data it manages, and where the code looks over-built or under-protected. Set <code>ANTHROPIC_API_KEY</code> and run <code>generate_report</code> with <code>mode: "claude"</code> for a narrative business analysis.</p>`}
<div class="kpis">
<div class="kpi"><b>${feats.filter((f) => f.endpoints || f.entities.length).length}</b><span>features with behaviour</span></div>
<div class="kpi"><b>${useCases.length}</b><span>use cases</span></div>
<div class="kpi"><b>${a.access.roles.length}</b><span>roles</span></div>
<div class="kpi"><b>${a.endpoints.length}</b><span>endpoints (${publicEps} public · ${restrictedEps} role/permission restricted)</span></div>
<div class="kpi"><b>${a.model.entities.length}</b><span>data entities · ${a.model.relations.length} relations</span></div>
<div class="kpi"><b>${a.findings.filter((f) => f.severity === "high").length}</b><span>high-severity findings</span></div>
</div>
<div class="dia"><pre class="mermaid">${esc(diagrams[0][2])}</pre></div><p class="muted">Solid arrows = full access to a feature's endpoints, thin arrows = partial. Dotted = feature → data entity.</p>
</section>

<section id="features"><h2>Feature inventory</h2>
<h3>Business features (${biz.length})</h3><div class="wrap"><table><thead><tr><th>Feature</th><th>Purpose${synthesis ? " (Claude)" : ""}</th><th>Status</th><th>Endpoints</th><th>Entities</th><th>Files</th><th>LOC</th><th>Location</th></tr></thead><tbody>
${biz.map((f) => { const fa = synthesis?.feature_assessment.find((x) => x.feature === f.name); return `<tr><td><b>${esc(titleCase(f.name))}</b></td><td>${fa ? esc(fa.business_purpose) : `<span class="muted">${f.endpoints ? "exposes " + f.endpoints + " endpoints" : f.entities.length ? "data only" : "support code"}</span>`}</td><td>${fa ? `<span class="tag">${esc(fa.status.replace("_", " "))}</span>` : ""}</td><td>${f.endpoints}</td><td>${f.entities.slice(0, 6).map((e) => `<span class="tag">${esc(e)}</span>`).join("")}${f.entities.length > 6 ? `<span class="tag">+${f.entities.length - 6}</span>` : ""}</td><td>${f.files}</td><td>${f.loc.toLocaleString()}</td><td class="muted">${f.paths.slice(0, 2).map(esc).join("<br>")}</td></tr>`; }).join("")}
</tbody></table></div>
<h3>UI pages &amp; support modules (${support.length})</h3><p class="muted">Code with no endpoints and no entities of its own: frontend pages, shared components, infrastructure. Listed for completeness.</p><details><summary>Show ${support.length} modules (${support.reduce((n, f) => n + f.loc, 0).toLocaleString()} LOC)</summary><div class="wrap"><table><thead><tr><th>Feature</th><th>Purpose${synthesis ? " (Claude)" : ""}</th><th>Status</th><th>Endpoints</th><th>Entities</th><th>Files</th><th>LOC</th><th>Location</th></tr></thead><tbody>
${support.map((f) => { const fa = synthesis?.feature_assessment.find((x) => x.feature === f.name); return `<tr><td><b>${esc(titleCase(f.name))}</b></td><td>${fa ? esc(fa.business_purpose) : `<span class="muted">${f.endpoints ? "exposes " + f.endpoints + " endpoints" : f.entities.length ? "data only" : "support code"}</span>`}</td><td>${fa ? `<span class="tag">${esc(fa.status.replace("_", " "))}</span>` : ""}</td><td>${f.endpoints}</td><td>${f.entities.slice(0, 6).map((e) => `<span class="tag">${esc(e)}</span>`).join("")}${f.entities.length > 6 ? `<span class="tag">+${f.entities.length - 6}</span>` : ""}</td><td>${f.files}</td><td>${f.loc.toLocaleString()}</td><td class="muted">${f.paths.slice(0, 2).map(esc).join("<br>")}</td></tr>`; }).join("")}
</tbody></table></div></details></section>

<section id="actors"><h2>Actors & roles</h2>
${synthesis ? `<div class="two"><div><h3>Actors</h3><ul>${synthesis.actors.map((x) => `<li><b>${esc(x.name)}</b>${x.is_human ? "" : " <span class='tag'>system</span>"} — ${esc(x.description)}</li>`).join("")}</ul></div><div><h3>Roles</h3>${synthesis.roles.map((r) => `<div class="uc"><b>${esc(titleCase(r.name))}</b><small>${esc(r.description)}</small><div><b style="font-size:12px;display:inline">Can:</b> ${r.can.map(esc).join("; ") || "—"}</div><div><b style="font-size:12px;display:inline">Cannot:</b> ${r.cannot.map(esc).join("; ") || "—"}</div></div>`).join("")}</div></div>`
  : `<div class="wrap"><table><thead><tr><th>Role</th><th>Defined as</th><th>Raw names</th><th>Endpoints allowing it</th><th>Where defined</th></tr></thead><tbody>${a.access.roles.map((r) => `<tr><td><b>${esc(titleCase(r.name))}</b></td><td>${r.kind}</td><td>${r.raw.slice(0, 4).map((x) => `<code>${esc(x)}</code>`).join(" ")}</td><td>${a.endpoints.filter((e) => e.roles.includes(r.name)).length}</td><td class="muted">${r.sources.slice(0, 2).map((s) => `${esc(s.file)}:${s.line}`).join("<br>")}</td></tr>`).join("")}${a.access.roles.length ? "" : `<tr><td colspan="5" class="muted">No roles detected.</td></tr>`}</tbody></table></div>`}
${a.access.permissions.length ? `<details><summary>${a.access.permissions.length} permissions detected</summary><p>${a.access.permissions.slice(0, 150).map((p) => `<code>${esc(p.name)}</code>`).join(" ")}</p></details>` : ""}
${a.access.guards.length ? `<details><summary>${a.access.guards.length} guards / policies / auth middleware</summary><p>${a.access.guards.slice(0, 120).map((g) => `<span class="tag" title="${esc(g.source.file)}">${esc(g.name)}</span>`).join("")}</p></details>` : ""}
</section>

<section id="usecases"><h2>Use cases</h2>
<div class="dia"><pre class="mermaid">${esc(diagrams[1][2])}</pre></div>
<p class="muted">🔒 = restricted to specific roles/permissions. Green = public. <a href="${pumlUrl}" target="_blank" rel="noopener">Open as UML use-case diagram (PlantUML)</a>.</p>
${Array.from(byFeatureUC.entries()).map(([feat, list]) => `<h3>${esc(titleCase(feat))}</h3>${list.map((u) => `<div class="uc"><b>${esc(u.id)} · ${esc(u.name)}</b><small>Actors: ${u.actors.map(esc).join(", ")}${u.entities.length ? ` · Data: ${u.entities.map(esc).join(", ")}` : ""}</small><div>${esc(u.description)}</div>${u.restrictions.length ? `<div class="muted">${u.restrictions.map(esc).join(" · ")}</div>` : ""}${u.endpoints.length ? `<div>${u.endpoints.slice(0, 8).map((e) => `<code>${esc(e)}</code>`).join(" ")}${u.endpoints.length > 8 ? ` <span class="muted">+${u.endpoints.length - 8}</span>` : ""}</div>` : ""}</div>`).join("")}`).join("")}
</section>

<section id="matrix"><h2>Access matrix (role × feature)</h2>
<p class="muted">● full access to all endpoints of the feature · ◐ partial · ○ none · ? permission-based (role mapping not resolved). "Authenticated" = any logged-in user without a specific role; "anonymous" = not logged in.</p>
<div class="wrap"><table><thead><tr><th>Feature</th><th>Endpoints</th>${a.access.actors.map((x) => `<th style="text-align:center">${esc(titleCase(x))}</th>`).join("")}</tr></thead><tbody>
${a.access.matrix.map((r) => `<tr><td><b>${esc(titleCase(r.feature))}</b></td><td>${r.endpoints}${r.publicEndpoints ? ` <span class="muted">(${r.publicEndpoints} public)</span>` : ""}</td>${a.access.actors.map((x) => accessCell(r.access[x])).join("")}</tr>`).join("")}
</tbody></table></div>
<div class="dia"><pre class="mermaid">${esc(diagrams[2][2])}</pre></div>
</section>

<section id="restrictions"><h2>Restrictions & business rules</h2>
${synthesis ? `<div class="wrap"><table><thead><tr><th>Rule</th><th>Enforced at</th><th>Risk</th><th>Evidence</th></tr></thead><tbody>${synthesis.restrictions.map((r) => `<tr><td>${esc(r.rule)}</td><td><span class="tag">${esc(r.enforced_at)}</span></td><td>${r.risk ? esc(r.risk) : "—"}</td><td class="muted">${r.evidence.slice(0, 3).map(esc).join("<br>")}</td></tr>`).join("")}</tbody></table></div>` : ""}
<h3>Path-level rules</h3>${a.access.pathRules.length ? `<div class="wrap"><table><thead><tr><th>Pattern</th><th>Effect</th><th>Roles</th><th>Permissions</th><th>Source</th></tr></thead><tbody>${a.access.pathRules.map((p) => `<tr><td><code>${esc(p.pattern)}</code></td><td>${p.effect}</td><td>${p.roles.map(esc).join(", ")}</td><td>${p.permissions.map(esc).join(", ")}</td><td class="muted">${esc(p.source.file)}:${p.source.line}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No path-level rules (Spring matchers, Express prefix middleware, Next.js middleware matcher) detected.</p>`}
<h3>Backend checks (${a.access.checks.length})</h3><details><summary>Show first ${Math.min(80, a.access.checks.length)}</summary><div class="wrap"><table><thead><tr><th>Kind</th><th>Roles</th><th>Permissions</th><th>Feature</th><th>Snippet</th><th>Source</th></tr></thead><tbody>${a.access.checks.slice(0, 80).map((c) => `<tr><td>${esc(c.kind)}</td><td>${c.roles.map(esc).join(", ")}</td><td>${c.permissions.map(esc).join(", ")}</td><td>${esc(c.feature)}</td><td><code>${esc(c.snippet)}</code></td><td class="muted">${esc(c.source.file)}:${c.source.line}</td></tr>`).join("")}</tbody></table></div></details>
<h3>Frontend-only checks (${a.access.frontendChecks.length})</h3><p class="muted">UI checks hide or disable controls. They are not security: every rule here must also exist in the backend.</p>${a.access.frontendChecks.length ? `<details><summary>Show first ${Math.min(60, a.access.frontendChecks.length)}</summary><div class="wrap"><table><thead><tr><th>Kind</th><th>Roles</th><th>Feature</th><th>Snippet</th><th>Source</th></tr></thead><tbody>${a.access.frontendChecks.slice(0, 60).map((c) => `<tr><td>${esc(c.kind)}</td><td>${c.roles.map(esc).join(", ")}</td><td>${esc(c.feature)}</td><td><code>${esc(c.snippet)}</code></td><td class="muted">${esc(c.source.file)}:${c.source.line}</td></tr>`).join("")}</tbody></table></div></details>` : ""}
</section>

<section id="data"><h2>Data model</h2><p class="muted">${a.model.entities.length} entities, ${a.model.relations.length} relations · ORMs: ${a.model.orms.join(", ") || "none detected"} · Databases: ${a.index.databases.join(", ") || "not detected"}</p>
<div class="dia"><pre class="mermaid">${esc(diagrams[3][2])}</pre></div>
<details><summary>Entity list</summary><div class="wrap"><table><thead><tr><th>Entity</th><th>Feature</th><th>ORM</th><th>Fields</th><th>Source</th></tr></thead><tbody>${a.model.entities.map((e) => `<tr><td><b>${esc(e.name)}</b>${e.table && e.table !== e.name ? ` <span class="muted">(${esc(e.table)})</span>` : ""}</td><td>${esc(e.feature)}</td><td>${esc(e.orm)}</td><td>${e.fields.slice(0, 12).map((f) => `<code>${esc(f.name)}</code>`).join(" ")}${e.fields.length > 12 ? ` <span class="muted">+${e.fields.length - 12}</span>` : ""}</td><td class="muted">${esc(e.source.file)}:${e.source.line}</td></tr>`).join("")}</tbody></table></div></details>
</section>

<section id="architecture"><h2>Architecture</h2>
<div class="two"><div><h3>Containers (C4)</h3><div class="dia"><pre class="mermaid">${esc(diagrams[4][2])}</pre></div></div><div><h3>Module dependencies</h3><div class="dia"><pre class="mermaid">${esc(diagrams[5][2])}</pre></div><p class="muted">Edge label = number of imports. Red = hub imported by many features.</p></div></div>
<p><b>External services:</b> ${a.index.externalServices.map((x) => `<span class="tag">${esc(x)}</span>`).join("") || "<span class='muted'>none detected</span>"}</p>
</section>

<section id="endpoints"><h2>Endpoint catalogue (${a.endpoints.length})</h2><details><summary>Show all</summary><div class="wrap"><table><thead><tr><th>Method</th><th>Path</th><th>Feature</th><th>Access</th><th>Guards</th><th>Handler</th><th>Source</th></tr></thead><tbody>
${a.endpoints.map((e) => `<tr><td><code>${esc(e.method)}</code></td><td><code>${esc(e.path)}</code></td><td>${esc(e.feature)}</td><td>${e.isPublic ? `<span class="pub">public</span>` : e.roles.length ? `<span class="lock">🔒 ${e.roles.map(esc).join(", ")}</span>` : e.permissions.length ? `<span class="lock">🔑 ${e.permissions.map(esc).join(", ")}</span>` : "authenticated"}</td><td>${e.guards.slice(0, 4).map((g) => `<span class="tag">${esc(g)}</span>`).join("")}</td><td class="muted">${esc(e.handler)}</td><td class="muted">${esc(e.source.file)}:${e.source.line}</td></tr>`).join("")}
</tbody></table></div></details></section>

<section id="findings"><h2>Findings: over-build, gaps and risks</h2>
${synthesis?.over_build_signals.length ? `<h3>Over-build signals (Claude)</h3><ul>${synthesis.over_build_signals.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
<h3>Automated findings (${a.findings.length})</h3>
${a.findings.length ? `<div class="wrap"><table><thead><tr><th>Severity</th><th>Finding</th><th>Detail</th><th>Evidence</th></tr></thead><tbody>${a.findings.map((f) => `<tr><td>${sevBadge(f.severity)}</td><td><b>${esc(f.title)}</b><br><span class="muted">${esc(f.category)}${f.feature ? ` · ${esc(f.feature)}` : ""}</span></td><td>${esc(f.detail)}</td><td class="muted">${f.evidence.slice(0, 4).map((s) => `${esc(s.file)}:${s.line}`).join("<br>")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No automated findings.</p>`}
</section>

${synthesis ? `<section id="questions"><h2>Questions for the business owner</h2><ol>${synthesis.open_questions_for_owner.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>` : ""}
<p class="muted">Generated by Business Overview MCP. Facts are extracted heuristically from source code; verify high-impact findings before acting.</p>
</main>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default", maxTextSize: 900000, maxEdges: 4000, flowchart: { useMaxWidth: true }, er: { useMaxWidth: true } });
for (const el of document.querySelectorAll("pre.mermaid")) { try { await mermaid.run({ nodes: [el] }); } catch (e) { el.setAttribute("data-processed", "1"); el.textContent = "Diagram failed to render: " + (e && e.message ? e.message : e); } }
</script>
</body></html>`;
}

export function buildMarkdownReport(a: Analysis, synthesis?: Synthesis): string {
  const L: string[] = [];
  L.push(`# ${a.index.name} — Business Overview report`, "", `_Generated ${a.index.scannedAt} · ${a.index.frameworks.join(", ")} · ${a.index.totalLoc.toLocaleString()} LOC · ${synthesis ? "Claude synthesis" : "heuristic mode"}_`, "");
  L.push("## Executive summary", "");
  if (synthesis) { L.push(synthesis.executive_summary, "", ...synthesis.what_the_product_does.map((s) => `- ${s}`), ""); }
  L.push(mdTable(["Metric", "Value"], [["Features with behaviour", a.features.filter((f) => f.endpoints || f.entities.length).length], ["Use cases", a.useCases.length], ["Roles", a.access.roles.length], ["Endpoints", `${a.endpoints.length} (${a.endpoints.filter((e) => e.isPublic).length} public)`], ["Entities / relations", `${a.model.entities.length} / ${a.model.relations.length}`], ["High-severity findings", a.findings.filter((f) => f.severity === "high").length]]), "");
  L.push("```mermaid", overviewMermaid(a), "```", "");
  L.push("## Feature inventory", "", mdTable(["Feature", "Purpose", "Endpoints", "Entities", "Files", "LOC"], a.features.map((f) => { const fa = synthesis?.feature_assessment.find((x) => x.feature === f.name); return [titleCase(f.name), fa ? `${fa.business_purpose} (${fa.status})` : "", f.endpoints, f.entities.slice(0, 6).join(", "), f.files, f.loc]; })), "");
  L.push("## Actors & roles", "");
  if (synthesis) { for (const r of synthesis.roles) L.push(`### ${titleCase(r.name)}`, r.description, "", `**Can:** ${r.can.join("; ") || "—"}`, "", `**Cannot:** ${r.cannot.join("; ") || "—"}`, ""); }
  else L.push(mdTable(["Role", "Defined as", "Endpoints allowing it", "Where"], a.access.roles.map((r) => [r.name, r.kind, a.endpoints.filter((e) => e.roles.includes(r.name)).length, r.sources.slice(0, 2).map((s) => `${s.file}:${s.line}`).join(", ")])), "");
  L.push("## Use cases", "", "```mermaid", useCaseMermaid(a, { maxUseCases: 60 }), "```", "");
  for (const u of a.useCases) L.push(`- **${u.id} ${u.name}** — actors: ${u.actors.join(", ")} · feature: ${u.feature}${u.restrictions.length ? ` · ${u.restrictions.join("; ")}` : ""}${u.endpoints.length ? ` · \`${u.endpoints.slice(0, 6).join("`, `")}\`` : ""}`);
  L.push("", "## Access matrix", "", mdTable(["Feature", "Endpoints", ...a.access.actors.map(titleCase)], a.access.matrix.map((r) => [titleCase(r.feature), r.endpoints, ...a.access.actors.map((x) => ({ full: "●", partial: "◐", none: "○", unknown: "?" })[r.access[x]] ?? "?")])), "");
  if (synthesis) L.push("## Restrictions", "", mdTable(["Rule", "Enforced at", "Risk", "Evidence"], synthesis.restrictions.map((r) => [r.rule, r.enforced_at, r.risk ?? "—", r.evidence.slice(0, 2).join(", ")])), "");
  L.push("## Data model", "", "```mermaid", erdMermaid(a, { maxEntities: 45 }), "```", "");
  L.push("## Architecture", "", "```mermaid", architectureMermaid(a), "```", "", "```mermaid", moduleDependencyMermaid(a), "```", "");
  L.push("## Endpoints", "", mdTable(["Method", "Path", "Feature", "Access", "Source"], a.endpoints.map((e) => [e.method, e.path, e.feature, e.isPublic ? "public" : e.roles.length ? `roles: ${e.roles.join(", ")}` : e.permissions.length ? `perms: ${e.permissions.join(", ")}` : "authenticated", `${e.source.file}:${e.source.line}`])), "");
  L.push("## Findings", "");
  if (synthesis?.over_build_signals.length) L.push(...synthesis.over_build_signals.map((s) => `- ${s}`), "");
  L.push(mdTable(["Severity", "Finding", "Detail", "Evidence"], a.findings.map((f) => [f.severity, f.title, f.detail, f.evidence.slice(0, 3).map((s) => `${s.file}:${s.line}`).join(", ")])), "");
  if (synthesis) L.push("## Questions for the business owner", "", ...synthesis.open_questions_for_owner.map((s, i) => `${i + 1}. ${s}`), "");
  return L.join("\n");
}

export function writeReport(a: Analysis, outDir: string, synthesis?: Synthesis, formats: ("html" | "md" | "json")[] = ["html", "md"]): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const out: string[] = [];
  if (formats.includes("html")) { const p = path.join(outDir, "business-overview-report.html"); fs.writeFileSync(p, buildHtmlReport(a, synthesis), "utf8"); out.push(p); }
  if (formats.includes("md")) { const p = path.join(outDir, "business-overview-report.md"); fs.writeFileSync(p, buildMarkdownReport(a, synthesis), "utf8"); out.push(p); }
  if (formats.includes("json")) { const p = path.join(outDir, "business-overview-facts.json"); fs.writeFileSync(p, JSON.stringify({ ...a, index: { ...a.index, files: undefined }, synthesis }, null, 2), "utf8"); out.push(p); }
  return out;
}

export { endpointKey as _ek };
