import path from "node:path";
import type { Endpoint, FileInfo, ProjectIndex } from "../types.js";
import { readText, resolveImport, sourceFiles } from "../indexer.js";
import { nest } from "./nest.js";
import { actionFromEndpoint, bracketBody, joinPath, lineOf, looksLikeAuthGuard, matchBracket, normalizePath, normalizeRole, NOT_GUARD_RE, parseSpringEl, resourceFromPath, roleFromGuardName, rolesAndPermsFromCall, splitTopLevel, stringLiterals, uniq, uniqBy } from "../util.js";

const HTTP = ["get", "post", "put", "patch", "delete", "del", "options", "head", "all"];

export interface Draft {
  method: string; path: string; handler: string; framework: string; file: string; line: number;
  guards: string[]; roles: string[]; permissions: string[]; explicitPublic?: boolean; feature: string;
}

function finalize(d: Draft): Endpoint {
  const p = normalizePath(d.path || "/");
  const resource = resourceFromPath(p);
  const guards = uniq(d.guards.filter(Boolean));
  const hasAuth = guards.some(looksLikeAuthGuard) || d.roles.length > 0 || d.permissions.length > 0;
  return {
    method: d.method.toUpperCase() === "DEL" ? "DELETE" : d.method.toUpperCase(),
    path: p,
    handler: d.handler || "inline",
    framework: d.framework,
    source: { file: d.file, line: d.line },
    guards,
    roles: uniq(d.roles.map(normalizeRole).filter(Boolean)),
    permissions: uniq(d.permissions),
    isPublic: d.explicitPublic === true ? true : !hasAuth,
    feature: d.feature,
    resource,
    action: actionFromEndpoint(d.method, p, resource),
  };
}

/** Interpret a middleware/guard argument expression: name + roles/perms it implies. */
function interpretGuardArg(arg: string): { name: string; roles: string[]; perms: string[]; isPublic: boolean } {
  const a = arg.trim();
  const call = /^([\w.$]+)\s*\(([\s\S]*)\)\s*$/.exec(a);
  if (call) {
    const name = call[1].split(".").pop()!;
    const { roles, perms } = rolesAndPermsFromCall(name, call[2]);
    return { name: call[1], roles, perms, isPublic: /public|anonymous|optional/i.test(name) && !/permission/i.test(name) };
  }
  if (/^[\w.$]+$/.test(a)) {
    const name = a.split(".").pop()!;
    // e.g. isAdmin, requireAdmin, adminOnly, ensureManager
    const rm = /^(?:is|require|ensure|only|must[Bb]e|check|verify)?([A-Z][a-z]+)(?:Only|Required|Guard|Middleware)?$/.exec(name);
    const roles: string[] = [];
    if (rm && /^(Admin|Manager|Owner|Staff|Superuser|Editor|Moderator|Teacher|Student|Vendor|Seller|Customer|Employee|Supervisor|Agent|Doctor|Patient|Driver|Partner|Guest|Member|Subscriber)$/i.test(rm[1])) roles.push(rm[1]);
    const am = /^(admin|manager|owner|staff|superuser|editor|moderator)(Only|Auth|Guard|Middleware)$/i.exec(name);
    if (am) roles.push(am[1]);
    roles.push(...roleFromGuardName(name));
    return { name: a, roles, perms: [], isPublic: false };
  }
  return { name: "", roles: [], perms: [], isPublic: false };
}

// ---------- Express / Fastify / Koa / Hono / Restify ----------
function expressLike(text: string, f: FileInfo, index: ProjectIndex, out: Draft[]) {
  const re = /\b([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\.(get|post|put|patch|delete|del|options|head|all)\s*\(\s*(['"`])/g;
  let m: RegExpExecArray | null;
  // file-level guards: router.use(auth) / app.use(authenticate) without a path, or with a path prefix
  const fileGuards: { prefix: string; name: string; roles: string[]; perms: string[] }[] = [];
  const useRe = /\b([\w$]+)\.use\s*\(/g;
  while ((m = useRe.exec(text))) {
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const args = splitTopLevel(b.body);
    let prefix = "";
    if (args.length && /^['"`]/.test(args[0])) { prefix = stringLiterals(args[0])[0] ?? ""; args.shift(); }
    for (const a of args) {
      const g = interpretGuardArg(a);
      if (g.name && (looksLikeAuthGuard(g.name) || g.roles.length || g.perms.length)) fileGuards.push({ prefix, name: g.name, roles: g.roles, perms: g.perms });
    }
  }
  while ((m = re.exec(text))) {
    const objName = m[1];
    if (/^(res|response|reply|ctx|axios|http|https|fetch|client|api|request|got|superagent|instance|this\.http|this\.client|storage|cache|redis|map|headers|params|query|localStorage|sessionStorage|form|formData|url|searchParams|store|db|knex|supabase|s3|bucket|Http|HttpClient)$/i.test(objName)) continue;
    if (/\bnew\s+Map|\.get\s*\(\s*['"][^'"]*['"]\s*\)\s*(?:\?\?|\|\||;|\)|,|\.)/.test(text.slice(m.index, m.index + 80)) && !/,/.test(text.slice(m.index, text.indexOf(")", m.index)))) continue;
    const openIdx = m.index + m[0].length - 2;
    const b = bracketBody(text, openIdx);
    if (!b) continue;
    const args = splitTopLevel(b.body);
    if (args.length < 2) continue; // needs a handler
    const pth = stringLiterals(args[0])[0] ?? args[0].replace(/[`'"]/g, "");
    if (!/^[\/*:]/.test(pth) && pth !== "") continue;
    const guards: string[] = [];
    const roles: string[] = [];
    const perms: string[] = [];
    let handler = "inline";
    let explicitPublic: boolean | undefined;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const isLast = i === args.length - 1;
      if (/=>|^function\b|^async\b/.test(a)) { if (isLast) handler = "inline"; continue; }
      const g = interpretGuardArg(a);
      if (!g.name) continue;
      if (isLast) { handler = g.name; if (!looksLikeAuthGuard(g.name)) continue; }
      guards.push(g.name);
      roles.push(...g.roles);
      perms.push(...g.perms);
      if (g.isPublic) explicitPublic = true;
    }
    for (const fg of fileGuards) if (!fg.prefix || pth.startsWith(fg.prefix)) { guards.push(fg.name); roles.push(...fg.roles); perms.push(...fg.perms); }
    out.push({ method: m[2], path: pth, handler, framework: "Express-style", file: f.rel, line: lineOf(text, m.index), guards, roles, permissions: perms, explicitPublic, feature: f.feature });
  }
  // fastify.route({ method, url, preHandler, handler })
  const froute = /\.route\s*\(\s*\{/g;
  while ((m = froute.exec(text))) {
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const method = /method\s*:\s*['"](\w+)['"]/.exec(b.body)?.[1];
    const url = /url\s*:\s*['"]([^'"]+)['"]/.exec(b.body)?.[1] ?? /path\s*:\s*['"]([^'"]+)['"]/.exec(b.body)?.[1];
    if (!method || !url) continue;
    const pre = /(?:preHandler|preValidation|onRequest|beforeHandler)\s*:\s*(\[[^\]]*\]|[\w.]+(?:\([^)]*\))?)/.exec(b.body)?.[1] ?? "";
    const guards = splitTopLevel(pre.replace(/^\[|\]$/g, "")).map((a) => interpretGuardArg(a)).filter((g) => g.name);
    const handler = /handler\s*:\s*([\w.]+)/.exec(b.body)?.[1] ?? "inline";
    out.push({ method, path: url, handler, framework: "Fastify", file: f.rel, line: lineOf(text, m.index), guards: guards.map((g) => g.name), roles: guards.flatMap((g) => g.roles), permissions: guards.flatMap((g) => g.perms), feature: f.feature });
  }
  void index;
}

/** Resolve app.use('/prefix', router) mounts across files and prefix the endpoints found in the mounted file. */
function applyMounts(index: ProjectIndex, drafts: Draft[]) {
  const byFile = new Map<string, Draft[]>();
  for (const d of drafts) { if (!byFile.has(d.file)) byFile.set(d.file, []); byFile.get(d.file)!.push(d); }
  const mounts: { file: string; prefix: string; guards: string[]; roles: string[]; perms: string[] }[] = [];
  for (const f of sourceFiles(index, ["TypeScript", "JavaScript"])) {
    const text = readText(f.abs);
    if (!text || !/\.use\s*\(\s*['"`]\//.test(text)) continue;
    const imports = new Map<string, string>();
    let m: RegExpExecArray | null;
    const impRe = /import\s+(?:(\w+)|\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]|(?:const|let|var)\s+(?:(\w+)|\{([^}]*)\})\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = impRe.exec(text))) {
      const spec = m[4] ?? m[7];
      const names = [m[1], m[3], m[5], ...(m[2] ?? m[6] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!)].filter(Boolean) as string[];
      for (const n of names) imports.set(n, spec);
    }
    const useRe = /\b[\w$]+\.use\s*\(\s*(['"`])([^'"`]*)\1\s*,([\s\S]*?)\)\s*;?/g;
    while ((m = useRe.exec(text))) {
      const openIdx = text.indexOf("(", m.index);
      const b = bracketBody(text, openIdx);
      if (!b) continue;
      const args = splitTopLevel(b.body);
      const prefix = stringLiterals(args[0])[0] ?? "";
      const guards: string[] = []; const roles: string[] = []; const perms: string[] = [];
      let target: FileInfo | undefined;
      for (const a of args.slice(1)) {
        const g = interpretGuardArg(a);
        const ident = /^([\w$]+)(?:\.[\w$]+)*(?:\(\))?$/.exec(a.trim())?.[1];
        const spec = ident ? imports.get(ident) : undefined;
        const resolved = spec ? resolveImport(index, f.rel, spec) : undefined;
        if (resolved && byFile.has(resolved.rel)) { target = resolved; continue; }
        if (g.name && (looksLikeAuthGuard(g.name) || g.roles.length)) { guards.push(g.name); roles.push(...g.roles); perms.push(...g.perms); }
      }
      if (target) mounts.push({ file: target.rel, prefix, guards, roles, perms });
    }
  }
  for (const mnt of mounts) {
    for (const d of byFile.get(mnt.file) ?? []) {
      d.path = joinPath(mnt.prefix, d.path);
      d.guards.push(...mnt.guards); d.roles.push(...mnt.roles); d.permissions.push(...mnt.perms);
    }
  }
}

export function decoratorGuards(window: string): { guards: string[]; roles: string[]; perms: string[]; isPublic: boolean; hasAuth: boolean } {
  const guards: string[] = []; const roles: string[] = []; const perms: string[] = [];
  let isPublic = false;
  const re = /@(\w+)\s*(\(([^()]*(?:\([^()]*\)[^()]*)*)\))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window))) {
    const name = m[1]; const args = m[3] ?? "";
    if (/^(Get|Post|Put|Patch|Delete|All|Head|Options|Query|Mutation|Subscription|Body|Param|Req|Res|HttpCode|ApiOperation|ApiResponse|ApiTags|UsePipes|UseInterceptors|Header|Redirect|Version|Args|Context|Info|Parent|ResolveField|ApiParam|ApiQuery|ApiBody|ApiOkResponse|ApiCreatedResponse|Injectable|Controller|Resolver|Inject|Module|Headers|Ip|Session|UploadedFile|UploadedFiles|Next|HostParam|ApiProperty|IsString|IsOptional|IsNumber|IsEnum|ValidateNested|Type|Transform|Expose|Exclude|SkipThrottle|Throttle|ApiConsumes|ApiProduces|ApiExtraModels|ApiUnauthorizedResponse|ApiForbiddenResponse|ApiNotFoundResponse|ApiBadRequestResponse)$/.test(name)) continue;
    if (/^(Public|SkipAuth|AllowAnonymous|NoAuth|Anonymous|OptionalAuth|SkipJwtAuth)$/i.test(name)) { isPublic = true; continue; }
    if (name === "UseGuards") {
      for (const a of splitTopLevel(args)) { const g = a.trim().replace(/\(\)$/, ""); if (g) { guards.push(g); const rp = rolesAndPermsFromCall(g, a.includes("(") ? a.slice(a.indexOf("(") + 1, -1) : ""); roles.push(...rp.roles); perms.push(...rp.perms); } }
      continue;
    }
    if (/^(Roles|Role|HasRoles|HasRole|RolesAllowed|AllowRoles|RequireRoles|RequireRole|Authorize|Auth|Scopes|Groups)$/i.test(name)) { guards.push(`@${name}`); const rp = rolesAndPermsFromCall(name, args); roles.push(...rp.roles); perms.push(...rp.perms); continue; }
    if (/^(Permissions|Permission|RequirePermissions|RequirePermission|HasPermission|HasPermissions|CheckPolicies|CheckAbilities|Ability|Abilities|Can|Policies|Policy)$/i.test(name)) { guards.push(`@${name}`); const rp = rolesAndPermsFromCall(name, args); perms.push(...rp.perms, ...rp.roles); continue; }
    if (/^(ApiBearerAuth|ApiSecurity|ApiCookieAuth|ApiBasicAuth|ApiOAuth2)$/.test(name)) { guards.push(`@${name}`); continue; }
    if (looksLikeAuthGuard(name)) { guards.push(`@${name}`); const rp = rolesAndPermsFromCall(name, args); roles.push(...rp.roles); perms.push(...rp.perms); }
  }
  return { guards, roles, perms, isPublic, hasAuth: guards.length > 0 };
}

// ---------- Next.js route handlers / pages api ----------
function nextjs(text: string, f: FileInfo, out: Draft[]) {
  const rel = f.rel;
  const appM = /(?:^|\/)app\/(.*?)route\.(ts|js|tsx|jsx|mjs)$/.exec(rel);
  const pagesM = /(?:^|\/)pages\/api\/(.*)\.(ts|js|tsx|jsx|mjs)$/.exec(rel);
  if (!appM && !pagesM) return;
  const guardHints = authHintsInFile(text);
  if (appM) {
    const p = "/" + appM[1].split("/").filter((s) => s && !/^\(.*\)$/.test(s)).join("/");
    const re = /export\s+(?:async\s+)?(?:function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const method = m[1] ?? m[2];
      const fnBody = text.slice(m.index, Math.min(text.length, m.index + 4000));
      const hints = authHintsInFile(fnBody);
      const h = hints.guards.length ? hints : guardHints;
      out.push({ method, path: p.replace(/\/$/, "") || "/", handler: `route.${method}`, framework: "Next.js", file: rel, line: lineOf(text, m.index), guards: h.guards, roles: h.roles, permissions: h.perms, feature: f.feature });
    }
    // re-exports: export { GET, POST } from ...
    const rx = /export\s*\{([^}]*)\}\s*from/g;
    while ((m = rx.exec(text))) for (const n of m[1].split(",").map((s) => s.trim())) if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(n)) out.push({ method: n, path: p.replace(/\/$/, "") || "/", handler: `route.${n}`, framework: "Next.js", file: rel, line: lineOf(text, m.index), guards: guardHints.guards, roles: guardHints.roles, permissions: guardHints.perms, feature: f.feature });
  } else if (pagesM) {
    const p = "/api/" + pagesM[1].replace(/\/index$/, "");
    const methods = uniq(Array.from(text.matchAll(/req\.method\s*(?:===|==|!==|!=)\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/g)).map((x) => x[1]).concat(Array.from(text.matchAll(/case\s+['"](GET|POST|PUT|PATCH|DELETE)['"]/g)).map((x) => x[1])));
    for (const method of methods.length ? methods : ["ANY"]) out.push({ method, path: p, handler: "default", framework: "Next.js pages/api", file: rel, line: 1, guards: guardHints.guards, roles: guardHints.roles, permissions: guardHints.perms, feature: f.feature });
  }
}

/** Heuristic in-file authentication/authorization hints (used for handler-style frameworks without route tables). */
export function authHintsInFile(text: string): { guards: string[]; roles: string[]; perms: string[] } {
  const guards: string[] = []; const roles: string[] = []; const perms: string[] = [];
  const gre = /\b(getServerSession|auth\(\)|getAuth\(|currentUser\(|getToken\(|verifyToken\(|verifyJwt\(|requireUser\(|requireAuth\(|requireSession\(|getSession\(|withAuth\(|withApiAuth\(|withRole\(|requireRole\(|requireAdmin\(|assertRole\(|assertAdmin\(|checkRole\(|checkPermission\(|hasPermission\(|authorize\(|isAuthenticated\(|clerkClient|supabase\.auth\.getUser|jwt\.verify\(|jwtVerify\(|validateRequest\(|getUserFromRequest\(|authenticate\(|ensureAuth\(|protectRoute\(|auth\.protect\(|locals\.user|request\.auth|ctx\.session|session\.user|req\.user\b|request\.user\b|current_user\b|get_current_user\(|Depends\(|login_required|@login_required|permission_required|authorize!|before_action\s+:authenticate)/g;
  let m: RegExpExecArray | null;
  while ((m = gre.exec(text))) guards.push(m[1].replace(/\($/, ""));
  const rre = /(?:role|roles|userRole|user_role|user\.role|session\.user\.role|profile\.role|claims\.role|\.role)\s*(?:===|==|!==|!=|\.includes\(|\bin\b|\.has\()\s*\(?\s*['"`](\w+)['"`]/g;
  while ((m = rre.exec(text))) roles.push(m[1]);
  const rre2 = /['"`](\w+)['"`]\s*(?:===|==)\s*(?:\w+\.)*role\b/g;
  while ((m = rre2.exec(text))) roles.push(m[1]);
  const rre3 = /\b(?:requireRole|hasRole|assertRole|withRole|checkRole|hasAnyRole|isRole|allowRoles|roles?)\s*\(\s*([^)]*)\)/g;
  while ((m = rre3.exec(text))) roles.push(...stringLiterals(m[1]));
  const rre4 = /\.(?:isAdmin|is_admin|is_staff|is_superuser|isSuperAdmin|isOwner)\b/g;
  while ((m = rre4.exec(text))) roles.push(m[0].slice(1).replace(/^is_?/i, ""));
  const pre = /\b(?:hasPermission|checkPermission|requirePermission|can|authorize|ability\.can|permissions?\.includes)\s*\(\s*['"`]([\w:._\- ]+)['"`]/g;
  while ((m = pre.exec(text))) perms.push(m[1]);
  return { guards: uniq(guards), roles: uniq(roles.map(normalizeRole)), perms: uniq(perms) };
}

// ---------- FastAPI ----------
function fastapi(text: string, f: FileInfo, out: Draft[], routerPrefixes: Map<string, { prefix: string; deps: string[] }>, pyDefs: Map<string, PyDef[]>) {
  const localRouters = new Map<string, { prefix: string; deps: string[] }>();
  let m: RegExpExecArray | null;
  const rre = /(\w+)\s*=\s*APIRouter\s*\(/g;
  while ((m = rre.exec(text))) {
    const b = bracketBody(text, m.index + m[0].length - 1);
    const args = b?.body ?? "";
    const prefix = /prefix\s*=\s*['"]([^'"]*)['"]/.exec(args)?.[1] ?? "";
    const deps = /dependencies\s*=\s*\[([^\]]*)\]/.exec(args)?.[1] ?? "";
    localRouters.set(m[1], { prefix, deps: depsToGuards(deps) });
  }
  const re = /@(\w+)\.(get|post|put|patch|delete|options|head|api_route|websocket)\s*\(/g;
  while ((m = re.exec(text))) {
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const args = splitTopLevel(b.body);
    const pth = stringLiterals(args[0] ?? "")[0] ?? "";
    const deps = /dependencies\s*=\s*\[([\s\S]*)\]/.exec(b.body)?.[1] ?? "";
    const guards = depsToGuards(deps);
    // function signature dependencies
    const defM = /\n\s*(?:async\s+)?def\s+(\w+)\s*\(/g;
    defM.lastIndex = b.end;
    const dm = defM.exec(text);
    let handler = "unknown";
    if (dm) {
      handler = dm[1];
      const sig = bracketBody(text, dm.index + dm[0].length - 1);
      if (sig) guards.push(...depsToGuards(sig.body));
    }
    const rp = guards.flatMap((g) => { const c = /^([\w.]+)\((.*)\)$/.exec(g); return c ? [rolesAndPermsFromCall(c[1], c[2])] : [rolesAndPermsFromCall(g, "")]; });
    const routerInfo = localRouters.get(m[1]) ?? routerPrefixes.get(`${f.rel}:${m[1]}`) ?? routerPrefixes.get(f.rel);
    const includePrefix = routerPrefixes.get(f.rel)?.prefix ?? "";
    const fullPath = joinPath(includePrefix, joinPath(routerInfo?.prefix ?? "", pth));
    const allGuards = [...guards, ...(routerInfo?.deps ?? []), ...(routerPrefixes.get(f.rel)?.deps ?? [])];
    const expanded = expandPythonGuards(allGuards, pyDefs);
    const methods = m[2] === "api_route" ? (/methods\s*=\s*\[([^\]]*)\]/.exec(b.body)?.[1] ? stringLiterals(/methods\s*=\s*\[([^\]]*)\]/.exec(b.body)![1]) : ["ANY"]) : [m[2] === "websocket" ? "WS" : m[2]];
    for (const method of methods) out.push({ method, path: fullPath, handler, framework: "FastAPI", file: f.rel, line: lineOf(text, m.index), guards: expanded.guards, roles: [...rp.flatMap((x) => x.roles), ...expanded.roles], permissions: [...rp.flatMap((x) => x.perms), ...expanded.perms], feature: f.feature });
  }
}

function depsToGuards(s: string): string[] {
  const out: string[] = [];
  const re = /Depends\s*\(\s*([\w.]+(?:\([^()]*\))?)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1]);
  const sec = /Security\s*\(\s*([\w.]+)[^)]*scopes\s*=\s*\[([^\]]*)\]/g;
  while ((m = sec.exec(s))) out.push(`${m[1]}(${m[2]})`);
  return out;
}

function fastapiIncludes(index: ProjectIndex): Map<string, { prefix: string; deps: string[] }> {
  const map = new Map<string, { prefix: string; deps: string[] }>();
  for (const f of sourceFiles(index, ["Python"])) {
    const text = readText(f.abs);
    if (!text.includes("include_router")) continue;
    const imports = new Map<string, string>(); // alias -> module path
    let m: RegExpExecArray | null;
    const ire = /^\s*from\s+([\w.]+)\s+import\s+([^\n]+)$/gm;
    while ((m = ire.exec(text))) for (const n of m[2].split(",").map((s) => s.trim())) { const [name, alias] = n.split(/\s+as\s+/); imports.set(alias ?? name, `${m[1]}.${name}`); }
    const ire2 = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?$/gm;
    while ((m = ire2.exec(text))) imports.set(m[2] ?? m[1], m[1]);
    const re = /include_router\s*\(/g;
    while ((m = re.exec(text))) {
      const b = bracketBody(text, m.index + m[0].length - 1);
      if (!b) continue;
      const args = splitTopLevel(b.body);
      const target = args[0] ?? "";
      const prefix = /prefix\s*=\s*['"]([^'"]*)['"]/.exec(b.body)?.[1] ?? "";
      const deps = depsToGuards(/dependencies\s*=\s*\[([^\]]*)\]/.exec(b.body)?.[1] ?? "");
      const parts = target.split(".");
      const alias = parts[0];
      const mod = imports.get(alias) ?? (parts.length > 1 ? imports.get(parts.slice(0, -1).join(".")) : undefined) ?? alias;
      const modPath = mod.replace(/^\.+/, "").replace(/\./g, "/");
      const cand = index.files.find((x) => x.lang === "Python" && (x.rel.endsWith(`${modPath}.py`) || x.rel.endsWith(`${modPath}/__init__.py`) || x.rel.endsWith(`${modPath}/${parts[parts.length - 1]}.py`) || x.rel.endsWith(`/${parts[parts.length - 2] ?? alias}.py`)));
      if (cand && cand.rel !== f.rel) {
        const prev = map.get(cand.rel);
        map.set(cand.rel, { prefix: joinPath(prev?.prefix ?? "", prefix), deps: [...(prev?.deps ?? []), ...deps] });
      }
    }
  }
  return map;
}

// ---------- Flask ----------
function flask(text: string, f: FileInfo, out: Draft[]) {
  let m: RegExpExecArray | null;
  const bps = new Map<string, string>();
  const bre = /(\w+)\s*=\s*Blueprint\s*\(/g;
  while ((m = bre.exec(text))) { const b = bracketBody(text, m.index + m[0].length - 1); bps.set(m[1], /url_prefix\s*=\s*['"]([^'"]*)['"]/.exec(b?.body ?? "")?.[1] ?? ""); }
  const re = /@(\w+)\.(route|get|post|put|patch|delete)\s*\(/g;
  while ((m = re.exec(text))) {
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const pth = stringLiterals(b.body)[0] ?? "";
    const methods = m[2] === "route" ? (/methods\s*=\s*[\[(]([^\])]*)[\])]/.exec(b.body) ? stringLiterals(/methods\s*=\s*[\[(]([^\])]*)[\])]/.exec(b.body)![1]) : ["GET"]) : [m[2]];
    const defRe = /\n\s*(?:async\s+)?def\s+(\w+)\s*\(/g;
    defRe.lastIndex = b.end;
    const dm = defRe.exec(text);
    const window = text.slice(b.end, dm ? dm.index : b.end);
    const decos = Array.from(window.matchAll(/@([\w.]+)(?:\(([^)]*)\))?/g));
    const guards: string[] = []; const roles: string[] = []; const perms: string[] = [];
    for (const d of decos) { const name = d[1].split(".").pop()!; if (looksLikeAuthGuard(name) || /required|only/i.test(name)) { guards.push(d[1]); const rp = rolesAndPermsFromCall(name, d[2] ?? ""); roles.push(...rp.roles); perms.push(...rp.perms); } }
    const hints = dm ? authHintsInFile(text.slice(dm.index, dm.index + 2500)) : { guards: [], roles: [], perms: [] };
    for (const method of methods) out.push({ method, path: joinPath(bps.get(m[1]) ?? "", pth), handler: dm?.[1] ?? "unknown", framework: "Flask", file: f.rel, line: lineOf(text, m.index), guards: [...guards, ...hints.guards.filter((g) => /login_required|current_user/.test(g))], roles: [...roles, ...hints.roles], permissions: [...perms, ...hints.perms], feature: f.feature });
  }
}

// ---------- Django ----------
function django(index: ProjectIndex, out: Draft[]) {
  const urlFiles = sourceFiles(index, ["Python"]).filter((f) => /urls\.py$/.test(f.rel) || /(^|\/)urls\/[^/]+\.py$/.test(f.rel));
  if (!urlFiles.length) return;
  const pyFiles = sourceFiles(index, ["Python"]);
  const findView = (name: string): { file: FileInfo; text: string; idx: number; isClass: boolean } | undefined => {
    const short = name.split(".").pop()!;
    for (const pf of pyFiles) {
      const t = readText(pf.abs);
      const cm = new RegExp(`^class\\s+${short}\\s*\\(`, "m").exec(t);
      if (cm) return { file: pf, text: t, idx: cm.index, isClass: true };
      const fm = new RegExp(`^def\\s+${short}\\s*\\(`, "m").exec(t);
      if (fm) return { file: pf, text: t, idx: fm.index, isClass: false };
    }
    return undefined;
  };
  // include() prefixes
  const includes = new Map<string, string>(); // urls file rel -> prefix
  for (const uf of urlFiles) {
    const text = readText(uf.abs);
    const re = /(?:path|re_path|url)\s*\(\s*r?['"]([^'"]*)['"]\s*,\s*include\s*\(\s*(?:\(\s*)?['"]([\w.]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const mod = m[2].replace(/\./g, "/");
      const target = urlFiles.find((x) => x.rel.endsWith(`${mod}.py`) || x.rel.endsWith(`${mod}/urls.py`));
      if (target) includes.set(target.rel, joinPath(includes.get(uf.rel) ?? "", m[1]));
    }
  }
  for (const uf of urlFiles) {
    const text = readText(uf.abs);
    const prefix = includes.get(uf.rel) ?? "";
    let m: RegExpExecArray | null;
    const re = /(?:path|re_path|url)\s*\(\s*r?['"]([^'"]*)['"]\s*,\s*([\w.]+)(?:\.as_view\(\))?/g;
    while ((m = re.exec(text))) {
      if (m[2] === "include") continue;
      const view = findView(m[2]);
      const info = view ? djangoViewInfo(view.text, view.idx, view.isClass) : { methods: ["ANY"], guards: [], roles: [], perms: [] };
      for (const method of info.methods) out.push({ method, path: joinPath(prefix, m[1]), handler: m[2], framework: "Django", file: view?.file.rel ?? uf.rel, line: view ? lineOf(view.text, view.idx) : lineOf(text, m.index), guards: info.guards, roles: info.roles, permissions: info.perms, feature: view?.file.feature ?? uf.feature });
    }
    const rre = /router\.register\s*\(\s*r?['"]([^'"]*)['"]\s*,\s*([\w.]+)/g;
    while ((m = rre.exec(text))) {
      const view = findView(m[2]);
      const info = view ? djangoViewInfo(view.text, view.idx, true) : { methods: [], guards: [], roles: [], perms: [] };
      const base = joinPath(prefix, m[1]);
      const ops: [string, string][] = [["GET", base], ["POST", base], ["GET", `${base}/:id`], ["PUT", `${base}/:id`], ["PATCH", `${base}/:id`], ["DELETE", `${base}/:id`]];
      for (const [method, p] of ops) out.push({ method, path: p, handler: m[2], framework: "Django REST", file: view?.file.rel ?? uf.rel, line: view ? lineOf(view.text, view.idx) : lineOf(text, m.index), guards: info.guards, roles: info.roles, permissions: info.perms, feature: view?.file.feature ?? uf.feature });
      if (view) {
        const body = view.text.slice(view.idx, view.idx + 6000);
        const are = /@action\s*\(([^)]*)\)\s*\n\s*def\s+(\w+)/g;
        let am: RegExpExecArray | null;
        while ((am = are.exec(body))) {
          const methods = stringLiterals(/methods\s*=\s*\[([^\]]*)\]/.exec(am[1])?.[1] ?? "") ;
          const detail = /detail\s*=\s*True/.test(am[1]);
          const pc = /permission_classes\s*=\s*\[([^\]]*)\]/.exec(am[1])?.[1];
          const g = pc ? pc.split(",").map((s) => s.trim()).filter(Boolean) : info.guards;
          for (const method of methods.length ? methods : ["GET"]) out.push({ method: method.toUpperCase(), path: `${base}${detail ? "/:id" : ""}/${am[2]}`, handler: `${m[2]}.${am[2]}`, framework: "Django REST", file: view.file.rel, line: lineOf(view.text, view.idx + am.index), guards: g, roles: drfRoles(g), permissions: info.perms, feature: view.file.feature });
        }
      }
    }
  }
}

function drfRoles(guards: string[]): string[] {
  const roles: string[] = [];
  for (const g of guards) { if (/IsAdminUser|IsSuperUser|IsStaff/i.test(g)) roles.push("admin"); const cm = /^Is(\w+?)(?:User|Only|OrReadOnly)?$/.exec(g.split(".").pop()!); if (cm && !/Authenticated|AuthenticatedOrReadOnly|Admin|Owner/.test(cm[1])) roles.push(cm[1]); }
  return roles;
}

function djangoViewInfo(text: string, idx: number, isClass: boolean): { methods: string[]; guards: string[]; roles: string[]; perms: string[] } {
  const pre = text.slice(Math.max(0, idx - 600), idx);
  const decoWindow = pre.slice(pre.lastIndexOf("\n\n") + 1);
  const guards: string[] = []; const roles: string[] = []; const perms: string[] = [];
  for (const d of decoWindow.matchAll(/@([\w.]+)(?:\(([^)]*)\))?/g)) {
    const name = d[1].split(".").pop()!;
    if (/login_required|permission_required|user_passes_test|staff_member_required|superuser_required|permission_classes|api_view|authentication_classes|login_not_required/.test(name) || looksLikeAuthGuard(name)) {
      if (name === "api_view") continue;
      guards.push(d[1]);
      if (name === "permission_required") perms.push(...stringLiterals(d[2] ?? ""));
      else if (name === "permission_classes") { const g = (d[2] ?? "").replace(/[\[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean); guards.push(...g); roles.push(...drfRoles(g)); }
      else if (/staff|superuser/.test(name)) roles.push("admin");
      else { const rp = rolesAndPermsFromCall(name, d[2] ?? ""); roles.push(...rp.roles); perms.push(...rp.perms); }
    }
  }
  let methods = ["ANY"];
  if (isClass) {
    const header = text.slice(idx, text.indexOf("\n", idx));
    const bases = /\(([^)]*)\)/.exec(header)?.[1] ?? "";
    const body = text.slice(idx, idx + 5000).split("\n\n\n")[0];
    const pc = /permission_classes\s*=\s*[\[(]([^\])]*)[\])]/.exec(body)?.[1];
    if (pc) { const g = pc.split(",").map((s) => s.trim()).filter(Boolean); guards.push(...g); roles.push(...drfRoles(g)); }
    if (/LoginRequiredMixin|PermissionRequiredMixin|UserPassesTestMixin|StaffRequiredMixin|AdminRequiredMixin/.test(bases)) { guards.push(...bases.split(",").map((s) => s.trim()).filter((s) => /Required|PassesTest/.test(s))); if (/Staff|Admin/.test(bases)) roles.push("admin"); }
    const pr = /permission_required\s*=\s*[\[(]?\s*['"]([^'"]+)['"]/.exec(body);
    if (pr) perms.push(pr[1]);
    const http = /http_method_names\s*=\s*\[([^\]]*)\]/.exec(body);
    const defs = Array.from(body.matchAll(/^\s+def\s+(get|post|put|patch|delete)\s*\(/gm)).map((x) => x[1].toUpperCase());
    if (http) methods = stringLiterals(http[1]).map((s) => s.toUpperCase());
    else if (defs.length) methods = uniq(defs);
    else if (/ListCreateAPIView|ModelViewSet/.test(bases)) methods = ["GET", "POST"];
    else if (/RetrieveUpdateDestroyAPIView/.test(bases)) methods = ["GET", "PUT", "PATCH", "DELETE"];
    else if (/ListAPIView|RetrieveAPIView|ListView|DetailView|TemplateView/.test(bases)) methods = ["GET"];
    else if (/CreateAPIView|CreateView|FormView/.test(bases)) methods = ["GET", "POST"];
    else if (/UpdateAPIView|UpdateView/.test(bases)) methods = ["PUT", "PATCH"];
    else if (/DestroyAPIView|DeleteView/.test(bases)) methods = ["DELETE"];
  } else {
    const body = text.slice(idx, idx + 3000);
    const ms = uniq(Array.from(body.matchAll(/request\.method\s*(?:==|in)\s*\(?\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/g)).map((x) => x[1]));
    const rm = /@require_(GET|POST|http_methods)\s*(?:\(\[([^\]]*)\])?/.exec(decoWindow);
    if (rm) methods = rm[1] === "http_methods" ? stringLiterals(rm[2] ?? "") : [rm[1]];
    else if (ms.length) methods = ms;
    const hints = authHintsInFile(body);
    roles.push(...hints.roles); perms.push(...hints.perms);
    if (/request\.user\.is_authenticated/.test(body)) guards.push("is_authenticated check");
  }
  return { methods, guards: uniq(guards), roles: uniq(roles), perms: uniq(perms) };
}

// ---------- Laravel ----------
function laravel(text: string, f: FileInfo, out: Draft[]) {
  if (!/Route::/.test(text)) return;
  // groups: find every ->group(function () { ... }) with its attribute chain
  const groups: { start: number; end: number; prefix: string; middleware: string[] }[] = [];
  const gre = /Route::([\s\S]*?)->group\s*\(\s*(?:function\s*\([^)]*\)\s*(?:use\s*\([^)]*\))?\s*\{|\[|__DIR__|base_path)/g;
  let m: RegExpExecArray | null;
  while ((m = gre.exec(text))) {
    const chain = m[1];
    if (chain.length > 600) continue;
    const prefix = /prefix\s*\(\s*['"]([^'"]*)['"]/.exec(chain)?.[1] ?? "";
    const mwM = /middleware\s*\(([^)]*)\)/.exec(chain);
    const middleware = mwM ? stringLiterals(mwM[1]).concat(Array.from(mwM[1].matchAll(/(\w+)::class/g)).map((x) => x[1])) : [];
    const openIdx = text.indexOf("{", m.index + m[0].length - 1);
    const end = matchBracket(text, openIdx);
    if (end === -1) continue;
    groups.push({ start: openIdx, end, prefix, middleware });
  }
  const re = /Route::(get|post|put|patch|delete|any|match|resource|apiResource|options|redirect|view)\s*\(/g;
  while ((m = re.exec(text))) {
    const b = bracketBody(text, m.index + m[0].length - 1);
    if (!b) continue;
    const args = splitTopLevel(b.body);
    const verb = m[1];
    let pth = stringLiterals(args[verb === "match" ? 1 : 0] ?? "")[0] ?? "";
    const target = args[verb === "match" ? 2 : 1] ?? "";
    const handler = (/(\w+)::class\s*,\s*['"](\w+)['"]/.exec(target) ? `${/(\w+)::class/.exec(target)![1]}@${/['"](\w+)['"]\s*\]/.exec(target)?.[1] ?? ""}` : stringLiterals(target)[0] ?? (/(\w+)::class/.exec(target)?.[1] ?? "closure"));
    // chained modifiers after the call
    const after = text.slice(b.end + 1, Math.min(text.length, text.indexOf(";", b.end) === -1 ? b.end + 400 : text.indexOf(";", b.end)));
    const mw: string[] = [];
    for (const mm of after.matchAll(/->middleware\s*\(([^)]*)\)/g)) mw.push(...stringLiterals(mm[1]), ...Array.from(mm[1].matchAll(/(\w+)::class/g)).map((x) => x[1]));
    for (const mm of after.matchAll(/->(can|cannot)\s*\(([^)]*)\)/g)) mw.push(`can:${stringLiterals(mm[2]).join(",")}`);
    const enclosing = groups.filter((g) => m!.index > g.start && m!.index < g.end);
    const prefix = enclosing.map((g) => g.prefix).filter(Boolean).join("/");
    const allMw = [...enclosing.flatMap((g) => g.middleware), ...mw];
    const guards: string[] = []; const roles: string[] = []; const perms: string[] = [];
    for (const w of allMw) {
      const rp = rolesAndPermsFromCall("middleware", `'${w}'`);
      roles.push(...rp.roles.filter(() => /^(role|roles|role_or_permission)\s*:/i.test(w)));
      perms.push(...rp.perms);
      if (/^(auth|auth:|verified|can:|role:|roles:|permission:|role_or_permission:|admin|sanctum|jwt|guest)/i.test(w) || /Auth|Admin|Role|Permission|Ensure|Verify|Check/.test(w)) guards.push(w);
      if (/^(admin|is_admin|isAdmin|EnsureAdmin|AdminMiddleware)$/i.test(w)) roles.push("admin");
    }
    const explicitPublic = allMw.some((w) => /^guest$/i.test(w)) ? true : undefined;
    const fullPath = joinPath(prefix, pth);
    if (verb === "resource" || verb === "apiResource") {
      const base = fullPath;
      const only = /->only\s*\(\s*\[([^\]]*)\]/.exec(after)?.[1];
      const except = /->except\s*\(\s*\[([^\]]*)\]/.exec(after)?.[1];
      let ops: [string, string, string][] = [["GET", base, "index"], ["POST", base, "store"], ["GET", `${base}/:id`, "show"], ["PUT", `${base}/:id`, "update"], ["DELETE", `${base}/:id`, "destroy"]];
      if (verb === "resource") ops.push(["GET", `${base}/create`, "create"], ["GET", `${base}/:id/edit`, "edit"]);
      if (only) { const o = stringLiterals(only); ops = ops.filter((x) => o.includes(x[2])); }
      if (except) { const e = stringLiterals(except); ops = ops.filter((x) => !e.includes(x[2])); }
      for (const [method, p, act] of ops) out.push({ method, path: p, handler: `${handler.replace(/@.*/, "")}@${act}`, framework: "Laravel", file: f.rel, line: lineOf(text, m.index), guards, roles, permissions: perms, explicitPublic, feature: f.feature });
      continue;
    }
    const methods = verb === "match" ? stringLiterals(args[0] ?? "").map((s) => s.toUpperCase()) : verb === "any" ? ["ANY"] : verb === "redirect" || verb === "view" ? ["GET"] : [verb.toUpperCase()];
    for (const method of methods) out.push({ method, path: fullPath, handler, framework: "Laravel", file: f.rel, line: lineOf(text, m.index), guards, roles, permissions: perms, explicitPublic, feature: f.feature });
  }
}

// ---------- Spring ----------
function spring(text: string, f: FileInfo, out: Draft[]) {
  if (!/@(RestController|Controller|RequestMapping)\b/.test(text)) return;
  const classRe = /((?:@\w+(?:\([^)]*\))?\s*)*)(?:public\s+)?(?:final\s+)?class\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(text))) {
    const annos = m[1];
    if (!/@(RestController|Controller)\b/.test(annos)) continue;
    const prefix = /@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?(?:\{\s*)?"([^"]*)"/.exec(annos)?.[1] ?? "";
    const classSec = springSecurity(annos);
    const open = text.indexOf("{", m.index + m[0].length);
    const end = matchBracket(text, open);
    if (end === -1) continue;
    const body = text.slice(open + 1, end);
    const mre = /((?:@\w+(?:\((?:[^()]|\([^()]*\))*\))?\s*)*)@(Get|Post|Put|Patch|Delete|Request)Mapping\s*(?:\(((?:[^()]|\([^()]*\))*)\))?\s*((?:@\w+(?:\((?:[^()]|\([^()]*\))*\))?\s*)*)(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:[\w<>\[\],?\s]+?)\s+(\w+)\s*\(/g;
    let mm: RegExpExecArray | null;
    while ((mm = mre.exec(body))) {
      const args = mm[3] ?? "";
      const pth = /(?:(?:value|path)\s*=\s*)?(?:\{\s*)?"([^"]*)"/.exec(args)?.[1] ?? "";
      const method = mm[2] === "Request" ? (/method\s*=\s*(?:RequestMethod\.)?(\w+)/.exec(args)?.[1] ?? "ANY") : mm[2].toUpperCase();
      const sec = springSecurity(mm[1] + " " + mm[4]);
      out.push({ method, path: joinPath(prefix, pth), handler: `${m[2]}.${mm[5]}`, framework: "Spring", file: f.rel, line: lineOf(text, open + 1 + mm.index), guards: [...classSec.guards, ...sec.guards], roles: [...classSec.roles, ...sec.roles], permissions: [...classSec.perms, ...sec.perms], explicitPublic: sec.publicAccess || undefined, feature: f.feature });
    }
  }
}

function springSecurity(annos: string): { guards: string[]; roles: string[]; perms: string[]; publicAccess: boolean } {
  const guards: string[] = []; const roles: string[] = []; const perms: string[] = [];
  let publicAccess = false;
  for (const a of annos.matchAll(/@(PreAuthorize|PostAuthorize|Secured|RolesAllowed|PermitAll|DenyAll|Authenticated|IsAuthenticated)\s*(?:\(([\s\S]*?)\))?/g)) {
    guards.push(`@${a[1]}`);
    if (a[1] === "PermitAll") { publicAccess = true; continue; }
    if (/PreAuthorize|PostAuthorize/.test(a[1])) { const el = parseSpringEl(a[2] ?? ""); roles.push(...el.roles); perms.push(...el.perms); if (el.publicAccess) publicAccess = true; }
    else { roles.push(...stringLiterals(a[2] ?? "").map((s) => s.replace(/^ROLE_/, ""))); }
  }
  return { guards, roles, perms, publicAccess };
}

// ---------- Go (gin / echo / chi / fiber / net/http) ----------
function golang(text: string, f: FileInfo, out: Draft[]) {
  let m: RegExpExecArray | null;
  const groups = new Map<string, { prefix: string; mws: string[] }>();
  const gre = /(\w+)\s*:=\s*(\w+)\.Group\s*\(\s*"([^"]*)"([^)]*)\)/g;
  while ((m = gre.exec(text))) { const parent = groups.get(m[2]); groups.set(m[1], { prefix: joinPath(parent?.prefix ?? "", m[3]), mws: [...(parent?.mws ?? []), ...m[4].split(",").map((s) => s.trim().replace(/\(\)$/, "")).filter(Boolean)] }); }
  const ure = /(\w+)\.Use\s*\(([^)]*)\)/g;
  while ((m = ure.exec(text))) { const g = groups.get(m[1]) ?? { prefix: "", mws: [] }; g.mws.push(...m[2].split(",").map((s) => s.trim().replace(/\(.*\)$/, "")).filter(Boolean)); groups.set(m[1], g); }
  const re = /\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|Handle|HandleFunc|Any|Method)\s*\(\s*(?:"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*)?"([^"]*)"\s*,([^)]*)\)/g;
  while ((m = re.exec(text))) {
    const method = m[3] ?? (/^(Handle|HandleFunc|Any)$/.test(m[2]) ? "ANY" : m[2].toUpperCase());
    const parts = m[5].split(",").map((s) => s.trim()).filter(Boolean);
    const handler = parts[parts.length - 1] ?? "inline";
    const mws = parts.slice(0, -1).map((s) => s.replace(/\(.*\)$/, ""));
    const grp = groups.get(m[1]);
    const guards = [...(grp?.mws ?? []), ...mws].filter((g) => looksLikeAuthGuard(g));
    const roles = [...(grp?.mws ?? []), ...mws, ...parts.slice(0, -1)].flatMap((s) => { const c = /^([\w.]+)\((.*)\)$/.exec(s); return c ? rolesAndPermsFromCall(c[1], c[2]).roles : interpretGuardArg(s).roles; });
    out.push({ method, path: joinPath(grp?.prefix ?? "", m[4]), handler, framework: "Go HTTP", file: f.rel, line: lineOf(text, m.index), guards, roles, permissions: [], feature: f.feature });
  }
}

// ---------- Rails ----------
function rails(index: ProjectIndex, out: Draft[]) {
  const rf = index.files.find((x) => /(^|\/)config\/routes\.rb$/.test(x.rel));
  if (!rf) return;
  const text = readText(rf.abs);
  const lines = text.split("\n");
  const stack: { prefix: string; indent: number }[] = [];
  const ctrlFiles = index.files.filter((x) => /_controller\.rb$/.test(x.rel));
  const ctrlInfo = (name: string) => {
    const cf = ctrlFiles.find((x) => x.rel.endsWith(`/${name}_controller.rb`) || x.rel.endsWith(`${name}_controller.rb`));
    if (!cf) return { guards: [], roles: [], file: rf.rel, feature: rf.feature };
    const t = readText(cf.abs);
    const guards: string[] = [];
    for (const b of t.matchAll(/before_action\s+:(\w+)/g)) if (looksLikeAuthGuard(b[1]) || /authenticate|require|authorize|admin/.test(b[1])) guards.push(b[1]);
    if (/authorize\b|load_and_authorize_resource/.test(t)) guards.push("authorize (policy)");
    const roles = Array.from(t.matchAll(/(?:current_user\.)?(?:admin\?|has_role\?\s*\(?\s*:(\w+)|role\s*==\s*['":](\w+))/g)).map((x) => x[1] ?? x[2] ?? "admin");
    return { guards: uniq(guards), roles: uniq(roles.map(normalizeRole)), file: cf.rel, feature: cf.feature };
  };
  lines.forEach((line, i) => {
    const indent = line.search(/\S|$/);
    while (stack.length && indent <= stack[stack.length - 1].indent && /^\s*end\b/.test(line)) stack.pop();
    const ns = /^\s*(?:namespace|scope)\s+['":]?([\w\/]+)['"]?.*\bdo\b/.exec(line);
    if (ns) { stack.push({ prefix: ns[1], indent }); return; }
    const res = /^\s*resources?\s+:(\w+)(.*)$/.exec(line);
    const prefix = stack.map((s) => s.prefix).join("/");
    if (res) {
      const name = res[1];
      const info = ctrlInfo(name);
      const only = /only:\s*(?:%i)?\[([^\]]*)\]/.exec(res[2])?.[1];
      const except = /except:\s*(?:%i)?\[([^\]]*)\]/.exec(res[2])?.[1];
      const base = joinPath(prefix, name);
      let ops: [string, string, string][] = [["GET", base, "index"], ["POST", base, "create"], ["GET", `${base}/:id`, "show"], ["PATCH", `${base}/:id`, "update"], ["DELETE", `${base}/:id`, "destroy"]];
      const toks = (s: string) => s.replace(/[:\s]/g, " ").split(/\s+/).filter(Boolean);
      if (only) ops = ops.filter((o) => toks(only).includes(o[2]));
      if (except) ops = ops.filter((o) => !toks(except).includes(o[2]));
      for (const [method, p, act] of ops) out.push({ method, path: p, handler: `${name}#${act}`, framework: "Rails", file: info.file, line: i + 1, guards: info.guards, roles: info.roles, permissions: [], feature: info.feature });
      if (/\bdo\s*$/.test(line)) stack.push({ prefix: `${name}/:id`, indent });
      return;
    }
    const verb = /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"](?:.*to:\s*['"](\w+)#(\w+)['"])?/.exec(line);
    if (verb) { const info = verb[3] ? ctrlInfo(verb[3]) : { guards: [], roles: [], file: rf.rel, feature: rf.feature }; out.push({ method: verb[1].toUpperCase(), path: joinPath(prefix, verb[2]), handler: verb[3] ? `${verb[3]}#${verb[4]}` : "inline", framework: "Rails", file: info.file, line: i + 1, guards: info.guards, roles: info.roles, permissions: [], feature: info.feature }); }
  });
}

// ---------- GraphQL SDL operations ----------
function graphqlOps(text: string, f: FileInfo, out: Draft[]) {
  for (const t of ["Query", "Mutation", "Subscription"]) {
    const re = new RegExp(`(?:^|\\n)\\s*(?:extend\\s+)?type\\s+${t}\\s*\\{`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const b = bracketBody(text, m.index + m[0].length - 1);
      if (!b) continue;
      for (const line of b.body.split("\n")) {
        const fm = /^\s*(\w+)\s*(?:\([^)]*\))?\s*:\s*[\w!\[\]]+\s*((?:@\w+(?:\([^)]*\))?\s*)*)/.exec(line);
        if (!fm || line.trim().startsWith("#")) continue;
        const dirs = fm[2] ?? "";
        const guards: string[] = []; const roles: string[] = []; const perms: string[] = [];
        for (const d of dirs.matchAll(/@(\w+)(?:\(([^)]*)\))?/g)) { if (looksLikeAuthGuard(d[1]) || /auth|role|permission|hasRole|isAuthenticated|requires/i.test(d[1])) { guards.push(`@${d[1]}`); const rp = rolesAndPermsFromCall(d[1], d[2] ?? ""); roles.push(...rp.roles, ...Array.from((d[2] ?? "").matchAll(/requires\s*:\s*\[?([A-Z_,\s]+)\]?/g)).flatMap((x) => x[1].split(",").map((s) => normalizeRole(s)))); perms.push(...rp.perms); } }
        out.push({ method: t === "Query" ? "QUERY" : t === "Mutation" ? "MUTATION" : "SUBSCRIPTION", path: `/graphql/${fm[1]}`, handler: fm[1], framework: "GraphQL SDL", file: f.rel, line: lineOf(text, m.index), guards, roles, permissions: perms, feature: f.feature });
      }
    }
  }
}

// ---------- tRPC ----------
function trpc(text: string, f: FileInfo, out: Draft[]) {
  if (!/(publicProcedure|protectedProcedure|adminProcedure|\w+Procedure)\s*[\n\s.]*\.(query|mutation|subscription)/.test(text)) return;
  const re = /(\w+)\s*:\s*(\w*[pP]rocedure)([\s\S]*?)\.(query|mutation|subscription)\s*\(/g;
  let m: RegExpExecArray | null;
  const routerName = /(?:const|export const)\s+(\w+)\s*=\s*(?:\w+\.)?(?:router|createTRPCRouter|createRouter)\s*\(/.exec(text)?.[1] ?? f.rel.split("/").pop()!.replace(/\.\w+$/, "");
  while ((m = re.exec(text))) {
    const proc = m[2];
    const chain = m[3];
    const guards: string[] = []; const roles: string[] = [];
    if (!/^publicProcedure$/.test(proc)) guards.push(proc);
    const rm = /^(\w+?)Procedure$/.exec(proc);
    if (rm && !/^(public|protected|private|authed|auth|base|t)$/i.test(rm[1])) roles.push(rm[1]);
    for (const u of chain.matchAll(/\.use\s*\(\s*([\w.]+)(?:\(([^)]*)\))?/g)) { guards.push(u[1]); const rp = rolesAndPermsFromCall(u[1], u[2] ?? ""); roles.push(...rp.roles); }
    out.push({ method: m[4] === "query" ? "QUERY" : "MUTATION", path: `/trpc/${routerName.replace(/Router$/, "")}.${m[1]}`, handler: m[1], framework: "tRPC", file: f.rel, line: lineOf(text, m.index), guards, roles, permissions: [], explicitPublic: proc === "publicProcedure" ? true : undefined, feature: f.feature });
  }
}

// ---------- ASP.NET Core ----------
function aspnet(text: string, f: FileInfo, out: Draft[]) {
  if (!/\[(ApiController|Route|Http(Get|Post|Put|Patch|Delete))/.test(text)) return;
  const classRe = /((?:\[[^\]]*\]\s*)*)public\s+(?:sealed\s+|abstract\s+)?class\s+(\w+)\s*:\s*\w*Controller\w*/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(text))) {
    const attrs = m[1];
    const prefix = (/\[Route\s*\(\s*"([^"]*)"/.exec(attrs)?.[1] ?? "").replace(/\[controller\]/g, m[2].replace(/Controller$/, "").toLowerCase());
    const classAuth = aspAuth(attrs);
    const open = text.indexOf("{", m.index + m[0].length);
    const end = matchBracket(text, open);
    if (end === -1) continue;
    const body = text.slice(open + 1, end);
    const mre = /((?:\[[^\]]*\]\s*)*)\[Http(Get|Post|Put|Patch|Delete)\s*(?:\(\s*"([^"]*)"\s*\))?\]((?:\s*\[[^\]]*\])*)\s*public\s+(?:async\s+)?[\w<>\[\],?\s]+?\s+(\w+)\s*\(/g;
    let mm: RegExpExecArray | null;
    while ((mm = mre.exec(body))) {
      const a = aspAuth(mm[1] + mm[4]);
      const pth = (mm[3] ?? /\[Route\s*\(\s*"([^"]*)"/.exec(mm[1] + mm[4])?.[1] ?? "").replace(/\[action\]/g, mm[5].toLowerCase());
      out.push({ method: mm[2].toUpperCase(), path: joinPath(prefix, pth), handler: `${m[2]}.${mm[5]}`, framework: "ASP.NET Core", file: f.rel, line: lineOf(text, open + 1 + mm.index), guards: [...classAuth.guards, ...a.guards], roles: [...classAuth.roles, ...a.roles], permissions: [...classAuth.perms, ...a.perms], explicitPublic: a.anonymous || undefined, feature: f.feature });
    }
  }
}

function aspAuth(attrs: string): { guards: string[]; roles: string[]; perms: string[]; anonymous: boolean } {
  const guards: string[] = []; const roles: string[] = []; const perms: string[] = [];
  let anonymous = false;
  for (const a of attrs.matchAll(/\[(Authorize|AllowAnonymous)(?:\s*\(([^)]*)\))?\]/g)) {
    if (a[1] === "AllowAnonymous") { anonymous = true; continue; }
    guards.push("[Authorize]");
    const r = /Roles\s*=\s*"([^"]*)"/.exec(a[2] ?? "");
    if (r) roles.push(...r[1].split(",").map((s) => s.trim()));
    const p = /Policy\s*=\s*"([^"]*)"/.exec(a[2] ?? "");
    if (p) perms.push(p[1]);
  }
  return { guards, roles, perms, anonymous };
}

export function extractEndpoints(index: ProjectIndex): Endpoint[] {
  const drafts: Draft[] = [];
  const fastapiPrefixes = fastapiIncludes(index);
  const pyDefs = index.files.some((f) => f.lang === "Python") ? collectPythonDefs(index) : new Map<string, PyDef[]>();
  for (const f of sourceFiles(index)) {
    const text = readText(f.abs);
    if (!text) continue;
    switch (f.lang) {
      case "TypeScript":
      case "JavaScript": {
        if (/@(Controller|Resolver)\s*\(/.test(text)) nest(text, f, drafts);
        else if (/(^|\/)(app|pages)\//.test(f.rel) && /route\.\w+$|pages\/api\//.test(f.rel)) nextjs(text, f, drafts);
        else if (/Procedure/.test(text) && /\.(query|mutation)\s*\(/.test(text)) trpc(text, f, drafts);
        if (!f.isFrontend && /\.(get|post|put|patch|delete|del|all|route)\s*\(/.test(text) && !/@Controller/.test(text)) expressLike(text, f, index, drafts);
        break;
      }
      case "Python":
        if (/APIRouter|FastAPI\(|@app\.(get|post|put|patch|delete)/.test(text)) fastapi(text, f, drafts, fastapiPrefixes, pyDefs);
        if (/Blueprint\(|Flask\(|@\w+\.route\s*\(/.test(text) && !/APIRouter|FastAPI\(/.test(text)) flask(text, f, drafts);
        break;
      case "PHP": laravel(text, f, drafts); break;
      case "Java":
      case "Kotlin": spring(text, f, drafts); break;
      case "Go": golang(text, f, drafts); break;
      case "C#": aspnet(text, f, drafts); break;
      case "GraphQL": graphqlOps(text, f, drafts); break;
    }
  }
  django(index, drafts);
  rails(index, drafts);
  applyMounts(index, drafts);
  const endpoints = drafts.map(finalize);
  return uniqBy(endpoints, (e) => `${e.method} ${e.path} ${e.source.file}:${e.source.line}`).sort((a, b) => a.feature.localeCompare(b.feature) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function endpointKey(e: Endpoint): string {
  return `${e.method} ${e.path}`;
}

export { path as _path };

// ---------- Python dependency-chain resolution (FastAPI) ----------
export interface PyDef { sig: string; body: string }

/** Map of python function name -> its signature + own indented body, across the whole project. */
export function collectPythonDefs(index: ProjectIndex): Map<string, PyDef[]> {
  const defs = new Map<string, PyDef[]>();
  for (const f of sourceFiles(index, ["Python"])) {
    const text = readText(f.abs);
    if (!text) continue;
    const re = /^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const b = bracketBody(text, m.index + m[0].length - 1);
      if (!b) continue;
      const indent = m[1].length;
      const nl = text.indexOf("\n", b.end);
      const lines = nl === -1 ? [] : text.slice(nl + 1).split("\n");
      const bodyLines: string[] = [];
      for (const l of lines) {
        if (l.trim() === "") { bodyLines.push(l); continue; }
        const ind = l.search(/\S|$/);
        if (ind <= indent) break;
        bodyLines.push(l);
        if (bodyLines.length > 80) break;
      }
      const arr = defs.get(m[2]) ?? [];
      arr.push({ sig: b.body, body: bodyLines.join("\n").slice(0, 4000) });
      defs.set(m[2], arr);
    }
  }
  return defs;
}

const ROLE_GUARD_NAME_RE = /^(require|requires|ensure|check|verify|assert|only|allow|restrict|need|needs|must|has_|is_|admin|superadmin|teacher|student|manager|owner|staff|current_admin|get_current_(?!user$|active_user$))/i;

/** Expand guard names through their own Depends(...) chains and infer roles from names. */
export function expandPythonGuards(guards: string[], defs: Map<string, PyDef[]>): { guards: string[]; roles: string[]; perms: string[] } {
  const outGuards: string[] = [];
  const roles: string[] = [];
  const perms: string[] = [];
  const seen = new Set<string>();
  const visit = (g: string, depth: number) => {
    const call = /^([\w.]+)\((.*)\)$/s.exec(g.trim());
    const name = (call?.[1] ?? g.trim()).split(".").pop()!;
    if (!name || seen.has(name)) return;
    seen.add(name);
    if (NOT_GUARD_RE.test(name)) return; // service/repository factories never carry auth
    if (call) { const rp = rolesAndPermsFromCall(name, call[2]); roles.push(...rp.roles); perms.push(...rp.perms); }
    const inferred = roleFromGuardName(name);
    if (inferred.length || looksLikeAuthGuard(name)) { outGuards.push(name); roles.push(...inferred); }
    if (depth >= 4) return;
    const isRoleGuard = ROLE_GUARD_NAME_RE.test(name) || inferred.length > 0;
    for (const d of defs.get(name) ?? []) {
      for (const inner of depsToGuards(d.sig)) visit(inner, depth + 1);
      if (!isRoleGuard) continue;
      // factories: def require_roles(*roles): def dep(user=Depends(get_current_user)) ... ; direct checks: if user.role != UserRole.ADMIN
      for (const inner of depsToGuards(d.body)) visit(inner, depth + 1);
      for (const rm of d.body.matchAll(/\b(?:require_roles?|has_roles?|check_roles?|allowed_roles)\s*\(([^)]*)\)/g)) { const rp = rolesAndPermsFromCall("roles", rm[1]); roles.push(...rp.roles); }
      for (const rm of d.body.matchAll(/\.role\s*(?:!=|==|not in|in)\s*[\(\[\{]?\s*((?:[A-Z]\w*(?:Role|Roles|Type)\w*\.\w+|['"]\w+['"])(?:\s*,\s*(?:[A-Z]\w*(?:Role|Roles|Type)\w*\.\w+|['"]\w+['"]))*)/g)) { const rp = rolesAndPermsFromCall("roles", rm[1]); roles.push(...rp.roles); }
    }
  };
  for (const g of guards) visit(g, 0);
  return { guards: uniq(outGuards), roles: uniq(roles.map(normalizeRole).filter(Boolean)), perms: uniq(perms) };
}
