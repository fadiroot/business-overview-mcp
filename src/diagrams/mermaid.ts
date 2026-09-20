import type { AccessLevel, Analysis, Endpoint, Entity, Relation, UseCase } from "../types.js";
import { readText } from "../indexer.js";
import { endpointKey } from "../extractors/endpoints.js";
import { endpointAllows } from "../extractors/access.js";
import { plural, singular, titleCase, uniq } from "../util.js";

export type DiagramType = "erd" | "use_case" | "architecture" | "module_dependencies" | "role_access" | "overview" | "sequence" | "feature_map";
export type DiagramFormat = "mermaid" | "plantuml";

export interface DiagramOptions {
  feature?: string;
  endpoint?: string; // "METHOD /path" for sequence
  maxEntities?: number;
  maxUseCases?: number;
  includeFields?: boolean;
}

const id = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1") || "_";
const q = (s: string) => `"${s.replace(/"/g, "'").replace(/\n/g, "<br/>")}"`;
const mtype = (t: string) => (t.replace(/\[\]$/, "_list").replace(/[^A-Za-z0-9_]/g, "_") || "any");

// ---------- ERD ----------
export function erdMermaid(a: Analysis, opt: DiagramOptions): string {
  let ents = a.model.entities;
  if (opt.feature) {
    const f = a.features.find((x) => x.name === opt.feature);
    const names = new Set(f?.entities ?? []);
    for (const r of a.model.relations) if (names.has(r.from) || names.has(r.to)) { names.add(r.from); names.add(r.to); }
    ents = ents.filter((e) => names.has(e.name) || e.feature === opt.feature);
  }
  const max = opt.maxEntities ?? 60;
  // rank entities by relation degree so the most connected appear when truncating
  const degree = new Map<string, number>();
  for (const r of a.model.relations) { degree.set(r.from, (degree.get(r.from) ?? 0) + 1); degree.set(r.to, (degree.get(r.to) ?? 0) + 1); }
  ents = ents.slice().sort((x, y) => (degree.get(y.name) ?? 0) - (degree.get(x.name) ?? 0)).slice(0, max);
  const names = new Set(ents.map((e) => e.name));
  const lines = ["erDiagram"];
  for (const e of ents) {
    lines.push(`  ${id(e.name)} {`);
    const fields = (opt.includeFields ?? true) ? e.fields.slice(0, 14) : e.fields.filter((f) => f.pk || f.fk);
    for (const f of fields) {
      const keys = [f.pk ? "PK" : "", f.fk ? "FK" : "", f.unique && !f.pk ? "UK" : ""].filter(Boolean).join(",");
      lines.push(`    ${mtype(f.type)} ${id(f.name)}${keys ? " " + keys : ""}${f.nullable ? ' "nullable"' : ""}`);
    }
    if (e.fields.length > 14 && (opt.includeFields ?? true)) lines.push(`    more _${e.fields.length - 14}_more_fields`);
    lines.push("  }");
  }
  const card = (r: Relation) => r.kind === "one-to-one" ? "||--||" : r.kind === "many-to-many" ? "}o--o{" : "}o--||";
  for (const r of a.model.relations) {
    if (!names.has(r.from) || !names.has(r.to)) continue;
    // child }o--|| parent  (from = child for many-to-one)
    lines.push(`  ${id(r.from)} ${card(r)} ${id(r.to)} : ${q(r.field ?? r.kind)}`);
  }
  if (ents.length === 0) lines.push("  NO_ENTITIES_FOUND { string hint }");
  return lines.join("\n");
}

export function erdPlantUml(a: Analysis, opt: DiagramOptions): string {
  let ents = a.model.entities;
  if (opt.feature) { const f = a.features.find((x) => x.name === opt.feature); const names = new Set(f?.entities ?? []); ents = ents.filter((e) => names.has(e.name) || e.feature === opt.feature); }
  ents = ents.slice(0, opt.maxEntities ?? 60);
  const names = new Set(ents.map((e) => e.name));
  const out = ["@startuml", "!theme plain", "hide circle", "skinparam linetype ortho", "skinparam classAttributeIconSize 0"];
  for (const e of ents) {
    out.push(`entity "${e.name}" as ${id(e.name)} {`);
    for (const f of e.fields.filter((x) => x.pk)) out.push(`  * ${f.name} : ${f.type} <<PK>>`);
    out.push("  --");
    for (const f of e.fields.filter((x) => !x.pk).slice(0, 14)) out.push(`  ${f.nullable ? "" : "* "}${f.name} : ${f.type}${f.fk ? " <<FK>>" : ""}`);
    out.push("}");
  }
  for (const r of a.model.relations) {
    if (!names.has(r.from) || !names.has(r.to)) continue;
    const arrow = r.kind === "one-to-one" ? "||--||" : r.kind === "many-to-many" ? "}o--o{" : "}o--||";
    out.push(`${id(r.from)} ${arrow} ${id(r.to)}${r.field ? ` : ${r.field}` : ""}`);
  }
  out.push("@enduml");
  return out.join("\n");
}

// ---------- Use case ----------
function selectUseCases(a: Analysis, opt: DiagramOptions): UseCase[] {
  let ucs = a.useCases;
  if (opt.feature) ucs = ucs.filter((u) => u.feature === opt.feature);
  return ucs.slice(0, opt.maxUseCases ?? 80);
}

export function useCaseMermaid(a: Analysis, opt: DiagramOptions): string {
  const ucs = selectUseCases(a, opt);
  const actors = uniq(ucs.flatMap((u) => u.actors));
  const lines = ["flowchart LR", "  classDef actor fill:#fde68a,stroke:#b45309,color:#1f2937,stroke-width:1.5px", "  classDef uc fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e,rx:20,ry:20", "  classDef pub fill:#dcfce7,stroke:#15803d,color:#14532d", ""];
  for (const act of actors) lines.push(`  A_${id(act)}[/"🧑 ${act}"/]:::actor`);
  const byFeature = new Map<string, UseCase[]>();
  for (const u of ucs) { if (!byFeature.has(u.feature)) byFeature.set(u.feature, []); byFeature.get(u.feature)!.push(u); }
  for (const [feat, list] of byFeature) {
    lines.push(`  subgraph F_${id(feat)}[${q(titleCase(feat))}]`);
    lines.push("    direction TB");
    for (const u of list) {
      const restricted = u.restrictions.some((r) => /^Restricted to role|Requires permission/.test(r));
      const pub = u.restrictions.some((r) => /public/i.test(r));
      lines.push(`    ${id(u.id)}([${q(u.name + (restricted ? " 🔒" : ""))}])${pub ? ":::pub" : ":::uc"}`);
    }
    lines.push("  end");
  }
  for (const u of ucs) for (const act of u.actors) lines.push(`  A_${id(act)} --> ${id(u.id)}`);
  if (!ucs.length) lines.push('  none["No use cases found - run scan_project and extract_endpoints first"]');
  return lines.join("\n");
}

export function useCasePlantUml(a: Analysis, opt: DiagramOptions): string {
  const ucs = selectUseCases(a, opt);
  const actors = uniq(ucs.flatMap((u) => u.actors));
  const out = ["@startuml", "!theme plain", "left to right direction", "skinparam packageStyle rectangle", "skinparam actorStyle awesome", `title ${a.index.name} - Use cases${opt.feature ? ` (${titleCase(opt.feature)})` : ""}`];
  for (const act of actors) out.push(`actor "${act}" as A_${id(act)}`);
  const byFeature = new Map<string, UseCase[]>();
  for (const u of ucs) { if (!byFeature.has(u.feature)) byFeature.set(u.feature, []); byFeature.get(u.feature)!.push(u); }
  for (const [feat, list] of byFeature) {
    out.push(`rectangle "${titleCase(feat)}" {`);
    for (const u of list) out.push(`  usecase "${u.name}${u.restrictions.some((r) => /^Restricted to role|Requires permission/.test(r)) ? " <&lock-locked>" : ""}" as ${id(u.id)}`);
    out.push("}");
  }
  for (const u of ucs) for (const act of u.actors) out.push(`A_${id(act)} --> ${id(u.id)}`);
  out.push("@enduml");
  return out.join("\n");
}

// ---------- Architecture (C4 container) ----------
function detectContainers(a: Analysis) {
  const fw = a.index.frameworks;
  const frontends = fw.filter((f) => /Next\.js|Nuxt|React|Vue|Angular|Svelte|SvelteKit|Remix|React Native|Expo|Electron|Livewire|Inertia|Filament/.test(f));
  const backends = fw.filter((f) => /Express|Fastify|Koa|Hapi|NestJS|Hono|tRPC|Apollo|FastAPI|Flask|Django|Starlette|Laravel|Symfony|Spring|Gin|Echo|Chi|Fiber|Rails|GraphQL/.test(f));
  const orms = fw.filter((f) => /Prisma|TypeORM|Sequelize|Mongoose|Drizzle|Knex|SQLAlchemy|SQLModel|Django ORM|Eloquent|JPA|Hibernate|GORM|Entity Framework|MikroORM|Tortoise|Peewee/.test(f));
  const auth = fw.filter((f) => /Passport|JWT|NextAuth|Auth\.js|Clerk|Keycloak|Auth0|CASL|Casbin|Spatie|Sanctum|Devise|Pundit|CanCanCan|Spring Security|Flask-Login|Sessions|guardian|Principal|Security|OAuth|Authlib/.test(f));
  const hasFrontendFiles = a.index.files.some((f) => f.isFrontend && !f.isTest);
  return { frontends: frontends.length ? frontends : hasFrontendFiles ? ["Web UI"] : [], backends: backends.length ? backends : a.endpoints.length ? ["API"] : [], orms, auth, dbs: a.index.databases.length ? a.index.databases : a.model.entities.length ? ["Database"] : [], external: a.index.externalServices };
}

export function architectureMermaid(a: Analysis): string {
  const c = detectContainers(a);
  const actors = a.access.roles.map((r) => r.name).slice(0, 8);
  const lines = ["C4Container", `title ${a.index.name} - Container diagram (auto-generated)`];
  for (const r of actors) lines.push(`Person(${id(r)}, ${q(titleCase(r))}, ${q(`Role: ${r}`)})`);
  if (!actors.length) lines.push(`Person(user, "User", "Application user")`);
  if (a.endpoints.some((e) => e.isPublic)) lines.push(`Person_Ext(anon, "Anonymous visitor", "Unauthenticated")`);
  lines.push(`System_Boundary(sys, ${q(a.index.name)}) {`);
  const feTechs = c.frontends.filter((f) => f !== "Web UI");
  if (c.frontends.length) lines.push(`  Container(web, "Web / Mobile client", ${q(feTechs.join(", ") || "Frontend")}, "User interface; ${a.access.frontendChecks.length} UI-level access checks")`);
  const beTechs = c.backends.filter((f) => f !== "API");
  lines.push(`  Container(api, "Application API", ${q(beTechs.join(", ") || "Backend")}, ${q(`${a.endpoints.length} endpoints across ${a.features.filter((f) => f.endpoints).length} features`)})`);
  if (c.auth.length) lines.push(`  Container(auth, "Auth & Authorization", ${q(c.auth.join(", "))}, ${q(`${a.access.roles.length} roles, ${a.access.permissions.length} permissions`)})`);
  for (const db of c.dbs) lines.push(`  ContainerDb(${id(db)}, ${q(db)}, ${q(c.orms.join(", ") || "Storage")}, ${q(`${a.model.entities.length} entities`)})`);
  lines.push("}");
  for (const ext of c.external.slice(0, 10)) lines.push(`System_Ext(${id(ext)}, ${q(ext)}, "External service")`);
  const people = actors.length ? actors.map(id) : ["user"];
  for (const p of people) lines.push(`Rel(${p}, ${c.frontends.length ? "web" : "api"}, "Uses")`);
  if (a.endpoints.some((e) => e.isPublic)) lines.push(`Rel(anon, ${c.frontends.length ? "web" : "api"}, "Browses public pages")`);
  if (c.frontends.length) lines.push(`Rel(web, api, "HTTPS / JSON")`);
  if (c.auth.length) lines.push(`Rel(api, auth, "Authenticates & authorizes")`);
  for (const db of c.dbs) lines.push(`Rel(api, ${id(db)}, "Reads / writes")`);
  for (const ext of c.external.slice(0, 10)) lines.push(`Rel(api, ${id(ext)}, "Integrates")`);
  lines.push(`UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")`);
  return lines.join("\n");
}

export function architecturePlantUml(a: Analysis): string {
  const c = detectContainers(a);
  const out = ["@startuml", "!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml", "LAYOUT_WITH_LEGEND()", `title ${a.index.name} - Container diagram`];
  const actors = a.access.roles.map((r) => r.name).slice(0, 8);
  for (const r of actors) out.push(`Person(${id(r)}, "${titleCase(r)}", "Role: ${r}")`);
  if (!actors.length) out.push(`Person(user, "User")`);
  out.push(`System_Boundary(sys, "${a.index.name}") {`);
  if (c.frontends.length) out.push(`  Container(web, "Web / Mobile client", "${c.frontends.join(", ")}")`);
  out.push(`  Container(api, "Application API", "${c.backends.join(", ")}", "${a.endpoints.length} endpoints")`);
  if (c.auth.length) out.push(`  Container(auth, "Auth & Authorization", "${c.auth.join(", ")}")`);
  for (const db of c.dbs) out.push(`  ContainerDb(${id(db)}, "${db}", "${c.orms.join(", ")}", "${a.model.entities.length} entities")`);
  out.push("}");
  for (const ext of c.external.slice(0, 10)) out.push(`System_Ext(${id(ext)}, "${ext}")`);
  for (const p of actors.length ? actors.map(id) : ["user"]) out.push(`Rel(${p}, ${c.frontends.length ? "web" : "api"}, "Uses")`);
  if (c.frontends.length) out.push(`Rel(web, api, "HTTPS/JSON")`);
  if (c.auth.length) out.push(`Rel(api, auth, "Authz")`);
  for (const db of c.dbs) out.push(`Rel(api, ${id(db)}, "Reads/writes")`);
  for (const ext of c.external.slice(0, 10)) out.push(`Rel(api, ${id(ext)}, "Integrates")`);
  out.push("@enduml");
  return out.join("\n");
}

// ---------- Module dependencies ----------
export function moduleDependencyEdges(a: Analysis): Map<string, number> {
  const edges = new Map<string, number>();
  const byRel = new Map(a.index.files.map((f) => [f.rel, f] as const));
  const pyByModule = new Map<string, string>();
  for (const f of a.index.files) if (f.lang === "Python") pyByModule.set(f.rel.replace(/\.py$/, "").replace(/\/__init__$/, "").replace(/\//g, "."), f.feature);
  for (const f of a.index.files) {
    if (f.isTest || !["TypeScript", "JavaScript", "Python", "PHP", "Go", "Java", "Kotlin", "Vue", "Svelte"].includes(f.lang)) continue;
    const text = readText(f.abs);
    if (!text) continue;
    const targets: string[] = [];
    if (["TypeScript", "JavaScript", "Vue", "Svelte"].includes(f.lang)) {
      for (const m of text.matchAll(/(?:from\s+|import\s*\(?\s*|require\s*\(\s*)['"](\.[^'"]+|@\/[^'"]+|~\/[^'"]+|src\/[^'"]+)['"]/g)) {
        let spec = m[1];
        if (/^[@~]\//.test(spec)) spec = spec.replace(/^[@~]\//, "src/");
        const base = spec.startsWith(".") ? posixJoin(f.rel.split("/").slice(0, -1).join("/"), spec) : spec;
        const cands = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`, base.replace(/\.js$/, ".ts")];
        const hit = cands.map((c) => byRel.get(c)).find(Boolean);
        if (hit) targets.push(hit.feature);
      }
    } else if (f.lang === "Python") {
      for (const m of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
        const mod = (m[1] ?? m[2]).replace(/^\.+/, "");
        for (const [k, feat] of pyByModule) if (k.endsWith(mod) || mod.startsWith(k)) { targets.push(feat); break; }
      }
    } else if (f.lang === "PHP") {
      for (const m of text.matchAll(/^\s*use\s+App\\([\w\\]+);/gm)) { const parts = m[1].split("\\"); const feat = parts.length >= 2 ? parts[parts.length - 2].toLowerCase() : parts[0].toLowerCase(); if (a.index.featureNames.includes(feat)) targets.push(feat); else { const cls = parts[parts.length - 1]; const hit = a.index.files.find((x) => x.rel.endsWith(`/${cls}.php`)); if (hit) targets.push(hit.feature); } }
    } else if (f.lang === "Go") {
      for (const m of text.matchAll(/^\s*"[\w.\-\/]+\/(internal|pkg|cmd)\/([\w\-\/]+)"/gm)) { const seg = m[2].split("/")[0]; if (a.index.featureNames.includes(seg)) targets.push(seg); }
    } else {
      for (const m of text.matchAll(/^\s*import\s+([\w.]+)\.(\w+);/gm)) { const cls = m[2]; const hit = a.index.files.find((x) => x.rel.endsWith(`/${cls}.java`) || x.rel.endsWith(`/${cls}.kt`)); if (hit) targets.push(hit.feature); }
    }
    for (const t of targets) { if (t === f.feature) continue; const k = `${f.feature}->${t}`; edges.set(k, (edges.get(k) ?? 0) + 1); }
  }
  return edges;
}

function posixJoin(dir: string, spec: string): string {
  const parts = (dir ? dir.split("/") : []).concat(spec.split("/"));
  const out: string[] = [];
  for (const p of parts) { if (p === "." || p === "") continue; if (p === "..") out.pop(); else out.push(p); }
  return out.join("/");
}

export function moduleDependencyMermaid(a: Analysis): string {
  const edges = moduleDependencyEdges(a);
  const lines = ["flowchart LR", "  classDef hub fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d"];
  const nodes = new Set<string>();
  const inDeg = new Map<string, number>();
  for (const [k, n] of edges) { const [from, to] = k.split("->"); nodes.add(from); nodes.add(to); inDeg.set(to, (inDeg.get(to) ?? 0) + n); }
  for (const nd of nodes) { const f = a.features.find((x) => x.name === nd); lines.push(`  ${id(nd)}[${q(`${titleCase(nd)}\n${f ? `${f.files} file${f.files === 1 ? "" : "s"} · ${f.endpoints} endpoint${f.endpoints === 1 ? "" : "s"}` : ""}`)}]`); }
  const sorted = Array.from(edges.entries()).sort((x, y) => y[1] - x[1]).slice(0, 120);
  for (const [k, n] of sorted) { const [from, to] = k.split("->"); lines.push(`  ${id(from)} -->|${n}| ${id(to)}`); }
  const hubs = Array.from(inDeg.entries()).filter(([, n]) => n >= 8).map(([k]) => id(k));
  if (hubs.length) lines.push(`  class ${hubs.join(",")} hub`);
  if (!nodes.size) lines.push('  none["No cross-feature imports resolved"]');
  return lines.join("\n");
}

// ---------- Role access graph ----------
export function roleAccessMermaid(a: Analysis, opt: DiagramOptions): string {
  const all = a.access.matrix.filter((r) => !opt.feature || r.feature === opt.feature);
  const actors = a.access.actors;
  // A feature every actor reaches identically teaches nothing; listing it only adds edges.
  const differing = all.filter((r) => new Set(actors.map((act) => r.access[act])).size > 1);
  const rows = (differing.length ? differing : all).slice(0, 24);
  const uniform = all.length - rows.length;
  const lines = ["flowchart LR", "  classDef role fill:#fde68a,stroke:#b45309,color:#1f2937", "  classDef feat fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e", "  classDef anon fill:#dcfce7,stroke:#15803d,color:#14532d", "  classDef note fill:#f1f5f9,stroke:#475569,color:#0f172a,stroke-dasharray:4 2", ""];
  const used = uniq(rows.flatMap((r) => actors.filter((act) => r.access[act] !== "none")));
  for (const act of used) lines.push(`  R_${id(act)}[/${q("🧑 " + titleCase(act))}/]:::${act === "anonymous" ? "anon" : "role"}`);
  for (const r of rows) lines.push(`  F_${id(r.feature)}[${q(`${titleCase(r.feature)}\n${r.endpoints} endpoints`)}]:::feat`);
  // Past a couple of dozen edges the per-edge labels collide; the arrow style already carries the level.
  const edgeCount = rows.reduce((n, r) => n + used.filter((act) => r.access[act] !== "none").length, 0);
  const label = (lvl: string) => (edgeCount <= 24 ? `|${lvl}|` : "");
  for (const r of rows) for (const act of used) {
    const lvl = r.access[act];
    if (lvl === "none") continue;
    lines.push(`  R_${id(act)} ${lvl === "full" ? "==>" : lvl === "partial" ? "-->" : "-.->"}${label(lvl)} F_${id(r.feature)}`);
  }
  if (uniform > 0) lines.push(`  note[${q(`+${uniform} features where every actor has the same access`)}]:::note`);
  if (!rows.length) lines.push(`  none[${q("No endpoints with access rules were found")}]:::note`);
  return lines.join("\n");
}

// ---------- Full overview ----------
export function overviewMermaid(a: Analysis): string {
  // One screen has to stay readable, so cap each band and prefer the actors that carry real meaning.
  const MAX_FEATURES = 10, MAX_ACTORS_PER_FEATURE = 3, MAX_ENTITIES = 14;
  const feats = a.features.filter((f) => f.endpoints > 0 || f.entities.length > 0).slice(0, MAX_FEATURES);
  const featNames = new Set(feats.map((f) => f.name));
  const generic = (act: string) => act === "authenticated" || act === "anonymous";

  const edges: [string, string, AccessLevel][] = [];
  for (const row of a.access.matrix) {
    if (!featNames.has(row.feature)) continue;
    const ranked = a.access.actors
      .map((act) => [act, row.access[act]] as [string, AccessLevel])
      .filter(([, lvl]) => lvl === "full" || lvl === "partial")
      // a named role says more than "any logged-in user"
      .sort((x, y) => (generic(x[0]) ? 1 : 0) - (generic(y[0]) ? 1 : 0) || (x[1] === "full" ? -1 : 1) - (y[1] === "full" ? -1 : 1));
    for (const [act, lvl] of ranked.slice(0, MAX_ACTORS_PER_FEATURE)) edges.push([act, row.feature, lvl]);
  }
  const shownActors = uniq(edges.map((e) => e[0]));
  const ents = uniq(feats.flatMap((f) => f.entities)).slice(0, MAX_ENTITIES);

  const lines = ["flowchart LR", "  classDef role fill:#fde68a,stroke:#b45309,color:#1f2937", "  classDef feat fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e", "  classDef ent fill:#f3e8ff,stroke:#7e22ce,color:#3b0764", "  classDef ext fill:#f1f5f9,stroke:#475569,color:#0f172a,stroke-dasharray:4 2", ""];
  if (shownActors.length) {
    lines.push("  subgraph Actors");
    for (const act of shownActors) lines.push(`    R_${id(act)}[/${q("🧑 " + titleCase(act))}/]:::role`);
    lines.push("  end");
  }
  lines.push(`  subgraph System[${q(a.index.name)}]`);
  lines.push("    direction TB");
  for (const f of feats) lines.push(`    F_${id(f.name)}[${q(`${titleCase(f.name)}\n${f.endpoints} endpoints · ${f.loc.toLocaleString()} LOC`)}]:::feat`);
  lines.push("  end");
  if (ents.length) {
    lines.push("  subgraph Data");
    for (const e of ents) lines.push(`    E_${id(e)}[(${q(e)})]:::ent`);
    lines.push("  end");
  }
  if (a.index.externalServices.length) {
    lines.push("  subgraph External");
    for (const x of a.index.externalServices.slice(0, 8)) lines.push(`    X_${id(x)}[${q(x)}]:::ext`);
    lines.push("  end");
  }
  for (const [act, feat, lvl] of edges) lines.push(`  R_${id(act)} ${lvl === "full" ? "==>" : "-->"} F_${id(feat)}`);
  for (const f of feats) for (const e of f.entities.slice(0, 4)) if (ents.includes(e)) lines.push(`  F_${id(f.name)} -.-> E_${id(e)}`);
  const hiddenFeatures = a.features.filter((x) => x.endpoints > 0 || x.entities.length > 0).length - feats.length;
  if (hiddenFeatures > 0) lines.push(`  more[${q(`+${hiddenFeatures} more features - see the feature inventory`)}]:::ext`);
  return lines.join("\n");
}

// ---------- Feature map (features only, sized) ----------
export function featureMapMermaid(a: Analysis): string {
  const lines = ["mindmap", `  root((${a.index.name}))`];
  const feats = a.features.slice(0, 40);
  for (const f of feats) {
    lines.push(`    ${titleCase(f.name)}`);
    lines.push(`      ${f.endpoints} endpoints, ${f.entities.length} entities, ${f.loc.toLocaleString()} LOC`);
    const ucs = a.useCases.filter((u) => u.feature === f.name).slice(0, 5);
    for (const u of ucs) lines.push(`      ${u.name}`);
  }
  return lines.join("\n");
}

// ---------- Sequence ----------
export function sequenceMermaid(a: Analysis, opt: DiagramOptions): string {
  let ep: Endpoint | undefined;
  if (opt.endpoint) { const want = opt.endpoint.trim().toUpperCase(); ep = a.endpoints.find((e) => endpointKey(e).toUpperCase() === want) ?? a.endpoints.find((e) => endpointKey(e).toUpperCase().includes(want)) ?? a.endpoints.find((e) => e.path.toUpperCase().includes(want.replace(/^\w+\s+/, ""))); }
  if (!ep && opt.feature) ep = a.endpoints.filter((e) => e.feature === opt.feature).sort((x, y) => (x.method === "POST" ? -1 : 0) - (y.method === "POST" ? -1 : 0))[0];
  if (!ep) return 'sequenceDiagram\n  Note over Client: No matching endpoint. Pass endpoint="METHOD /path".';
  const text = readText(a.index.root + "/" + ep.source.file);
  const services = uniq(Array.from(text.matchAll(/\b([A-Z]\w*(?:Service|Repository|Repo|Manager|UseCase|Interactor|Handler|Client|Gateway|Provider|Store|Dao|Mapper|Publisher|Queue|Mailer|Notifier))\b/g)).map((m) => m[1])).filter((s) => !/^(Controller|Guard)$/.test(s)).slice(0, 4);
  const entityNames = a.model.entities.map((e) => e.name);
  const ents = uniq([singular(ep.resource), ep.resource].map((r) => entityNames.find((n) => n.toLowerCase() === r.toLowerCase() || plural(n).toLowerCase() === r.toLowerCase()) ?? "").filter(Boolean).concat(entityNames.filter((n) => new RegExp(`\\b${n}\\b`).test(text)).slice(0, 4))).slice(0, 4);
  const externals = a.index.externalServices.filter((x) => new RegExp(x.split(" ")[0], "i").test(text)).slice(0, 3);
  const actor = ep.isPublic ? "Anonymous" : ep.roles.length ? titleCase(ep.roles.join(" / ")) : "Authenticated user";
  const guards = ep.guards.filter((g) => !g.startsWith("path-rule")).slice(0, 3);
  const L = ["sequenceDiagram", "  autonumber", `  actor U as ${actor}`, `  participant API as ${ep.method} ${ep.path}`];
  if (guards.length || !ep.isPublic) L.push(`  participant G as ${guards.join(", ") || "Auth"}`);
  for (const s of services) L.push(`  participant ${id(s)} as ${s}`);
  for (const e of ents) L.push(`  participant DB_${id(e)} as DB: ${e}`);
  for (const x of externals) L.push(`  participant X_${id(x)} as ${x}`);
  L.push(`  U->>API: ${ep.method} ${ep.path}`);
  if (guards.length || !ep.isPublic) {
    L.push(`  API->>G: authenticate${ep.roles.length ? ` + require role ${ep.roles.join("|")}` : ""}${ep.permissions.length ? ` + permission ${ep.permissions.join("|")}` : ""}`);
    L.push("  alt not allowed"); L.push("    G-->>U: 401 / 403"); L.push("  else allowed"); L.push("    G-->>API: ok");
  }
  const ind = guards.length || !ep.isPublic ? "    " : "  ";
  const svc = services[0];
  if (svc) L.push(`${ind}API->>${id(svc)}: ${ep.handler.split(".").pop()}()`);
  const from = svc ? id(svc) : "API";
  const write = /^(POST|PUT|PATCH|DELETE|MUTATION)$/.test(ep.method);
  for (const e of ents) { L.push(`${ind}${from}->>DB_${id(e)}: ${write ? (ep.method === "DELETE" ? "delete" : ep.method === "POST" ? "insert" : "update") : "select"} ${e}`); L.push(`${ind}DB_${id(e)}-->>${from}: ${e}${write ? "" : " rows"}`); }
  for (const x of externals) { L.push(`${ind}${from}->>X_${id(x)}: call`); L.push(`${ind}X_${id(x)}-->>${from}: result`); }
  if (svc) L.push(`${ind}${id(svc)}-->>API: result`);
  L.push(`${ind}API-->>U: ${ep.method === "POST" ? "201 Created" : ep.method === "DELETE" ? "204 No Content" : "200 OK"}`);
  if (guards.length || !ep.isPublic) L.push("  end");
  return L.join("\n");
}

export function generateDiagram(a: Analysis, type: DiagramType, format: DiagramFormat, opt: DiagramOptions): { source: string; format: DiagramFormat; note?: string } {
  switch (type) {
    case "erd": return format === "plantuml" ? { source: erdPlantUml(a, opt), format } : { source: erdMermaid(a, opt), format };
    case "use_case": return format === "plantuml" ? { source: useCasePlantUml(a, opt), format } : { source: useCaseMermaid(a, opt), format };
    case "architecture": return format === "plantuml" ? { source: architecturePlantUml(a), format } : { source: architectureMermaid(a), format };
    case "module_dependencies": return { source: moduleDependencyMermaid(a), format: "mermaid", note: format === "plantuml" ? "module_dependencies is Mermaid-only" : undefined };
    case "role_access": return { source: roleAccessMermaid(a, opt), format: "mermaid", note: format === "plantuml" ? "role_access is Mermaid-only" : undefined };
    case "overview": return { source: overviewMermaid(a), format: "mermaid", note: format === "plantuml" ? "overview is Mermaid-only" : undefined };
    case "feature_map": return { source: featureMapMermaid(a), format: "mermaid", note: format === "plantuml" ? "feature_map is Mermaid-only" : undefined };
    case "sequence": return { source: sequenceMermaid(a, opt), format: "mermaid", note: format === "plantuml" ? "sequence is Mermaid-only" : undefined };
  }
}

export function idOf(s: string): string { return id(s); }
export { detectContainers, type Entity as _Entity };
