import type { AccessModel, DataModel, Endpoint, Feature, Finding, ProjectIndex, UseCase } from "../types.js";
import { readText, sourceFiles } from "../indexer.js";
import { endpointKey } from "../extractors/endpoints.js";
import { isInfraEndpointPath, plural, singular, titleCase, uniq, useCaseName } from "../util.js";

export function buildFeatures(index: ProjectIndex, model: DataModel, endpoints: Endpoint[]): Feature[] {
  const map = new Map<string, Feature>();
  for (const f of sourceFiles(index)) {
    if (f.lang === "Config" || f.lang === "Docs" || f.lang === "Data") continue;
    const cur = map.get(f.feature) ?? { name: f.feature, paths: [], files: 0, loc: 0, endpoints: 0, entities: [] };
    cur.files++;
    cur.loc += f.loc;
    const dir = f.rel.split("/").slice(0, -1).join("/") || ".";
    const top = dir.split("/").slice(0, 3).join("/");
    if (!cur.paths.includes(top) && cur.paths.length < 4) cur.paths.push(top);
    map.set(f.feature, cur);
  }
  for (const e of endpoints) { const cur = map.get(e.feature) ?? { name: e.feature, paths: [], files: 0, loc: 0, endpoints: 0, entities: [] }; cur.endpoints++; map.set(e.feature, cur); }
  for (const en of model.entities) { const cur = map.get(en.feature) ?? { name: en.feature, paths: [], files: 0, loc: 0, endpoints: 0, entities: [] }; if (!cur.entities.includes(en.name)) cur.entities.push(en.name); map.set(en.feature, cur); }
  // link entities to features by resource name where the entity lives in a generic "core"/"models" feature
  const entityNames = model.entities.map((e) => e.name);
  for (const e of endpoints) {
    const res = singular(e.resource).toLowerCase().replace(/[_-]/g, "");
    const hit = entityNames.find((n) => entityKey(n) === res || plural(entityKey(n)) === e.resource.toLowerCase().replace(/[_-]/g, ""));
    if (hit) { const cur = map.get(e.feature)!; if (!cur.entities.includes(hit)) cur.entities.push(hit); }
  }
  for (const en of model.entities) { const n = entityKey(en.name); const t = (en.table ?? "").toLowerCase(); for (const [fname, cur] of map) { const fk = fname.toLowerCase().replace(/[_-]/g, ""); if ((fk === n || fk === plural(n) || singular(fk) === n || (t && (fk === t || fk === singular(t)))) && !cur.entities.includes(en.name)) cur.entities.push(en.name); } }
  return Array.from(map.values()).sort((a, b) => b.endpoints - a.endpoints || b.loc - a.loc);
}

export function heuristicUseCases(endpoints: Endpoint[], model: DataModel, access: AccessModel): UseCase[] {
  const groups = new Map<string, Endpoint[]>();
  for (const e of endpoints) {
    if (isInfraEndpointPath(e.path)) continue;
    const actorKey = e.isPublic ? "anonymous" : e.roles.length ? e.roles.slice().sort().join("+") : e.permissions.length ? `perm:${e.permissions.slice().sort().join("+")}` : "authenticated";
    const key = `${e.feature}|${e.resource}|${e.action}|${actorKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  const entityNames = model.entities.map((e) => e.name);
  const out: UseCase[] = [];
  let i = 1;
  for (const [key, eps] of groups) {
    const [feature, resource, action, actorKey] = key.split("|");
    const e0 = eps[0];
    const actors = actorKey === "anonymous" ? ["Anonymous visitor"] : actorKey === "authenticated" ? ["Authenticated user"] : actorKey.startsWith("perm:") ? [`User with permission ${actorKey.slice(5).replace(/\+/g, ", ")}`] : actorKey.split("+").map((r) => titleCase(r));
    const name = useCaseName(e0.method, action, resource);
    const ents = uniq([singular(resource), resource].map((r) => entityNames.find((n) => n.toLowerCase() === r.toLowerCase()) ?? "").filter(Boolean));
    const restrictions: string[] = [];
    if (e0.isPublic) restrictions.push("No authentication required (public)");
    else if (e0.roles.length) restrictions.push(`Restricted to role(s): ${e0.roles.join(", ")}`);
    else restrictions.push("Requires authentication (any role)");
    if (e0.permissions.length) restrictions.push(`Requires permission(s): ${e0.permissions.join(", ")}`);
    const guardNames = uniq(eps.flatMap((e) => e.guards)).filter((g) => !g.startsWith("path-rule"));
    if (guardNames.length) restrictions.push(`Enforced by: ${guardNames.slice(0, 4).join(", ")}`);
    out.push({
      id: `UC-${String(i++).padStart(3, "0")}`,
      name: name[0].toUpperCase() + name.slice(1),
      actors,
      feature,
      action,
      resource,
      endpoints: eps.map(endpointKey),
      entities: ents,
      restrictions,
      description: `${actors.join(" / ")} can ${name.toLowerCase()} through ${eps.length} endpoint${eps.length > 1 ? "s" : ""} in the "${titleCase(feature)}" feature.`,
      source: "heuristic",
    });
  }
  void access;
  return out.sort((a, b) => a.feature.localeCompare(b.feature) || a.resource.localeCompare(b.resource) || a.name.localeCompare(b.name));
}

export function computeFindings(index: ProjectIndex, model: DataModel, endpoints: Endpoint[], access: AccessModel, features: Feature[]): Finding[] {
  const findings: Finding[] = [];
  let n = 1;
  const id = () => `F-${String(n++).padStart(3, "0")}`;
  const anyGuards = endpoints.some((e) => !e.isPublic);

  if (endpoints.length && !anyGuards && !access.checks.length) {
    findings.push({ id: id(), severity: "high", category: "no-access-control", title: "No access control detected anywhere", detail: `${endpoints.length} endpoints were found but no authentication guard, role check or permission check could be detected. Either the project has no access control, or it uses a mechanism the scanner does not recognise.`, evidence: endpoints.slice(0, 5).map((e) => e.source) });
  }

  // unprotected writes
  const THIRD_PARTY_SEGMENT = /(^|\/)(webhooks?|callbacks?|ipn|notify|ping|health|healthz|status)(\/|$)/i;
  const writes = endpoints.filter((e) => /^(POST|PUT|PATCH|DELETE|MUTATION)$/.test(e.method) && e.isPublic && !THIRD_PARTY_SEGMENT.test(e.path) && !/^\/?(auth|login|logout|register|signup|sign-up|signin|sign-in|forgot-password|reset-password|password|verify|verify-email|webhooks?|callback|oauth|token|refresh|health|contact|newsletter|subscribe|public|otp|magic-link|apply|applications?|[\w-]*-applications?|[\w-]*-requests?|feedback|survey|waitlist|inquir\w*|leads?|track\w*)/i.test(e.path.replace(/^\/api(\/v\d+)?/, "")));
  if (writes.length && anyGuards) {
    const byFeature = new Map<string, Endpoint[]>();
    for (const w of writes) { if (!byFeature.has(w.feature)) byFeature.set(w.feature, []); byFeature.get(w.feature)!.push(w); }
    for (const [feature, eps] of byFeature) findings.push({ id: id(), severity: "high", category: "unprotected-write", title: `${eps.length} write endpoint${eps.length > 1 ? "s" : ""} without detected authentication in "${feature}"`, detail: eps.slice(0, 8).map((e) => `${e.method} ${e.path}`).join(", ") + (eps.length > 8 ? ` … (+${eps.length - 8})` : ""), evidence: eps.slice(0, 8).map((e) => e.source), feature });
  }

  // unused roles
  const rolesUsed = new Set([...endpoints.flatMap((e) => e.roles), ...access.checks.flatMap((c) => c.roles), ...access.frontendChecks.flatMap((c) => c.roles), ...access.pathRules.flatMap((p) => p.roles)]);
  for (const r of access.roles) if ((r.kind === "enum" || r.kind === "constant" || r.kind === "config") && !rolesUsed.has(r.name)) findings.push({ id: id(), severity: "medium", category: "unused-role", title: `Role "${r.name}" is defined but never checked`, detail: `Defined in ${r.sources[0]?.file ?? "?"} but no endpoint guard, decorator, middleware or UI check references it. Either the role has no restrictions (same as any authenticated user) or restrictions are missing.`, evidence: r.sources.slice(0, 3) });

  // unused permissions (defined via enum/constant but never checked)
  const permsChecked = new Set([...endpoints.flatMap((e) => e.permissions), ...access.checks.flatMap((c) => c.permissions)]);
  const definedPerms = access.permissions.filter((p) => p.sources.some((s) => /enum|const|permission|seeder|config/i.test(s.file) || true) && !permsChecked.has(p.name) && p.sources.length === 1);
  if (definedPerms.length >= 3) findings.push({ id: id(), severity: "low", category: "unused-permission", title: `${definedPerms.length} permission${definedPerms.length > 1 ? "s" : ""} defined but never checked`, detail: definedPerms.slice(0, 12).map((p) => p.name).join(", ") + (definedPerms.length > 12 ? " …" : ""), evidence: definedPerms.slice(0, 5).map((p) => p.sources[0]) });

  // orphan entities: no endpoint resource matches and name not mentioned outside model files
  const resources = new Set(endpoints.flatMap((e) => [e.resource.toLowerCase(), singular(e.resource).toLowerCase()]));
  const relTargets = new Set(model.relations.flatMap((r) => [r.from, r.to]));
  for (const en of model.entities) {
    const nm = en.name.toLowerCase();
    if (resources.has(nm) || resources.has(plural(nm)) || resources.has(singular(nm))) continue;
    if (/GraphQL type|SQL|Knex|Laravel migration/.test(en.orm)) continue;
    // mention count outside its own file
    let mentions = 0;
    const forms = uniq([en.name, singular(en.name), plural(en.name), plural(singular(en.name)), en.table ?? en.name].filter(Boolean));
    const re = new RegExp(forms.map((x) => `\\b${x}\\b`).join("|"), "i");
    for (const f of sourceFiles(index)) { if (f.rel === en.source.file || f.lang === "Config") continue; if (re.test(readText(f.abs))) { mentions++; if (mentions > 2) break; } }
    if (mentions === 0) findings.push({ id: id(), severity: relTargets.has(en.name) ? "low" : "medium", category: "orphan-entity", title: `Entity "${en.name}" is never referenced outside its definition`, detail: `Defined in ${en.source.file}. No endpoint exposes it and no other source file mentions it. Possibly dead data model or an over-built feature.`, evidence: [en.source], feature: en.feature });
  }

  // UI-only restrictions: frontend role check in a feature whose backend endpoints never mention that role (or have no restriction at all)
  const backendRolesByFeature = new Map<string, Set<string>>();
  for (const e of endpoints) { if (!backendRolesByFeature.has(e.feature)) backendRolesByFeature.set(e.feature, new Set()); for (const r of e.roles) backendRolesByFeature.get(e.feature)!.add(r); }
  const allBackendRoles = new Set([...endpoints.flatMap((e) => e.roles), ...access.checks.flatMap((c) => c.roles), ...access.pathRules.flatMap((p) => p.roles)]);
  const uiOnly = new Map<string, { role: string; evidence: typeof access.frontendChecks }>();
  for (const fc of access.frontendChecks) for (const r of fc.roles) {
    if (allBackendRoles.has(r)) continue;
    const key = r;
    if (!uiOnly.has(key)) uiOnly.set(key, { role: r, evidence: [] });
    uiOnly.get(key)!.evidence.push(fc);
  }
  for (const [, v] of uiOnly) findings.push({ id: id(), severity: "high", category: "ui-only-restriction", title: `Role "${v.role}" is only enforced in the UI`, detail: `${v.evidence.length} frontend check${v.evidence.length > 1 ? "s reference" : " references"} this role but no backend guard, decorator or path rule does. UI-only restrictions can be bypassed by calling the API directly.`, evidence: v.evidence.slice(0, 5).map((e) => e.source) });

  // inconsistent restrictions within a resource: some write endpoints role-restricted, others open to any authenticated user
  const byRes = new Map<string, Endpoint[]>();
  for (const e of endpoints) { const k = `${e.feature}|${e.resource}`; if (!byRes.has(k)) byRes.set(k, []); byRes.get(k)!.push(e); }
  for (const [k, eps] of byRes) {
    if (/^(auth|login|account|session|sessions|me|profile|password)$/i.test(k.split("|")[1])) continue;
    const writesR = eps.filter((e) => /^(POST|PUT|PATCH|DELETE|MUTATION)$/.test(e.method) && !/\/(me|self|own|profile)(\/|$)/.test(e.path));
    const restricted = writesR.filter((e) => e.roles.length || e.permissions.length);
    const open = writesR.filter((e) => !e.roles.length && !e.permissions.length && !e.isPublic);
    if (restricted.length && open.length) findings.push({ id: id(), severity: "medium", category: "inconsistent-restriction", title: `Inconsistent restrictions on "${k.split("|")[1]}" writes`, detail: `${restricted.map((e) => `${e.method} ${e.path} → ${[...e.roles, ...e.permissions].join(", ")}`).join("; ")} but ${open.map((e) => `${e.method} ${e.path}`).join(", ")} only require${open.length === 1 ? "s" : ""} authentication.`, evidence: [...restricted, ...open].slice(0, 6).map((e) => e.source), feature: k.split("|")[0] });
  }

  // duplicate endpoints
  const seen = new Map<string, Endpoint[]>();
  for (const e of endpoints) { const k = endpointKey(e); if (!seen.has(k)) seen.set(k, []); seen.get(k)!.push(e); }
  for (const [k, eps] of seen) if (eps.length > 1 && uniq(eps.map((e) => e.source.file)).length > 1) findings.push({ id: id(), severity: "low", category: "duplicate-endpoint", title: `Endpoint ${k} is defined ${eps.length} times`, detail: eps.map((e) => `${e.source.file}:${e.source.line}`).join(", "), evidence: eps.map((e) => e.source) });

  const frontendOnly = new Set(features.filter((f) => { const fl = index.files.filter((x) => x.feature === f.name && !x.isTest && x.lang !== "Config"); return fl.length > 0 && fl.every((x) => x.isFrontend); }).map((f) => f.name));
  // complexity hotspots
  const locs = features.filter((f) => f.loc > 0).map((f) => f.loc).sort((a, b) => a - b);
  const median = locs.length ? locs[Math.floor(locs.length / 2)] : 0;
  for (const f of features) if (median > 0 && f.loc > Math.max(3 * median, 2500) && f.name !== "core" && !frontendOnly.has(f.name)) findings.push({ id: id(), severity: "info", category: "complexity-hotspot", title: `Feature "${f.name}" is a size outlier (${f.loc.toLocaleString()} LOC)`, detail: `Median feature size is ${median.toLocaleString()} LOC. Large features are where over-building and unclear ownership usually hide.`, evidence: [], feature: f.name });

  // empty features (code but no endpoints and no entities)
  for (const f of features) if (f.endpoints === 0 && f.entities.length === 0 && f.loc > 300 && !frontendOnly.has(f.name) && !/^(core|shared|common|utils|config|test|tests|scripts|docs|infra|types|ui|components|styles|assets|public|hooks|lib|dependencies|mappers|schemas|persistence|security|storage|messaging|ws|websocket|constants|pagination|error_handlers|exceptions)$/.test(f.name) && !/(_schemas?|_mappers?|_responses?|_use_?cases?|_helpers?|_utils?|_dispatcher|_renderer|_logger|_publisher)$/.test(f.name)) findings.push({ id: id(), severity: "info", category: "empty-feature", title: `Feature "${f.name}" has code but no endpoints or entities`, detail: `${f.files} files / ${f.loc.toLocaleString()} LOC under ${f.paths.join(", ")}. Likely UI-only, a library, or an unfinished feature. Confirm it is still wanted.`, evidence: [], feature: f.name });

  const order = { high: 0, medium: 1, low: 2, info: 3 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Normalised entity key: strips ORM suffixes (UserModel, UserEntity, users_table) and separators. */
export function entityKey(name: string): string {
  return name.replace(/(Model|Entity|Schema|Table|Record|Row|Orm|Dao|Document|Doc)$/i, "").replace(/[_-]/g, "").toLowerCase();
}
