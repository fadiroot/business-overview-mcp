import type { AccessCheck, AccessLevel, AccessModel, Endpoint, GuardDef, MatrixRow, PathRule, PermissionDef, ProjectIndex, RoleDef, SourceRef } from "../types.js";
import { readText, sourceFiles } from "../indexer.js";
import { bracketBody, enumRefs, isInfraEndpointPath, lineOf, normalizeRole, parseSpringEl, snippetAt, splitTopLevel, stringLiterals, uniq, uniqBy } from "../util.js";

/** A trailing noun means the constant names a thing, not an actor: SIGNING_REQUEST, RECIPIENT_ROLE, USER_STATUS. */
const NOT_ROLE_SUFFIX_RE = /_(request|requests|response|event|events|type|types|status|state|reason|template|templates|email|emails|message|messages|action|actions|step|steps|mode|level|kind|category|label|title|key|id|url|path|code|config|setting|settings|option|options|value|values|flag|count|list|map|set|role|roles|permission|permissions)$/i;

/** Verbs that mark a capability rather than an actor, e.g. MANAGE_BILLING, delete_team, approve_request. */
const ACTION_VERB_RE = /^(approve|reject|delete|remove|manage|create|update|edit|add|view|read|write|list|invite|export|import|send|resend|sign|share|assign|unassign|revoke|grant|transfer|download|upload|publish|archive|restore|cancel|enable|disable|configure|move|copy|duplicate|search|filter|print|notify|schedule|execute|deploy|activate|deactivate|reset|change|modify|access|use)[_\- ]/i;

/** Top-level keys of an object literal body: ADMIN:, 'admin':, [Role.ADMIN]: */
function topLevelKeys(body: string): string[] {
  const out: string[] = [];
  for (const part of splitTopLevel(body)) {
    const p = part.replace(/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*/g, "").trim();
    if (!p) continue;
    const km = /^\[\s*[\w.]*?([A-Za-z_]\w*)\s*\]\s*:/.exec(p) ?? /^['"`]([^'"`]+)['"`]\s*:/.exec(p) ?? /^([A-Za-z_]\w*)\s*:/.exec(p);
    if (km) out.push(km[1]);
  }
  return out;
}

/** Top-level entries of an array literal body: string literals and enum references, never nested objects. */
function topLevelEntries(body: string): string[] {
  const out: string[] = [];
  for (const part of splitTopLevel(body)) {
    const p = part.trim();
    if (!p || p.startsWith("{") || p.startsWith("[")) continue;
    const lit = /^['"`]([^'"`]+)['"`]$/.exec(p);
    if (lit) { out.push(lit[1]); continue; }
    const er = /^[\w.]*?([A-Za-z_]\w*)$/.exec(p);
    if (er && /\.|::/.test(p)) out.push(er[1]);
  }
  return out;
}

/** Key/value pairs of a flat object: { ADMIN: "admin" } -> ["ADMIN", "admin"]. Nested objects are skipped. */
function topLevelPairs(body: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of splitTopLevel(body)) {
    const p = part.trim();
    const kv = /^(?:\[\s*[\w.]*?([A-Za-z_]\w*)\s*\]|['"`]([^'"`]+)['"`]|([A-Za-z_]\w*))\s*:\s*['"`]([^'"`]+)['"`]$/.exec(p);
    if (kv) out.push([kv[1] ?? kv[2] ?? kv[3], kv[4]]);
  }
  return out;
}

/** Keys of a configuration object ({ label, type, options }) never name an actor. */
const CONFIG_KEY_RE = /^(label|labels|type|types|options|option|value|values|name|names|key|keys|id|title|description|placeholder|icon|icons|color|colors|order|index|default|defaults|enabled|disabled|visible|hidden|required|optional|component|components|variant|variants|size|width|height|className|class|style|styles|children|props|text|message|messages|content|href|url|path|route|action|actions|handler|render|format|locale|translation|translations|context|meta|data|items|list|fields|columns|rows|headers|footer|header|body|layout|theme|config|settings|params|query|method|status|state|step|steps|mode|level|kind|category|group|tag|tags|slug|image|src|alt|width|position|align|variantProps)$/i;

/** A key shaped like an enum member (ADMIN, Approver) or a recognised actor word can name a role. */
function looksLikeRoleKey(k: string): boolean {
  if (CONFIG_KEY_RE.test(k)) return false;
  return /^[A-Z][A-Z0-9_]*$/.test(k) || /^[A-Z][a-zA-Z0-9]*$/.test(k) || ROLE_WORDS.test(k.replace(/[\s-]+/g, "_"));
}

const ROLE_WORDS = /^(admin|administrator|super_?admin|superuser|root|owner|manager|staff|editor|moderator|author|contributor|viewer|reader|user|member|customer|client|guest|anonymous|teacher|student|parent|instructor|learner|vendor|seller|buyer|merchant|supplier|partner|agent|support|operator|employee|hr|finance|accountant|sales|marketing|developer|dev|tester|qa|analyst|auditor|reviewer|approver|supervisor|director|executive|ceo|cto|doctor|nurse|patient|driver|rider|courier|dispatcher|host|tenant|landlord|company_?admin|org_?admin|workspace_?admin|team_?admin|team_?member|billing_?admin|read_?only|readonly|premium|pro|free|basic|enterprise|subscriber|trial|coach|player|referee|organizer|attendee|speaker|volunteer|donor|beneficiary|candidate|recruiter|interviewer|maintainer|collaborator|internal|external|system|service|bot|api_?client)$/i;

function addRole(map: Map<string, RoleDef>, raw: string, kind: RoleDef["kind"], src: SourceRef) {
  const name = normalizeRole(raw);
  if (!name || name.length < 2 || name.length > 40 || /^\d+$/.test(name)) return;
  if (name.split("_").length > 2) return;             // sentences and slugs, not actor names
  if (/\d/.test(name) && !/^v\d$/.test(name)) return;  // CSS utilities such as h-4 w-4
  if (ACTION_VERB_RE.test(name)) return;              // capability, recorded as a permission instead
  if (NOT_ROLE_SUFFIX_RE.test(name)) return;          // SIGNING_REQUEST, RECIPIENT_ROLE: a thing, not an actor
  if (/^(true|false|null|undefined|none|id|name|type|string|number|default|all|any|self|this|role|roles|user_role|userrole|value|key|label|test|foo|bar|role_id|roleid|none_?)$/i.test(name)) return;
  const cur = map.get(name) ?? { name, raw: [], sources: [], kind };
  if (!cur.raw.includes(raw)) cur.raw.push(raw);
  if (cur.sources.length < 20) cur.sources.push(src);
  if (kind === "enum" || kind === "config") cur.kind = kind;
  map.set(name, cur);
}

function addPerm(map: Map<string, PermissionDef>, raw: string, src: SourceRef) {
  const name = raw.trim();
  if (!name || name.length < 3 || name.length > 60 || /\s{2,}|[{}<>]/.test(name)) return;
  const cur = map.get(name) ?? { name, sources: [] };
  if (cur.sources.length < 20) cur.sources.push(src);
  map.set(name, cur);
}

export function extractAccessModel(index: ProjectIndex, endpoints: Endpoint[]): AccessModel {
  const roles = new Map<string, RoleDef>();
  const perms = new Map<string, PermissionDef>();
  const guards: GuardDef[] = [];
  const pathRules: PathRule[] = [];
  const checks: AccessCheck[] = [];
  const frontendChecks: AccessCheck[] = [];

  const pushCheck = (arr: AccessCheck[], kind: string, rs: string[], ps: string[], text: string, idx: number, file: string, feature: string, layer: AccessCheck["layer"]) => {
    const src = { file, line: lineOf(text, idx) };
    arr.push({ kind, roles: uniq(rs.map(normalizeRole).filter(Boolean)), permissions: uniq(ps), source: src, snippet: snippetAt(text, idx), feature, layer });
    for (const r of rs) addRole(roles, r, "usage", src);
    for (const p of ps) addPerm(perms, p, src);
  };

  for (const f of sourceFiles(index, undefined, false)) {
    const text = readText(f.abs);
    if (!text) continue;
    const file = f.rel;
    const feat = f.feature;
    const layer: AccessCheck["layer"] = f.isFrontend ? "frontend" : f.lang === "Config" ? "config" : "backend";
    const target = f.isFrontend ? frontendChecks : checks;
    let m: RegExpExecArray | null;

    // --- Role enums / constants (any language) ---
    const enumRe = /\b(?:export\s+)?(?:const\s+)?enum\s+(\w*(?:Role|Roles|UserType|AccountType|UserRole|MemberType|Permission|Permissions|Scope|Ability|Abilities|Action|Actions)\w*)\s*(?::\s*\w+\s*)?\{/g;
    while ((m = enumRe.exec(text))) {
      const b = bracketBody(text, m.index + m[0].length - 1);
      if (!b) continue;
      const isPerm = /Permission|Scope|Ability|Abilities|Action/.test(m[1]) && !/Role/.test(m[1]);
      const src = { file, line: lineOf(text, m.index) };
      for (const part of b.body.split(/[,;\n]/)) {
        const em = /^\s*(?:case\s+)?([A-Za-z_]\w*)\s*(?:=\s*(['"]?)([^'"\n]*)\2)?\s*$/.exec(part.replace(/\/\/.*$/, "").trim());
        if (!em) continue;
        const val = em[3]?.trim() || em[1];
        if (isPerm) addPerm(perms, val, src); else addRole(roles, val, "enum", src);
      }
    }
    // Python Enum
    const pyEnum = /^class\s+(\w*(?:Role|Roles|UserType|Permission|Permissions|Scope)\w*)\s*\((?:str\s*,\s*)?(?:enum\.)?(?:Enum|StrEnum|IntEnum|TextChoices|Choices)\)\s*:\s*\n((?:[ \t]+.*\n?)+)/gm;
    while ((m = pyEnum.exec(text))) {
      const isPerm = /Permission|Scope/.test(m[1]) && !/Role/.test(m[1]);
      const src = { file, line: lineOf(text, m.index) };
      for (const line of m[2].split("\n")) { const em = /^\s+([A-Z_][A-Z0-9_]*)\s*=\s*(?:\(\s*)?['"]([^'"]+)['"]/.exec(line) ?? /^\s+([A-Z_][A-Z0-9_]*)\s*=\s*(\w+)/.exec(line); if (em) { if (isPerm) addPerm(perms, em[2], src); else addRole(roles, /^\d+$/.test(em[2]) ? em[1] : em[2], "enum", src); } }
    }
    // Django ROLE_CHOICES / choices tuples
    const choices = /(\w*ROLE\w*|\w*Role\w*)(?:_CHOICES)?\s*=\s*[\[(]\s*((?:\(\s*['"][^'"]+['"]\s*,\s*[^)]*\)\s*,?\s*)+)[\])]/g;
    while ((m = choices.exec(text))) { const src = { file, line: lineOf(text, m.index) }; for (const c of m[2].matchAll(/\(\s*['"]([^'"]+)['"]/g)) addRole(roles, c[1], "constant", src); }
    // Role / permission constants. Only the STRUCTURE of the declaration is trusted: top-level keys of an
    // object, or top-level entries of an array. Nested objects are UI label maps ({ APPROVER: { roleName: "Approver",
    // progressiveVerb: "Approving" } }) and must never become roles.
    const declRe = /\b(?:export\s+)?(?:const|let|var|static|final|readonly|public const|private const)\s+(?:readonly\s+)?(\w+)\s*(?::\s*[^=]+?)?\s*=\s*(\[|\{)/g;
    while ((m = declRe.exec(text))) {
      const declName = m[1];
      const isPermDecl = /PERMISSION|ABILIT|SCOPE|CAPABILIT|GRANT|POLICY|POLICIES/i.test(declName);
      const isRoleDecl = /ROLES?|USER_?TYPES?|ACCOUNT_?TYPES?|MEMBER_?TYPES?|USER_?KINDS?/i.test(declName);
      if (!isPermDecl && !isRoleDecl) continue;
      const b = bracketBody(text, m.index + m[0].length - 1);
      if (!b || b.body.length > 20000) continue;
      const src = { file, line: lineOf(text, m.index) };
      const isObject = m[2] === "{";
      const entries = isObject ? topLevelKeys(b.body) : topLevelEntries(b.body);
      // A permission map keyed by capability (DELETE_TEAM: [Role.ADMIN]) yields permissions from its keys
      // and roles from the enum references in its values.
      if (isPermDecl) {
        for (const e of entries) if (!CONFIG_KEY_RE.test(e)) addPerm(perms, e, src);
        if (!f.isFrontend) for (const r of enumRefs(b.body)) addRole(roles, r, "constant", src);
        continue;
      }
      for (const e of entries) {
        if (ACTION_VERB_RE.test(e)) addPerm(perms, e, src); // MANAGE_BILLING inside a *_ROLE_* map is a capability
        else if (looksLikeRoleKey(e)) addRole(roles, e, "constant", src);
      }
      // A flat map ({ ADMIN: "admin" }) also carries the wire value, but only next to its own key.
      if (isObject) for (const [k, v] of topLevelPairs(b.body)) {
        if (!looksLikeRoleKey(k) || ACTION_VERB_RE.test(v)) continue;
        if (normalizeRole(k) === normalizeRole(v) || ROLE_WORDS.test(normalizeRole(v))) addRole(roles, v, "constant", src);
      }
    }
    // Spatie / Laravel seeders: Role::create(['name' => 'admin']) / Permission::create
    for (const mm of text.matchAll(/(Role|Permission)::(?:create|firstOrCreate|findOrCreate|findByName)\s*\(\s*\[?\s*(?:'name'\s*=>\s*)?['"]([^'"]+)['"]/g)) { const src = { file, line: lineOf(text, mm.index!) }; if (mm[1] === "Role") addRole(roles, mm[2], "config", src); else addPerm(perms, mm[2], src); }
    // Casbin policy csv / rbac yaml/json
    if (/\.csv$/.test(file) && /^p,\s*/m.test(text)) for (const mm of text.matchAll(/^p,\s*([\w:]+),\s*([^,]+),\s*([^,\n]+)/gm)) { const src = { file, line: lineOf(text, mm.index!) }; addRole(roles, mm[1], "config", src); pushCheck(checks, "casbin:policy", [mm[1]], [`${mm[2].trim()}:${mm[3].trim()}`], text, mm.index!, file, feat, "config"); }
    if (f.lang === "Config" && /roles?|permissions?/i.test(file)) {
      for (const mm of text.matchAll(/"?(roles?|permissions?)"?\s*:\s*\[([^\]]*)\]/gi)) { const src = { file, line: lineOf(text, mm.index!) }; for (const l of stringLiterals(mm[2])) { if (/role/i.test(mm[1])) addRole(roles, l, "config", src); else addPerm(perms, l, src); } }
    }

    // --- Guard / policy definitions ---
    for (const mm of text.matchAll(/class\s+(\w+)\s+(?:implements\s+CanActivate|extends\s+(?:AuthGuard|BasePermission|Policy|BasePolicy|Guard|PassportStrategy)|\(BasePermission\))/g)) guards.push({ name: mm[1], kind: "guard-class", source: { file, line: lineOf(text, mm.index!) } });
    for (const mm of text.matchAll(/class\s+(\w+Policy)\b/g)) guards.push({ name: mm[1], kind: "policy", source: { file, line: lineOf(text, mm.index!) } });
    for (const mm of text.matchAll(/(?:export\s+)?(?:async\s+)?(?:function|const|def|func)\s+((?:require|ensure|verify|check|is|has|can|authorize|authenticate|protect|restrict|allow|only|must|guard|assert)\w*(?:Auth|Role|Roles|Permission|Permissions|Admin|Owner|Login|Logged|Token|Jwt|User|Access|Scope|Ability|Policy|Authenticated|Authorized)\w*|authenticate|authorize|is_admin|is_owner|require_role|require_permission|has_permission|has_role|get_current_user|get_current_active_user|current_user|login_required|admin_required|roles_required|permission_required|role_required|auth_required|jwt_required)\b\s*(?:=\s*)?(?:\(|<)/gi)) guards.push({ name: mm[1], kind: "guard-function", source: { file, line: lineOf(text, mm.index!) } });
    if (/(^|\/)(middleware|middlewares|guards|policies|auth)\//i.test(file) && !f.isFrontend) for (const mm of text.matchAll(/(?:export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)\s*=|class\s+(\w+)\s*(?:\{|implements|extends))/g)) { const n = mm[1] ?? mm[2] ?? mm[3]; if (n && !guards.some((g) => g.name === n) && /auth|role|perm|guard|policy|admin|owner|access|verify|protect|can|ability|scope|token|jwt|session|login/i.test(n + file)) guards.push({ name: n, kind: "middleware", source: { file, line: lineOf(text, mm.index!) } }); }

    // --- Path rules ---
    // Spring: .requestMatchers("/admin/**").hasRole("ADMIN")  / antMatchers
    for (const mm of text.matchAll(/\.(?:requestMatchers|antMatchers|mvcMatchers|pathMatchers|securityMatcher)\s*\(([^)]*)\)\s*\.(hasRole|hasAnyRole|hasAuthority|hasAnyAuthority|authenticated|permitAll|denyAll|access)\s*\(([^)]*)\)/g)) {
      const patterns = stringLiterals(mm[1]).filter((s) => s.startsWith("/"));
      const src = { file, line: lineOf(text, mm.index!) };
      const el = mm[2] === "access" ? parseSpringEl(mm[3]) : { roles: /Role/.test(mm[2]) ? stringLiterals(mm[3]).map((s) => normalizeRole(s.replace(/^ROLE_/, ""))) : [], perms: /Authority/.test(mm[2]) ? stringLiterals(mm[3]) : [], authenticated: mm[2] === "authenticated", publicAccess: mm[2] === "permitAll" };
      for (const p of patterns) pathRules.push({ pattern: p, roles: el.roles, permissions: el.perms, effect: mm[2] === "denyAll" ? "deny" : el.publicAccess ? "public" : el.roles.length || el.perms.length ? "allow" : "authenticated", source: src });
      for (const r of el.roles) addRole(roles, r, "usage", src);
      for (const p of el.perms) addPerm(perms, p, src);
    }
    // Express: app.use('/admin', requireRole('admin')) / router.use('/x', auth)
    for (const mm of text.matchAll(/\b\w+\.use\s*\(\s*['"`](\/[^'"`]*)['"`]\s*,\s*((?:[\w.]+(?:\([^)]*\))?\s*,?\s*)+)\)/g)) {
      const src = { file, line: lineOf(text, mm.index!) };
      const parts = mm[2].split(",").map((s) => s.trim()).filter(Boolean);
      const rs: string[] = []; const ps: string[] = []; let auth = false;
      for (const p of parts) { const c = /^([\w.]+)\((.*)\)$/.exec(p); const name = (c?.[1] ?? p).split(".").pop()!; if (/role|admin|authorize|permit|allow|restrict|only/i.test(name)) { rs.push(...stringLiterals(c?.[2] ?? "").map(normalizeRole), ...enumRefs(c?.[2] ?? "").map(normalizeRole)); if (/admin/i.test(name) && !rs.length) rs.push("admin"); auth = true; } else if (/perm|can|ability|scope/i.test(name)) { ps.push(...stringLiterals(c?.[2] ?? "")); auth = true; } else if (/auth|jwt|passport|protect|session|token|verify|login/i.test(name)) auth = true; }
      if (auth) pathRules.push({ pattern: mm[1].replace(/\/$/, "") + "/**", roles: uniq(rs.filter(Boolean)), permissions: uniq(ps), effect: rs.length || ps.length ? "allow" : "authenticated", source: src });
      for (const r of rs) addRole(roles, r, "usage", src);
    }
    // Next.js middleware matcher
    if (/(^|\/)middleware\.(ts|js)$/.test(file)) {
      const matcher = /matcher\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/.exec(text);
      const pats = matcher ? stringLiterals(matcher[1]) : [];
      const src = { file, line: matcher ? lineOf(text, matcher.index) : 1 };
      const rs = uniq(Array.from(text.matchAll(/role\w*\s*(?:===|==|!==|!=|\.includes\()\s*['"](\w+)['"]/g)).map((x) => normalizeRole(x[1])));
      for (const p of pats) pathRules.push({ pattern: p, roles: rs, permissions: [], effect: rs.length ? "allow" : "authenticated", source: src });
      for (const r of rs) addRole(roles, r, "usage", src);
    }
    // Angular route guards / Vue route meta
    for (const mm of text.matchAll(/path\s*:\s*['"]([^'"]*)['"][\s\S]{0,400}?(?:canActivate\s*:\s*\[([^\]]*)\]|meta\s*:\s*\{([^}]*)\})/g)) {
      const src = { file, line: lineOf(text, mm.index!) };
      const inner = mm[2] ?? mm[3] ?? "";
      const rs = stringLiterals(/roles?\s*:\s*\[([^\]]*)\]/.exec(inner)?.[1] ?? "").map(normalizeRole);
      const auth = /Guard|requiresAuth|auth\s*:\s*true|requireAuth/.test(inner);
      if (auth || rs.length) { frontendChecks.push({ kind: "frontend:route-guard", roles: rs, permissions: [], source: src, snippet: snippetAt(text, mm.index!), feature: feat, layer: "frontend" }); for (const r of rs) addRole(roles, r, "usage", src); }
    }

    // --- Inline checks ---
    const patterns: [RegExp, string, (m: RegExpExecArray) => { rs: string[]; ps: string[] }][] = [
      [/@(Roles|HasRoles|RolesAllowed|AllowRoles|RequireRoles|RequireRole|Authorize|Secured|roles_required|role_required|require_role)\s*\(([^)]*)\)/g, "decorator:roles", (mm) => ({ rs: [...stringLiterals(mm[2]).map((s) => s.replace(/^ROLE_/, "")), ...enumRefs(mm[2])], ps: [] })],
      [/@(Permissions|RequirePermissions|RequirePermission|HasPermission|CheckPolicies|CheckAbilities|permission_required|PreAuthorize|PostAuthorize|Scopes)\s*\(([^)]*)\)/g, "decorator:permissions", (mm) => { if (/PreAuthorize|PostAuthorize/.test(mm[1])) { const el = parseSpringEl(mm[2]); return { rs: el.roles, ps: el.perms }; } return { rs: [], ps: [...stringLiterals(mm[2]), ...enumRefs(mm[2])] }; }],
      [/\b(?:hasRole|has_role|hasAnyRole|isRole|is_role|requireRole|require_role|assertRole|checkRole|withRole|restrictTo|allowRoles|authorizeRoles|onlyRoles|roleIs|role_is|hasRoles|has_any_role|hasAllRoles|hasExactRoles)\s*\(([^)]*)\)/g, "call:role-check", (mm) => ({ rs: [...stringLiterals(mm[1]).map((s) => s.replace(/^ROLE_/, "")), ...enumRefs(mm[1])], ps: [] })],
      [/\b(?:hasPermission|has_permission|hasPermissions|checkPermission|check_permission|requirePermission|require_permission|hasAuthority|hasAnyAuthority|can|cannot|authorize|Gate::allows|Gate::denies|Gate::authorize|\$this->authorize|ability\.can|abilities\.can|user\.can|policy\.can|isAllowed|is_allowed|allowed|enforce|enforcer\.Enforce|permit|checkAbility|hasScope|has_scope|requireScope)\s*\(\s*(['"`][^'"`]+['"`](?:\s*,\s*['"`]?\w+['"`]?)?)/g, "call:permission-check", (mm) => ({ rs: [], ps: [stringLiterals(mm[1]).join(":")] })],
      [/(?:\b(?:user|currentUser|current_user|req\.user|request\.user|session\.user|ctx\.user|auth\.user|\$user|member|account|profile|claims|token|payload|me|actor|this\.user)\??\.)(?:role|roles|userRole|user_role|userType|user_type|accountType|memberType)\s*(?:===|==|!==|!=|\.includes\(|\.has\(|\.contains\(|\bin\b|\.some\(|<>|\.equals\()\s*\(?\s*(['"`](\w+)['"`]|[A-Z]\w*(?:Role|Roles|Type|Types)\w*(?:\.|::)(\w+)|\[([^\]]*)\])/g, "compare:role", (mm) => ({ rs: mm[2] ? [mm[2]] : mm[3] ? [mm[3]] : stringLiterals(mm[4] ?? ""), ps: [] })],
      [/(?:['"`](\w+)['"`]|[A-Z]\w*(?:Role|Roles)\w*(?:\.|::)(\w+))\s*(?:===|==|!==|!=)\s*(?:\w+\??\.)+(?:role|roles|userRole|user_role|type|userType)\b/g, "compare:role", (mm) => ({ rs: [mm[1] ?? mm[2]], ps: [] })],
      [/\b(?:role|roles|userRole|user_role|user_roles|userRoles|currentRole|current_role|memberRole|member_role|myRole)\s*(?:===|==|!==|!=|\.includes\(|\bin\b|\.has\()\s*\(?\s*['"`](\w+)['"`]/g, "compare:role", (mm) => ({ rs: [mm[1]], ps: [] })],
      [/\[\s*(['"`](?:\w+)['"`](?:\s*,\s*['"`]\w+['"`])+)\s*\]\.includes\(\s*(?:\w+\??\.)*(?:role|roles|userRole|user_role|userType|user_type|accountType|memberType)\s*\)/g, "compare:role-list", (mm) => ({ rs: stringLiterals(mm[1]), ps: [] })],
      [/\.(?:isAdmin|is_admin|isSuperAdmin|is_superuser|is_staff|isStaff|isOwner|is_owner|isManager|is_manager|isModerator|is_moderator|isSuperuser|admin\?|owner\?|staff\?|moderator\?|superuser\?)\b(?!\s*=\s*[^=])/g, "flag:role", (mm) => ({ rs: [mm[0].slice(1).replace(/^is_?/i, "").replace(/\?$/, "").toLowerCase() === "superuser" || /superadmin/i.test(mm[0]) ? "superadmin" : mm[0].slice(1).replace(/^is_?/i, "").replace(/\?$/, "")], ps: [] })],
      [/->(?:hasRole|hasAnyRole|hasAllRoles|assignRole)\s*\(([^)]*)\)/g, "laravel:role-check", (mm) => ({ rs: stringLiterals(mm[1]).flatMap((s) => s.split("|")), ps: [] })],
      [/->(?:hasPermissionTo|can|cannot|givePermissionTo|hasAnyPermission|hasAllPermissions|checkPermissionTo)\s*\(\s*['"]([^'"]+)['"]/g, "laravel:permission-check", (mm) => ({ rs: [], ps: [mm[1]] })],
      [/->middleware\s*\(\s*\[?\s*((?:['"][^'"]+['"]\s*,?\s*)+)\]?\s*\)/g, "laravel:middleware", (mm) => { const lits = stringLiterals(mm[1]); return { rs: lits.filter((l) => /^(role|roles|role_or_permission):/i.test(l)).flatMap((l) => l.split(":")[1].split(/[|,]/)), ps: lits.filter((l) => /^(permission|can):/i.test(l)).map((l) => l.split(":").slice(1).join(":")) }; }],
      [/\b(?:@?login_required|@?jwt_required|@?auth_required|before_action\s+:authenticate\w*|authenticate_user!|authenticate_admin!|@?staff_member_required|@?superuser_required|@?admin_required|current_user\.admin\?|Depends\(\s*get_current_(?:active_)?(?:user|admin|superuser)\w*\s*\)|Depends\(\s*(?:require|verify|check)\w*\s*(?:\([^)]*\))?\s*\))/g, "guard:authentication", (mm) => ({ rs: /admin|superuser|staff/i.test(mm[0]) ? ["admin"] : [], ps: [] })],
      [/\b(?:IsAdminUser|IsSuperUser|IsStaffUser|IsAuthenticated|IsAuthenticatedOrReadOnly|DjangoModelPermissions|IsOwner\w*|Is[A-Z]\w+(?:User|Only|OrReadOnly))\b/g, "drf:permission-class", (mm) => ({ rs: /Admin|Super|Staff/.test(mm[0]) ? ["admin"] : (/^Is(\w+?)(?:User|Only|OrReadOnly)$/.exec(mm[0])?.[1] && !/Authenticated|Owner/.test(mm[0]) ? [/^Is(\w+?)(?:User|Only|OrReadOnly)$/.exec(mm[0])![1]] : []), ps: [] })],
      [/\bcan\s*\(\s*['"`](\w+)['"`]\s*,\s*['"`]?(\w+)['"`]?/g, "casl:ability", (mm) => ({ rs: [], ps: [`${mm[2]}:${mm[1]}`] })],
      [/\b(?:defineAbility|AbilityBuilder|defineRulesFor|definePermissionsFor|abilityFor)\b[\s\S]{0,300}?(?:role|type)\s*(?:===|==|case)\s*['"`](\w+)['"`]/g, "casl:role-rules", (mm) => ({ rs: [mm[1]], ps: [] })],
    ];
    for (const [re, kind, fn] of patterns) {
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        const { rs, ps } = fn(m);
        const rsClean = rs.map((r) => r.trim()).filter((r) => r && !/^(true|false|null|undefined|none|id|name|type|value|string)$/i.test(r));
        if (!rsClean.length && !ps.length && !/guard:authentication|drf:permission-class/.test(kind)) continue;
        pushCheck(target, kind, rsClean, ps, text, m.index, file, feat, layer);
      }
    }

    // --- Frontend-only checks (components / templates) ---
    if (f.isFrontend) {
      const fe: [RegExp, string, (m: RegExpExecArray) => string[]][] = [
        [/<(RequireRole|RequireAuth|ProtectedRoute|PrivateRoute|RoleGuard|RoleGate|Can|Authorized|HasRole|HasPermission|Restricted|AdminOnly|AuthGuard|PermissionGuard|Gate|Show|IfRole|IfAdmin|OnlyRole|OnlyAdmin|WithRole|RoleBased\w*|Protected)\b([^>]*)>/g, "frontend:component", (mm) => [...stringLiterals(mm[2]).filter((s) => /^[\w\- ]{2,30}$/.test(s) && !/^(true|false)$/.test(s)), ...(/Admin/.test(mm[1]) ? ["admin"] : [])]],
        [/v-if\s*=\s*"([^"]*(?:role|isAdmin|is_admin|can\(|permission|hasRole|hasPermission|allowed|auth)[^"]*)"/gi, "frontend:vue-directive", (mm) => stringLiterals(mm[1])],
        [/\*ngIf\s*=\s*"([^"]*(?:role|isAdmin|can|permission|hasRole|hasPermission|allowed|auth)[^"]*)"|@if\s*\(([^)]*(?:role|isAdmin|hasRole|hasPermission)[^)]*)\)/gi, "frontend:angular-directive", (mm) => stringLiterals(mm[1] ?? mm[2] ?? "")],
        [/\b(?:useCan|usePermission|usePermissions|useHasRole|useRole|useAuthorization|useAbility|useIsAdmin|useAccess|useGuard)\s*\(([^)]*)\)/g, "frontend:hook", (mm) => stringLiterals(mm[1])],
        [/\{[^{}]*(?:isAdmin|is_admin|hasRole|hasPermission|can\(|role\s*===|role\s*==|userRole|\.role\b)[^{}]*&&[^{}]*</g, "frontend:conditional-render", (mm) => stringLiterals(mm[0])],
        [/(?:x-if|x-show)\s*=\s*"([^"]*(?:role|isAdmin|can|permission)[^"]*)"|@(?:can|role|hasrole|hasanyrole|hasPermission|auth|admin)\s*\(([^)]*)\)/gi, "frontend:blade-directive", (mm) => stringLiterals(mm[1] ?? mm[2] ?? "")],
        [/\{%\s*if\s+([^%]*(?:perms\.|is_staff|is_superuser|role|has_perm|groups)[^%]*)%\}/g, "frontend:django-template", (mm) => [...stringLiterals(mm[1]), ...(/is_staff|is_superuser/.test(mm[1]) ? ["admin"] : [])]],
        [/\b(?:hidden|disabled|readOnly|readonly)\s*=\s*\{[^}]*(?:role|isAdmin|can\(|permission|hasRole)[^}]*\}/g, "frontend:disabled-by-role", (mm) => stringLiterals(mm[0])],
      ];
      for (const [re, kind, fn] of fe) {
        re.lastIndex = 0;
        while ((m = re.exec(text))) {
          const rs = fn(m).filter((s) => {
            if (!/^[\w\- ]{2,30}$/.test(s)) return false;   // paths, URLs, class lists, sentences
            const n = s.replace(/[\s-]+/g, "_");
            return ROLE_WORDS.test(n) || /^is_?admin$/i.test(n);
          });
          const ps = fn(m).filter((s) => /[:.]/.test(s) && /^[\w:.\-]{3,50}$/.test(s));
          frontendChecks.push({ kind, roles: uniq(rs.map(normalizeRole)), permissions: uniq(ps), source: { file, line: lineOf(text, m.index) }, snippet: snippetAt(text, m.index), feature: feat, layer: "frontend" });
          for (const r of rs) addRole(roles, r, "usage", { file, line: lineOf(text, m.index) });
        }
      }
    }
  }

  // roles referenced by endpoints
  for (const e of endpoints) { for (const r of e.roles) addRole(roles, r, "usage", e.source); for (const p of e.permissions) addPerm(perms, p, e.source); }

  // Apply path rules to endpoints (prefix match)
  for (const e of endpoints) {
    for (const pr of pathRules) {
      const prefix = pr.pattern.replace(/\/?\*\*?$/, "").replace(/\(.*\)/, "");
      const matches = pr.pattern.includes("*") ? e.path.startsWith(prefix || "/") : e.path === pr.pattern;
      if (!matches) continue;
      if (pr.effect === "public") { if (!e.guards.length) e.isPublic = true; continue; }
      e.guards.push(`path-rule:${pr.pattern}`);
      e.roles = uniq([...e.roles, ...pr.roles]);
      e.permissions = uniq([...e.permissions, ...pr.permissions]);
      e.isPublic = false;
    }
  }

  // Filter noise: keep a role if defined via enum/constant/config OR it appears in ≥1 check/endpoint and looks like a role word or is used ≥2 times
  const usedInEndpoints = new Set(endpoints.flatMap((e) => e.roles));
  const roleList = Array.from(roles.values()).filter((r) => r.kind !== "usage" || usedInEndpoints.has(r.name) || ROLE_WORDS.test(r.name) || r.sources.length >= 2);
  roleList.sort((a, b) => (a.kind === "usage" ? 1 : 0) - (b.kind === "usage" ? 1 : 0) || a.name.localeCompare(b.name));

  const actors = uniq([...roleList.map((r) => r.name), "authenticated", "anonymous"]);
  const matrix = buildMatrix(endpoints, roleList.map((r) => r.name));

  const dedupe = (arr: AccessCheck[]) => uniqBy(arr, (c) => `${c.source.file}:${c.source.line}:${c.roles.join(",")}:${c.permissions.join(",")}`);
  return { roles: roleList, permissions: Array.from(perms.values()).sort((a, b) => a.name.localeCompare(b.name)), guards: dedupeGuards(guards), pathRules, checks: dedupe(checks), frontendChecks: dedupe(frontendChecks), actors, matrix };
}

function dedupeGuards(g: GuardDef[]): GuardDef[] {
  const seen = new Set<string>();
  return g.filter((x) => { const k = `${x.name}@${x.source.file}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function endpointAllows(e: Endpoint, actor: string): boolean | "unknown" {
  if (actor === "anonymous") return e.isPublic;
  if (e.isPublic) return true;
  if (actor === "authenticated") return e.roles.length === 0 && e.permissions.length === 0 ? true : false;
  if (e.roles.length === 0 && e.permissions.length === 0) return true; // any authenticated user
  if (e.roles.includes(actor)) return true;
  if (e.roles.length === 0 && e.permissions.length > 0) return "unknown"; // permission-based, role mapping unknown
  return false;
}

export function buildMatrix(allEndpoints: Endpoint[], roleNames: string[]): MatrixRow[] {
  const endpoints = allEndpoints.filter((e) => !isInfraEndpointPath(e.path));
  const features = uniq(endpoints.map((e) => e.feature)).sort();
  const actors = [...roleNames, "authenticated", "anonymous"];
  return features.map((feature) => {
    const eps = endpoints.filter((e) => e.feature === feature);
    const access: Record<string, AccessLevel> = {};
    for (const a of actors) {
      let yes = 0, no = 0, unk = 0;
      for (const e of eps) { const r = endpointAllows(e, a); if (r === true) yes++; else if (r === false) no++; else unk++; }
      access[a] = yes === eps.length ? "full" : yes === 0 && unk === 0 ? "none" : yes === 0 && unk > 0 ? "unknown" : "partial";
    }
    return { feature, endpoints: eps.length, access, publicEndpoints: eps.filter((e) => e.isPublic).length };
  });
}
