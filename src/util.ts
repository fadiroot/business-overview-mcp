// Small text-processing helpers shared by the extractors.

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Given the index of an opening bracket, return the index of its matching close (or -1). */
export function matchBracket(text: string, openIdx: number): number {
  const open = text[openIdx];
  const close = open === "(" ? ")" : open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && text[i + 1] === "/") { // line comment
      const nl = text.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (c === "#" && (text[i - 1] === "\n" || i === 0)) { // python/ruby comment at line start
      const nl = text.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Content between the bracket at openIdx and its match, exclusive. */
export function bracketBody(text: string, openIdx: number): { body: string; end: number } | null {
  const end = matchBracket(text, openIdx);
  if (end === -1) return null;
  return { body: text.slice(openIdx + 1, end), end };
}

/** Split a string on top-level commas (ignores commas nested in brackets / strings). */
export function splitTopLevel(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === "\\") { cur += s[++i] ?? ""; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === sep && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function stringLiterals(s: string): string[] {
  const out: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[2]);
  return out;
}

/** Enum member references like Role.ADMIN / UserRole.Manager / Roles::ADMIN → ADMIN */
export function enumRefs(s: string): string[] {
  const out: string[] = [];
  const re = /\b(?:[A-Z]\w*)?(?:Role|Roles|UserType|AccountType|MemberType|Permission|Permissions|Perm|Scope|Ability|Abilities|Action|Actions)s?\w*(?:\.|::)([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

const ROLE_PREFIXES = /^(role[_:-]?|roles[_:-]?)/i;

export function normalizeRole(raw: string): string {
  let r = raw.trim().replace(/^['"`]|['"`]$/g, "");
  r = r.replace(/^(?:[A-Z]\w*)?(?:Role|Roles|UserType|AccountType|MemberType)s?\w*(?:\.|::)/, "");
  r = r.replace(ROLE_PREFIXES, "");
  r = r.replace(/[^A-Za-z0-9_\- ]/g, "");
  r = r.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  r = r.replace(/[\s-]+/g, "_").toLowerCase();
  return r;
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function uniqBy<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const a of arr) {
    const k = key(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export function titleCase(s: string): string {
  return s
    .replace(/[_\-./]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function singular(word: string): string {
  const w = word;
  if (/ies$/i.test(w)) return w.replace(/ies$/i, "y");
  if (/(ss|us|is)$/i.test(w)) return w;
  if (/(x|ch|sh)es$/i.test(w)) return w.replace(/es$/i, "");
  if (/s$/i.test(w) && !/ss$/i.test(w)) return w.slice(0, -1);
  return w;
}

export function plural(word: string): string {
  if (/y$/i.test(word) && !/[aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  if (/(s|x|ch|sh)$/i.test(word)) return word + "es";
  return word + "s";
}

export function joinPath(prefix: string, p: string): string {
  const a = (prefix || "").trim();
  const b = (p || "").trim();
  let out = "/" + [a, b].filter(Boolean).join("/");
  out = out.replace(/\/{2,}/g, "/");
  if (out.length > 1) out = out.replace(/\/$/, "");
  return out;
}

export function normalizePath(p: string): string {
  return p
    .replace(/\{(\w+)\}/g, ":$1") // {id} -> :id
    .replace(/<(?:\w+:)?(\w+)>/g, ":$1") // <int:id> -> :id
    .replace(/\[\.{3}(\w+)\]/g, ":$1*") // [...slug]
    .replace(/\[(\w+)\]/g, ":$1") // [id]
    .replace(/\(\?P<(\w+)>[^)]*\)/g, ":$1") // regex named group
    .replace(/\^|\$/g, "")
    .replace(/\/{2,}/g, "/");
}

export function isParamSegment(seg: string): boolean {
  return /^[:{<\[*]/.test(seg) || /^\d+$/.test(seg);
}

export function resourceFromPath(p: string): string {
  const segs = normalizePath(p).split("/").filter(Boolean);
  const skip = new Set(["api", "v1", "v2", "v3", "rest", "graphql", "internal", "public", "admin", "app"]);
  const candidates = segs.filter((s) => !isParamSegment(s) && !skip.has(s.toLowerCase()));
  const first = candidates[0];
  if (!first) {
    const adminIdx = segs.findIndex((s) => s.toLowerCase() === "admin");
    if (adminIdx >= 0) return "admin";
    return "root";
  }
  return first.replace(/\.\w+$/, "");
}

export function actionFromEndpoint(method: string, p: string, resource: string): string {
  const segs = normalizePath(p).split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  const lastIsParam = isParamSegment(last);
  if (isInfraEndpointPath(p)) return "health-check";
  if (lastIsParam && segs.length >= 2) {
    const prev = segs[segs.length - 2];
    const prevIsRes = prev.toLowerCase() === resource.toLowerCase() || singular(prev).toLowerCase() === singular(resource).toLowerCase();
    if (!isParamSegment(prev) && !prevIsRes && !/^(api|v\d+)$/i.test(prev)) return prev.replace(/[-_]/g, " ").toLowerCase();
  }
  const m = method.toUpperCase();
  const resSing = singular(resource).toLowerCase();
  const lastIsResource =
    last.toLowerCase() === resource.toLowerCase() || singular(last).toLowerCase() === resSing;
  if (m === "QUERY") return lastIsParam ? "view" : "query";
  if (m === "MUTATION") return "mutate";
  if (!lastIsParam && !lastIsResource && segs.length > 1 && !/^(api|v\d+)$/i.test(last)) {
    return last.replace(/[-_]/g, " ").toLowerCase();
  }
  switch (m) {
    case "GET":
    case "HEAD":
      return lastIsParam ? "view" : "list";
    case "POST":
      return "create";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return lastIsParam ? "view" : "access";
  }
}

export const AUTH_GUARD_RE =
  /(auth|jwt|passport|protect|authenticated|requireauth|requireuser|ensurelogged|verifytoken|verifyjwt|session_auth|sessionauth|requiresession|require_session|checksession|withsession|guard|login_required|loginrequired|jwt_required|permission|authorize|authoriz|role|roles|can\b|ability|policy|policies|secured|isadmin|is_admin|requires?_?role|requires?_?perm|acl|rbac|scope|bearer|apikey|api_key|token|current_user|get_current|sanctum|verified|staff|superuser|isauthenticated|permitted|allow|restrict|clerk|supabase|auth0|firebaseauth|checkauth|withauth|middleware\.auth)/i;

export const PUBLIC_MARK_RE = /\b(public|skipauth|allowanonymous|noauth|anonymous|permitall|optionalauth)\b/i;

export const NOT_GUARD_RE = /^(get_|make_|build_|create_|provide_|use_|inject_)?(\w+_)?(services?|repositor(y|ies)|repo|settings?|storage|dispatcher|db|database|session|sessions|client|clients|config|configuration|factory|engine|publisher|mailer|cache|uow|unit_of_work|logger|renderer|queue|bus|handler|mapper|serializer|schema|validator|pagination|params|query|body|request|response|context|container|registry|manager|provider|adapter|gateway|store|connection|pool|transaction|file_storage|notification_dispatcher)$/i;

export function looksLikeAuthGuard(name: string): boolean {
  if (!name) return false;
  const bare = name.split(".").pop()!.replace(/\(.*$/, "");
  if (NOT_GUARD_RE.test(bare)) return false;
  if (roleFromGuardName(bare).length) return true;
  if (PUBLIC_MARK_RE.test(name) && !/permission/i.test(name)) return false;
  return AUTH_GUARD_RE.test(name);
}

/** Pull roles and permissions out of a guard / decorator call argument list. */
export function rolesAndPermsFromCall(callName: string, args: string): { roles: string[]; perms: string[] } {
  const lits = stringLiterals(args);
  const refs = enumRefs(args);
  const roles: string[] = [];
  const perms: string[] = [];
  const isRoleCall = /role|roles|restrictto|allow|permit|only|authorize|authorise|hasany|^is[a-z]|require|group|secured|rolesallowed|middleware|use/i.test(callName) && !/perm|permission|ability|abilities|scope|authority|policy|policies/i.test(callName);
  const isPermCall = /perm|permission|permissions|can|ability|abilities|scope|authority|policy|gate|access/i.test(callName);
  // laravel style "role:admin|editor", "permission:edit posts", "can:update,post"
  for (const l of lits) {
    const mw = /^(role|roles|role_or_permission)\s*:\s*(.+)$/i.exec(l);
    if (mw) { roles.push(...mw[2].split(/[|,]/).map((s) => s.trim())); continue; }
    const pw = /^(permission|permissions|can|ability)\s*:\s*(.+)$/i.exec(l);
    if (pw) { perms.push(...pw[2].split(/[|]/).map((s) => s.trim())); continue; }
    const spring = /^ROLE_(\w+)$/.exec(l);
    if (spring) { roles.push(spring[1]); continue; }
    if (/^[a-z]+[:._-][a-z_-]+$/i.test(l) && /[:.]/.test(l)) { perms.push(l); continue; } // "posts:write", "users.delete"
    if (isPermCall && !isRoleCall) perms.push(l);
    else if (isRoleCall && /^[\w\- ]{2,40}$/.test(l)) roles.push(l);
  }
  for (const r of refs) {
    if (/perm|ability|scope|authority/i.test(callName)) perms.push(r);
    else roles.push(r);
  }
  return { roles: uniq(roles.map(normalizeRole).filter(Boolean)), perms: uniq(perms.map((p) => p.trim()).filter(Boolean)) };
}

/** Parse Spring-EL style: hasRole('ADMIN') or hasAnyRole('A','B') or hasAuthority('perm') */
export function parseSpringEl(expr: string): { roles: string[]; perms: string[]; authenticated: boolean; publicAccess: boolean } {
  const roles: string[] = [];
  const perms: string[] = [];
  const re = /(hasRole|hasAnyRole|hasAuthority|hasAnyAuthority|hasPermission)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) {
    const lits = stringLiterals(m[2]);
    if (/Role/.test(m[1])) roles.push(...lits.map((l) => l.replace(/^ROLE_/, "")));
    else perms.push(...lits);
  }
  return {
    roles: uniq(roles.map(normalizeRole)),
    perms: uniq(perms),
    authenticated: /isAuthenticated|authenticated\(\)/.test(expr) || roles.length > 0 || perms.length > 0,
    publicAccess: /permitAll|isAnonymous/.test(expr),
  };
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function snippetAt(text: string, idx: number, maxLen = 160): string {
  const start = text.lastIndexOf("\n", idx) + 1;
  let end = text.indexOf("\n", idx);
  if (end === -1) end = text.length;
  return truncate(text.slice(start, end).trim(), maxLen);
}

export function mdTable(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `| ${headers.map(esc).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ];
  return lines.join("\n");
}

export const INFRA_PATH_RE = /^\/?(api\/)?(v\d+\/)?(health|healthz|healthcheck|health-check|ping|ready|readyz|live|livez|status|metrics|version|docs|redoc|openapi(\.json)?|swagger(-ui)?(\.json)?|api-docs|favicon\.ico|robots\.txt|_next|__debug__)(\/|$)/i;

export function isInfraEndpointPath(p: string): boolean {
  return INFRA_PATH_RE.test(p);
}

const VERB_ACTIONS = /^(track|search|find|filter|export|import|approve|reject|cancel|publish|unpublish|archive|unarchive|restore|verify|confirm|assign|unassign|invite|login|logout|signin|signup|register|refresh|download|upload|send|resend|sync|generate|preview|duplicate|clone|complete|activate|deactivate|enable|disable|lock|unlock|ban|unban|follow|unfollow|like|unlike|share|subscribe|unsubscribe|checkout|pay|refund|ship|deliver|close|reopen|submit|review|accept|decline|start|stop|pause|resume|retry|reset|validate|calculate|count|bulk|batch|process|run|execute|trigger|notify|mark|toggle|move|copy|merge|split|convert|transfer|withdraw|deposit|redeem|apply|claim|book|reserve|release|renew|revoke|grant|promote|demote|suspend|reactivate|escalate|resolve|forward|reply|comment|rate|vote|report|flag|pin|unpin|star|unstar|join|leave|kick|mute|unmute|block|unblock|purge|clear|flush|rebuild|reindex|migrate|seed|impersonate|switch|select|change|set|add|remove|attach|detach|link|unlink|enroll|unenroll|graduate|certify|grade|finalize|lookup|autocomplete|suggest|recommend|compare|estimate|quote|simulate|test|check|verify)$/i;

/** Human-friendly use-case name from method + action + resource. */
export function useCaseName(method: string, action: string, resource: string): string {
  const res = singular(resource).replace(/[-_]/g, " ").toLowerCase();
  const m = method.toUpperCase();
  switch (action) {
    case "list": return `List ${plural(res)}`;
    case "view": return `View ${res} details`;
    case "create": return `Create ${res}`;
    case "update": return `Update ${res}`;
    case "delete": return `Delete ${res}`;
    case "query": return `Query ${plural(res)}`;
    case "mutate": return `Modify ${plural(res)}`;
    case "access": return `Access ${plural(res)}`;
  }
  const a = action.replace(/[-_]/g, " ").toLowerCase();
  if (/^(me|self|own|profile|account|current)$/.test(a)) return m === "GET" ? `View own ${res === "user" ? "profile" : res}` : `Update own ${res === "user" ? "profile" : res}`;
  const firstWord = a.split(" ")[0];
  if (VERB_ACTIONS.test(firstWord)) return `${a[0].toUpperCase()}${a.slice(1)} ${res}`;
  if (m === "GET" || m === "HEAD") return `View ${res} ${a}`;
  if (m === "POST") return `Add ${res} ${a}`;
  if (m === "PUT" || m === "PATCH") return `Update ${res} ${a}`;
  if (m === "DELETE") return `Remove ${res} ${a}`;
  return `${a[0].toUpperCase()}${a.slice(1)} ${res}`;
}

const ROLE_TOKENS = new Set(["admin", "administrator", "superadmin", "super_admin", "superuser", "root", "owner", "manager", "staff", "editor", "moderator", "teacher", "student", "instructor", "learner", "parent", "customer", "vendor", "seller", "merchant", "supplier", "partner", "agent", "support", "operator", "employee", "supervisor", "auditor", "reviewer", "approver", "doctor", "nurse", "patient", "driver", "member", "subscriber", "guest", "coach", "recruiter", "maintainer", "developer", "analyst", "accountant", "finance_admin", "billing_admin", "org_admin", "workspace_admin", "team_admin"]);
const GUARD_VERB_RE = /^(require|requires|ensure|verify|check|assert|only|must_be|mustbe|is|get_current|current|authenticated|authorize|allow|restrict|need|needs|with|as|for)_?/i;
const GUARD_SUFFIX_RE = /_?(required|only|guard|dependency|dep|user|access|check|auth|middleware|role|perm|permission)s?$/i;

/** Infer roles from a guard/dependency name such as require_finance_admin, get_current_admin, teacher_only, isManager, AdminGuard. */
export function roleFromGuardName(name: string): string[] {
  const bare = name.split(".").pop()!.replace(/\(.*$/, "");
  if (!bare || NOT_GUARD_RE.test(bare)) return [];
  const snake = bare.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (!GUARD_VERB_RE.test(snake) && !GUARD_SUFFIX_RE.test(snake) && !/^(admin|superadmin|teacher|student|manager|owner|staff)_/.test(snake)) return [];
  const tokens = snake.split(/[_\-]+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const pair = i + 1 < tokens.length ? `${t}_${tokens[i + 1]}` : "";
    if (pair && ROLE_TOKENS.has(pair)) { out.push(pair); i++; continue; }
    if (ROLE_TOKENS.has(t)) out.push(t);
  }
  return uniq(out.map((r) => (r === "administrator" ? "admin" : r.endsWith("_admin") && r !== "super_admin" ? "admin" : r)));
}
