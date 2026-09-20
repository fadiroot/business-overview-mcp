// Feature (module) assignment for a file path. Handles feature-folder layouts, layered/hexagonal layouts
// (routes/, use_cases/, entities/ ...), Next.js app routers, and monorepos with several app roots.
import { singular } from "./util.js";

export const GENERIC_SEGMENTS = new Set([
  "src", "app", "apps", "lib", "libs", "packages", "server", "backend", "frontend", "client", "api", "internal", "pkg",
  "cmd", "modules", "module", "features", "feature", "domains", "domain", "controllers", "controller", "routes", "router",
  "routers", "services", "service", "models", "model", "entities", "entity", "handlers", "handler", "views", "view",
  "components", "component", "pages", "page", "core", "common", "shared", "utils", "util", "helpers", "config", "configs",
  "main", "java", "kotlin", "com", "org", "io", "net", "resources", "http", "web", "www", "public", "static", "assets", "dto",
  "dtos", "schemas", "schema", "repositories", "repository", "middleware", "middlewares", "guards", "decorators", "interfaces",
  "types", "hooks", "store", "stores", "layouts", "prisma", "db", "database", "migrations", "seeders", "seeds", "tests", "test",
  "__tests__", "spec", "specs", "scripts", "bin", "docs", "infra", "deploy", "graphql", "resolvers", "resolver", "mutations",
  "queries", "subscriptions", "v1", "v2", "v3", "rest", "application", "presentation", "infrastructure", "adapters", "adapter", "ports", "port",
  "usecases", "use-cases", "use_cases", "interactors", "actions", "jobs", "workers", "tasks", "listeners", "events", "mail",
  "notifications", "policies", "providers", "console", "exceptions", "rules", "requests", "resource", "factories", "templates", "template",
  "persistence", "security", "storage", "ws", "websocket", "websockets", "sockets", "grpc", "proto", "protos", "cli", "commands", "command",
  "constants", "enums", "errors", "filters", "pipes", "interceptors", "validators", "validation", "serializers", "mappers", "presenters",
  "transformers", "responses", "dtos", "contracts", "specs", "fixtures", "mocks", "stubs", "e2e", "integration", "unit", "styles", "css",
  "images", "img", "fonts", "icons", "locales", "i18n", "lang", "translations", "theme", "themes", "vendor", "third_party", "external",
]);

const CORE_SEGMENTS = new Set(["common", "shared", "core", "utils", "util", "helpers", "lib", "libs", "config", "configs", "infra", "infrastructure", "middleware", "middlewares", "guards", "decorators", "interceptors", "filters", "pipes", "types", "interfaces", "dto", "dtos", "constants", "enums", "exceptions", "errors", "prisma", "db", "database", "migrations", "seeds", "seeders", "scripts", "bin", "docs", "test", "tests", "__tests__", "spec", "e2e", "fixtures", "mocks", "styles", "assets", "public", "static", "layouts", "providers", "hooks", "store", "stores", "i18n", "locales", "theme", "themes", "security", "storage", "persistence", "pagination", "validators", "validation"]);

const FEATURE_MARKERS = new Set(["features", "feature", "modules", "module", "domains", "domain", "apps", "packages", "services", "bounded-contexts", "contexts"]);
const NAMESPACE_SEGMENTS = new Set(["admin", "dashboard", "teacher", "student", "portal", "panel", "backoffice", "back-office", "manage", "management", "account", "console", "protected", "private", "authenticated", "auth", "api", "app", "site", "www"]);
const LAYER_DIRS = /^(routes?|routers?|controllers?|api|handlers?|resolvers?|use_cases|usecases|use-cases|interactors|entities|models?|services?|repositories|repository|views?|schemas?|serializers?|policies|guards|commands|queries|jobs|tasks|listeners|events|mutations|subscriptions|endpoints|actions)$/i;
const UI_DIRS = /^(components?|pages?|views?|layouts?|screens?|widgets?|partials?|templates?|sections?|blocks?|ui)$/i;
const STEM_SUFFIX_RE = /(?:^|[_\-.])(routes?|router|controllers?|use_?cases?|usecase|services?|models?|entit(?:y|ies)|schemas?|handlers?|views?|resolvers?|repositor(?:y|ies)|repo|polic(?:y|ies)|guards?|middlewares?|dtos?|serializers?|forms?|urls|responses?|mappers?|filters?|helpers?|utils?|constants?|types?|tests?|spec|impl|adapter|ports?|rules|timing|pricing|dispatcher|publisher|logger|renderer|fields|flow|flows|api|page|layout|index|main|module|component|hook|hooks|store|slice|reducer|saga|thunk|context|provider|config|settings_schema|validators?|validation|manager|factory|builder|client|gateway|worker|job|task|listener|subscriber|consumer|producer|command|query|queries|events?|notification|notifications|exceptions?|errors?)$/i;
const STEM_STOP = new Set(["api", "client", "http", "fetcher", "axios", "request", "requests", "endpoints", "index", "main", "app", "server", "application", "bootstrap", "setup", "layout", "page", "route", "routes", "error", "loading", "not-found", "global", "globals", "vite", "webpack", "next", "nuxt", "tailwind", "postcss", "eslint", "prettier", "jest", "vitest", "babel", "tsconfig", "package", "readme", "license", "dockerfile", "makefile", "env", "constants", "types", "utils", "helpers", "config", "settings", "init", "__init__", "conftest", "manage", "wsgi", "asgi", "urls", "admin", "apps", "models", "views", "serializers", "forms", "tests", "schema", "schemas", "dependencies", "deps", "database", "db", "base", "common", "shared", "core"]);
const GENERIC_TOKENS = new Set(["get", "set", "list", "create", "update", "delete", "remove", "notify", "send", "use", "case", "cases", "admin", "user", "users", "new", "old", "my", "all", "by", "for", "with", "to", "from", "of", "and", "or", "the", "a", "an", "in", "on", "at", "is", "has", "check", "verify", "handle", "process", "run", "do", "make", "build", "load", "save", "fetch", "read", "write", "parse", "format", "render", "show", "hide", "open", "close", "start", "stop", "init", "setup", "main", "app", "core", "common", "shared", "base", "util", "utils", "helper", "helpers", "public", "private", "internal", "external", "default", "custom", "simple", "basic", "advanced", "generic", "detail", "details", "item", "items", "data", "info", "status", "type", "types", "page", "pages", "view", "views", "form", "forms", "table", "tables", "card", "cards", "modal", "store", "log", "logs"]);
const NO_SINGULAR = new Set(["settings", "news", "analytics", "status", "sms", "canvas", "series", "media", "data", "metrics", "physics", "mathematics", "maths", "economics", "statistics", "logistics", "graphics", "ethics", "politics", "business", "access", "progress", "address", "process", "success", "campus", "bonus", "focus", "basis", "analysis", "diagnosis", "thesis", "axis", "crisis", "ios", "cms", "lms", "kpis", "faqs", "faq", "css", "js", "ts", "ws", "oauth", "auth"]);

const INFRA_PREFIX_RE = /^(sqlalchemy|sql|pg|postgres|postgresql|mysql|sqlite|mongo|mongodb|redis|prisma|typeorm|sequelize|drizzle|django|fastapi|flask|express|nest|http|rest|grpc|graphql|in_memory|inmemory|memory|fake|mock|stub|base|abstract|default|generic|simple|local|remote|cached|async|sync)_(?=\w{3,})/;
function cleanStem(stem: string): string {
  let s = stem.toLowerCase().replace(INFRA_PREFIX_RE, "");
  if (new RegExp("^" + STEM_SUFFIX_RE.source.replace(/^\(\?:\^\|\[_\\-\.\]\)/, ""), "i").test(s)) return "";
  for (let i = 0; i < 6; i++) {
    const next = s.replace(STEM_SUFFIX_RE, "").replace(/[_\-.]+$/, "");
    if (next === s || next.length < 2) break;
    s = next;
  }
  return s.replace(/[_\-.]+$/, "");
}

function normalizeFeature(name: string): string {
  let n = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[\s.]+/g, "_").replace(/-+/g, "_");
  // Admin-prefixed UI template names: AdminBooks -> books
  const adminPrefix = /^admin[_-](?=[a-z]{3,})/.exec(n);
  if (adminPrefix && /^Admin[A-Z]/.test(name)) n = n.slice(adminPrefix[0].length);
  n = n.replace(/_(page|screen|view|modal|drawer|dialog|section|widget|panel|layout|template|container|wrapper)$/, "");
  // plural -> singular for plain words so "students" (frontend) meets "student" (backend)
  const toks = n.split("_");
  const last = toks[toks.length - 1];
  if (/^[a-z]+$/.test(last) && last.length > 3 && !NO_SINGULAR.has(last) && !NO_SINGULAR.has(n)) toks[toks.length - 1] = singular(last);
  n = toks.join("_");
  return n || "core";
}

/**
 * @param rel      path relative to project root
 * @param appRoots directories that hold their own manifest (package.json, pyproject …) and act as app boundaries
 */
export function featureOf(rel: string, appRoots: Set<string> = new Set(), isFrontend = false): string {
  const segs = rel.split("/");
  let dirs = segs.slice(0, -1);
  const base = segs[segs.length - 1];
  let appRootName = "";
  // strip app roots ("new_frontend/", "apps/web/") so their internal structure decides
  for (let i = dirs.length; i > 0; i--) { if (appRoots.has(dirs.slice(0, i).join("/"))) { appRootName = dirs[i - 1]; dirs = dirs.slice(i); break; } }
  if (dirs.some((d) => /^(migrations?|seeds?|seeders?|fixtures?|snapshots?|__snapshots__|generated|__generated__)$/i.test(d))) return "core";
  const supportFallback = () => (isFrontend ? "ui" : appRootName && !GENERIC_SEGMENTS.has(appRootName.toLowerCase()) && !CORE_SEGMENTS.has(appRootName.toLowerCase()) ? normalizeFeature(appRootName) : "core");
  if (dirs.length === 0 && segs.length === 1) return "core";

  // 1. explicit feature marker: .../features/<name>/...
  for (let i = dirs.length - 2; i >= 0; i--) {
    if (FEATURE_MARKERS.has(dirs[i].toLowerCase()) && dirs[i + 1] && !GENERIC_SEGMENTS.has(dirs[i + 1].toLowerCase())) return normalizeFeature(dirs[i + 1]);
  }
  // 2. first non-generic directory, with namespace hop (app/admin/students -> students)
  const meaningful = dirs.map((d, i) => ({ d, i })).filter(({ d }) => { const l = d.toLowerCase(); return !GENERIC_SEGMENTS.has(l) && !l.startsWith(".") && !/^[(\[@]/.test(l) && !CORE_SEGMENTS.has(l); });
  if (meaningful.length) {
    const parentOfPick = (dirs[meaningful[0].i - 1] ?? "").toLowerCase();
    if (/^(components?|widgets?|partials?|ui|atoms|molecules|organisms|elements|primitives|blocks)$/.test(parentOfPick)) return "ui";
    let pick = meaningful[0].d;
    if (NAMESPACE_SEGMENTS.has(pick.toLowerCase()) && meaningful[1] && !/^[(\[@]/.test(meaningful[1].d)) pick = meaningful[1].d;
    else if (NAMESPACE_SEGMENTS.has(pick.toLowerCase()) && !meaningful[1]) {
      // app/admin/page.tsx -> admin dashboard; fall through to stem if it is informative
      const stem = cleanStem(base.split(".")[0]);
      if (stem && !STEM_STOP.has(stem) && stem.length > 2) return normalizeFeature(stem);
      return normalizeFeature(pick);
    }
    return normalizeFeature(pick);
  }
  // 3. cross-cutting directories are "core" unless the file stem is informative (layered layouts: routes/teacher_routes.py)
  const lastDir = (dirs[dirs.length - 1] ?? "").toLowerCase();
  const stem = cleanStem(base.split(".")[0]);
  if (UI_DIRS.test(lastDir) && !/^Admin[A-Z]/.test(base)) {
    // templates/AdminBooks/index.tsx -> the directory name is the meaningful part
    const parent = dirs[dirs.length - 1] ?? "";
    if (parent && !UI_DIRS.test(parent) && !GENERIC_SEGMENTS.has(parent.toLowerCase())) return normalizeFeature(parent);
    return "ui";
  }
  const rawStem = base.split(".")[0].toLowerCase();
  const layered = LAYER_DIRS.test(lastDir) || (rawStem !== stem && stem.length >= 2);
  if (stem && !STEM_STOP.has(stem) && stem.length >= 2 && layered) {
    // UI component folder "templates/AdminBooks/index.tsx": use folder when the file is index
    if (/^index$/i.test(base.split(".")[0]) && dirs.length) { const parent = dirs[dirs.length - 1]; if (!GENERIC_SEGMENTS.has(parent.toLowerCase())) return normalizeFeature(parent); }
    return normalizeFeature(stem);
  }
  if (/^index$/i.test(base.split(".")[0]) && dirs.length) { const parent = dirs[dirs.length - 1]; if (!GENERIC_SEGMENTS.has(parent.toLowerCase()) && !CORE_SEGMENTS.has(parent.toLowerCase())) return normalizeFeature(parent); }
  return supportFallback();
}

export function detectAppRoots(rels: string[]): Set<string> {
  const roots = new Set<string>();
  for (const r of rels) {
    if (!/(^|\/)(package\.json|pyproject\.toml|requirements\.txt|composer\.json|go\.mod|Gemfile|pom\.xml|manage\.py|artisan|build\.gradle(\.kts)?|[^/]+\.csproj|nest-cli\.json|next\.config\.(js|mjs|ts))$/.test(r)) continue;
    const dir = r.split("/").slice(0, -1).join("/");
    if (dir && dir.split("/").length <= 3) roots.add(dir);
  }
  return roots;
}

/** Merge one-file features into an anchor feature whose name is a token prefix of theirs (notify_session_students -> session). */
export function mergeSingletonFeatures(files: { rel: string; feature: string; isTest: boolean }[]): void {
  const count = new Map<string, number>();
  for (const f of files) if (!f.isTest) count.set(f.feature, (count.get(f.feature) ?? 0) + 1);
  const anchors = new Set(Array.from(count.entries()).filter(([k, n]) => n >= 2 && !NAMESPACE_SEGMENTS.has(k) && !GENERIC_TOKENS.has(k)).map(([k]) => k));
  for (const f of files) {
    if ((count.get(f.feature) ?? 0) > 1 || f.feature === "core" || f.feature === "ui") continue;
    const toks = f.feature.split("_");
    if (toks.length < 2) continue;
    let merged = false;
    for (let i = toks.length - 1; i >= 1 && !merged; i--) { const cand = toks.slice(0, i).join("_"); if (anchors.has(cand)) { f.feature = cand; merged = true; } }
    if (!merged) { const cands = toks.filter((t) => !GENERIC_TOKENS.has(t) && anchors.has(t)).sort((a, b) => b.length - a.length); if (cands.length) f.feature = cands[0]; }
  }
}
