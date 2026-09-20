import fg from "fast-glob";
import fs from "node:fs";
import path from "node:path";
import type { FileInfo, ProjectIndex } from "./types.js";
import { uniq } from "./util.js";
import { detectAppRoots, featureOf, mergeSingletonFeatures } from "./features.js";
export { featureOf } from "./features.js";

const IGNORE = [
  "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/out/**", "**/.next/**", "**/.nuxt/**",
  "**/coverage/**", "**/vendor/**", "**/venv/**", "**/.venv/**", "**/__pycache__/**", "**/target/**",
  "**/bin/**", "**/obj/**", "**/.idea/**", "**/.vscode/**", "**/tmp/**", "**/.cache/**", "**/.turbo/**",
  "**/storage/framework/**", "**/bootstrap/cache/**", "**/*.min.js", "**/*.map", "**/*.lock", "**/package-lock.json",
  "**/pnpm-lock.yaml", "**/yarn.lock", "**/.terraform/**", "**/migrations/**/*.pyc", "**/*.d.ts", "**/public/assets/**",
];

const LANG_BY_EXT: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  vue: "Vue", svelte: "Svelte", astro: "Astro",
  py: "Python", php: "PHP", rb: "Ruby", java: "Java", kt: "Kotlin", go: "Go", cs: "C#", rs: "Rust", scala: "Scala",
  sql: "SQL", prisma: "Prisma", graphql: "GraphQL", gql: "GraphQL",
  html: "HTML", css: "CSS", scss: "CSS",
  json: "Config", yaml: "Config", yml: "Config", toml: "Config", env: "Config", xml: "Config", csv: "Data",
  md: "Docs", mdx: "Docs",
};

const SOURCE_EXTS = Object.keys(LANG_BY_EXT);


// dependency name -> [label, category]
const DEP_MAP: Record<string, [string, "framework" | "orm" | "db" | "external" | "auth" | "frontend"]> = {
  express: ["Express", "framework"], fastify: ["Fastify", "framework"], koa: ["Koa", "framework"], hapi: ["Hapi", "framework"], "@hapi/hapi": ["Hapi", "framework"],
  "@nestjs/core": ["NestJS", "framework"], next: ["Next.js", "frontend"], nuxt: ["Nuxt", "frontend"], react: ["React", "frontend"], vue: ["Vue", "frontend"],
  "@angular/core": ["Angular", "frontend"], svelte: ["Svelte", "frontend"], "@sveltejs/kit": ["SvelteKit", "frontend"], "@remix-run/node": ["Remix", "frontend"],
  "react-native": ["React Native", "frontend"], expo: ["Expo", "frontend"], electron: ["Electron", "frontend"], hono: ["Hono", "framework"], "@trpc/server": ["tRPC", "framework"],
  "apollo-server": ["Apollo GraphQL", "framework"], "@apollo/server": ["Apollo GraphQL", "framework"], graphql: ["GraphQL", "framework"], "socket.io": ["Socket.IO", "framework"],
  prisma: ["Prisma", "orm"], "@prisma/client": ["Prisma", "orm"], typeorm: ["TypeORM", "orm"], sequelize: ["Sequelize", "orm"], mongoose: ["Mongoose", "orm"],
  "drizzle-orm": ["Drizzle", "orm"], knex: ["Knex", "orm"], objection: ["Objection", "orm"], "mikro-orm": ["MikroORM", "orm"], "@mikro-orm/core": ["MikroORM", "orm"],
  pg: ["PostgreSQL", "db"], postgres: ["PostgreSQL", "db"], mysql: ["MySQL", "db"], mysql2: ["MySQL", "db"], sqlite3: ["SQLite", "db"], "better-sqlite3": ["SQLite", "db"],
  mongodb: ["MongoDB", "db"], redis: ["Redis", "db"], ioredis: ["Redis", "db"], "@supabase/supabase-js": ["Supabase", "external"], firebase: ["Firebase", "external"],
  "firebase-admin": ["Firebase", "external"], "@casl/ability": ["CASL (authorization)", "auth"], casbin: ["Casbin (authorization)", "auth"], passport: ["Passport", "auth"],
  "next-auth": ["NextAuth", "auth"], "@auth/core": ["Auth.js", "auth"], "@clerk/nextjs": ["Clerk", "auth"], "@clerk/clerk-sdk-node": ["Clerk", "auth"], "keycloak-connect": ["Keycloak", "auth"],
  "@nestjs/passport": ["Passport", "auth"], "@nestjs/jwt": ["JWT", "auth"], jsonwebtoken: ["JWT", "auth"], "express-jwt": ["JWT", "auth"], auth0: ["Auth0", "auth"], "express-session": ["Sessions", "auth"],
  stripe: ["Stripe", "external"], "@stripe/stripe-js": ["Stripe", "external"], paypal: ["PayPal", "external"], "@paypal/checkout-server-sdk": ["PayPal", "external"],
  "@sendgrid/mail": ["SendGrid", "external"], nodemailer: ["SMTP e-mail", "external"], "resend": ["Resend", "external"], mailgun: ["Mailgun", "external"], "mailgun.js": ["Mailgun", "external"], postmark: ["Postmark", "external"],
  twilio: ["Twilio", "external"], "aws-sdk": ["AWS", "external"], "@aws-sdk/client-s3": ["AWS S3", "external"], "@aws-sdk/client-ses": ["AWS SES", "external"], "@aws-sdk/client-sqs": ["AWS SQS", "external"],
  "@google-cloud/storage": ["Google Cloud Storage", "external"], "googleapis": ["Google APIs", "external"], openai: ["OpenAI", "external"], "@anthropic-ai/sdk": ["Anthropic Claude", "external"],
  bullmq: ["BullMQ (queue)", "external"], bull: ["Bull (queue)", "external"], "amqplib": ["RabbitMQ", "external"], kafkajs: ["Kafka", "external"], "@elastic/elasticsearch": ["Elasticsearch", "external"],
  algoliasearch: ["Algolia", "external"], "@sentry/node": ["Sentry", "external"], "@sentry/nextjs": ["Sentry", "external"], "posthog-node": ["PostHog", "external"], mixpanel: ["Mixpanel", "external"],
  "@slack/web-api": ["Slack", "external"], cloudinary: ["Cloudinary", "external"], sharp: ["Image processing", "external"], puppeteer: ["Puppeteer", "external"], "onesignal-node": ["OneSignal", "external"],
  // python
  fastapi: ["FastAPI", "framework"], flask: ["Flask", "framework"], django: ["Django", "framework"], djangorestframework: ["Django REST Framework", "framework"], starlette: ["Starlette", "framework"],
  sqlalchemy: ["SQLAlchemy", "orm"], sqlmodel: ["SQLModel", "orm"], tortoise: ["Tortoise ORM", "orm"], "tortoise-orm": ["Tortoise ORM", "orm"], peewee: ["Peewee", "orm"], alembic: ["Alembic", "orm"], pymongo: ["MongoDB", "db"], motor: ["MongoDB", "db"],
  psycopg2: ["PostgreSQL", "db"], "psycopg2-binary": ["PostgreSQL", "db"], psycopg: ["PostgreSQL", "db"], asyncpg: ["PostgreSQL", "db"], pymysql: ["MySQL", "db"], "mysqlclient": ["MySQL", "db"], celery: ["Celery (queue)", "external"], rq: ["RQ (queue)", "external"],
  "python-jose": ["JWT", "auth"], pyjwt: ["JWT", "auth"], "flask-login": ["Flask-Login", "auth"], "flask-jwt-extended": ["JWT", "auth"], "django-guardian": ["django-guardian (object permissions)", "auth"], "flask-principal": ["Flask-Principal", "auth"], "flask-security": ["Flask-Security", "auth"], authlib: ["Authlib", "auth"], oauthlib: ["OAuth", "auth"],
  boto3: ["AWS", "external"], sendgrid: ["SendGrid", "external"], anthropic: ["Anthropic Claude", "external"], "sentry-sdk": ["Sentry", "external"],
  // php
  "laravel/framework": ["Laravel", "framework"], "symfony/framework-bundle": ["Symfony", "framework"], "spatie/laravel-permission": ["Spatie Permission (RBAC)", "auth"], "laravel/sanctum": ["Sanctum", "auth"], "laravel/passport": ["Passport (OAuth)", "auth"], "tymon/jwt-auth": ["JWT", "auth"], "laravel/cashier": ["Stripe Cashier", "external"], "livewire/livewire": ["Livewire", "frontend"], "inertiajs/inertia-laravel": ["Inertia", "frontend"], "filament/filament": ["Filament admin", "frontend"],
  // java
  "spring-boot-starter-web": ["Spring Boot", "framework"], "spring-boot-starter-security": ["Spring Security", "auth"], "spring-boot-starter-data-jpa": ["JPA/Hibernate", "orm"], "hibernate-core": ["Hibernate", "orm"],
  // go
  "github.com/gin-gonic/gin": ["Gin", "framework"], "github.com/labstack/echo/v4": ["Echo", "framework"], "github.com/go-chi/chi/v5": ["Chi", "framework"], "github.com/gofiber/fiber/v2": ["Fiber", "framework"], "gorm.io/gorm": ["GORM", "orm"], "github.com/casbin/casbin/v2": ["Casbin (authorization)", "auth"],
  // ruby
  rails: ["Rails", "framework"], devise: ["Devise", "auth"], pundit: ["Pundit (policies)", "auth"], cancancan: ["CanCanCan", "auth"],
  // dotnet
  "Microsoft.EntityFrameworkCore": ["Entity Framework", "orm"], "Microsoft.AspNetCore.Authentication.JwtBearer": ["JWT", "auth"],
};

const cache = new Map<string, ProjectIndex>();
const textCache = new Map<string, { mtime: number; text: string }>();

export function resolveRoot(root: string): string {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`root is not a directory: ${abs}`);
  }
  return abs;
}

export function readText(abs: string): string {
  try {
    const st = fs.statSync(abs);
    const c = textCache.get(abs);
    if (c && c.mtime === st.mtimeMs) return c.text;
    if (st.size > 1_500_000) return "";
    const text = fs.readFileSync(abs, "utf8");
    textCache.set(abs, { mtime: st.mtimeMs, text });
    return text;
  } catch {
    return "";
  }
}

function isFrontendFile(rel: string, ext: string): boolean {
  if (["tsx", "jsx", "vue", "svelte", "astro", "html", "css", "scss"].includes(ext)) return true;
  return /(^|\/)([\w-]*(frontend|front|client|webapp|web-app|spa|pwa|ui)|web|components|pages|views|app\/\(|public\/js|resources\/js|resources\/views|templates)\//i.test(rel) && !/(^|\/)(api|server|backend)\//i.test(rel);
}

function isTestFile(rel: string): boolean {
  return /(\.|_|-)?(test|spec|tests|e2e)(\.|_|-|\/)|(^|\/)(tests?|__tests__|spec|e2e|cypress|__mocks__|fixtures)\//i.test(rel);
}

function readJson(abs: string): any | null {
  try { return JSON.parse(readText(abs)); } catch { return null; }
}

function collectDependencies(root: string, manifests: string[]): string[] {
  const deps: string[] = [];
  for (const m of manifests) {
    const abs = path.join(root, m);
    const base = path.basename(m);
    if (base === "package.json") {
      const j = readJson(abs);
      if (j) for (const k of ["dependencies", "devDependencies", "peerDependencies"]) deps.push(...Object.keys(j[k] ?? {}));
    } else if (base === "requirements.txt" || /^requirements.*\.txt$/.test(base)) {
      for (const line of readText(abs).split("\n")) {
        const m2 = /^\s*([A-Za-z0-9_.\-]+)/.exec(line);
        if (m2 && !line.trim().startsWith("#") && !line.trim().startsWith("-")) deps.push(m2[1].toLowerCase());
      }
    } else if (base === "pyproject.toml" || base === "Pipfile") {
      const txt = readText(abs);
      const re = /^\s*"?([A-Za-z0-9_.\-]+)"?\s*(?:=|>=|==|~=|<|>|\[)/gm;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(txt))) deps.push(mm[1].toLowerCase());
      const listRe = /["']([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*(?:[<>=!~][^"']*)?["']/g;
      while ((mm = listRe.exec(txt))) deps.push(mm[1].toLowerCase());
    } else if (base === "composer.json") {
      const j = readJson(abs);
      if (j) for (const k of ["require", "require-dev"]) deps.push(...Object.keys(j[k] ?? {}));
    } else if (base === "pom.xml") {
      const txt = readText(abs);
      const re = /<artifactId>([^<]+)<\/artifactId>/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(txt))) deps.push(mm[1]);
    } else if (/^build\.gradle(\.kts)?$/.test(base)) {
      const txt = readText(abs);
      const re = /['"]([\w.\-]+):([\w.\-]+)(?::[\w.\-]+)?['"]/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(txt))) deps.push(mm[2]);
    } else if (base === "go.mod") {
      const txt = readText(abs);
      const re = /^\s*([\w.\-\/]+\.[\w\-]+\/[\w.\-\/]+)\s+v[\d.]+/gm;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(txt))) deps.push(mm[1]);
    } else if (base === "Gemfile") {
      const txt = readText(abs);
      const re = /^\s*gem\s+['"]([\w\-]+)['"]/gm;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(txt))) deps.push(mm[1]);
    } else if (/\.csproj$/.test(base)) {
      const txt = readText(abs);
      const re = /<PackageReference\s+Include="([^"]+)"/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(txt))) deps.push(mm[1]);
    }
  }
  return uniq(deps);
}

const GENERIC_PROJECT_NAME = /^(root|app|apps|main|src|source|server|client|web|api|project|workspace|monorepo|template|starter|boilerplate|my-app|example|examples|demo|test|package|repo|code)$/i;

function projectName(root: string, manifests: string[]): string {
  for (const m of manifests) {
    if (path.basename(m) === "package.json" && !m.includes("/")) {
      const j = readJson(path.join(root, m));
      const n = j?.name ? String(j.name).replace(/^@[^/]+\//, "") : "";
      if (n && !GENERIC_PROJECT_NAME.test(n)) return n;
    }
    if (path.basename(m) === "composer.json" && !m.includes("/")) {
      const j = readJson(path.join(root, m));
      if (j?.name) return String(j.name).split("/").pop()!;
    }
    if (path.basename(m) === "pyproject.toml" && !m.includes("/")) {
      const mm = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(readText(path.join(root, m)));
      if (mm) return mm[1];
    }
  }
  return path.basename(root);
}

export async function buildIndex(rootInput: string, refresh = false): Promise<ProjectIndex> {
  const root = resolveRoot(rootInput);
  if (!refresh && cache.has(root)) return cache.get(root)!;

  const patterns = [`**/*.{${SOURCE_EXTS.join(",")}}`, "**/Gemfile", "**/go.mod", "**/Dockerfile", "**/*.csproj", "**/pom.xml", "**/build.gradle", "**/build.gradle.kts", "**/Pipfile", "**/requirements*.txt", "**/artisan", "**/manage.py"];
  const rels = await fg(patterns, { cwd: root, ignore: IGNORE, dot: false, onlyFiles: true, followSymbolicLinks: false, suppressErrors: true, caseSensitiveMatch: false });

  const appRoots = detectAppRoots(rels);
  const files: FileInfo[] = [];
  const languages: Record<string, number> = {};
  let totalLoc = 0;
  for (const rel of rels.sort()) {
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.size > 1_500_000) continue;
    const ext = path.extname(rel).slice(1).toLowerCase();
    const base = path.basename(rel);
    const lang = LANG_BY_EXT[ext] ?? (base === "Gemfile" ? "Ruby" : base === "go.mod" ? "Go" : base === "artisan" ? "PHP" : "Other");
    let loc = 0;
    if (st.size < 400_000 && lang !== "Config" && lang !== "Docs" && lang !== "Data") {
      const txt = readText(abs);
      loc = txt ? txt.split("\n").filter((l) => l.trim()).length : 0;
    }
    const isFrontend = isFrontendFile(rel, ext);
    const info: FileInfo = { rel, abs, ext, lang, size: st.size, loc, feature: featureOf(rel, appRoots, isFrontend), isFrontend, isTest: isTestFile(rel) };
    files.push(info);
    if (!info.isTest && lang !== "Config" && lang !== "Docs" && lang !== "Data") {
      languages[lang] = (languages[lang] ?? 0) + loc;
      totalLoc += loc;
    }
  }

  mergeSingletonFeatures(files);

  const manifests = files
    .filter((f) => /^(package\.json|composer\.json|pyproject\.toml|Pipfile|requirements.*\.txt|go\.mod|Gemfile|pom\.xml|build\.gradle(\.kts)?|.*\.csproj)$/.test(path.basename(f.rel)))
    .map((f) => f.rel)
    .filter((r) => r.split("/").length <= 4);
  const dependencies = collectDependencies(root, manifests);

  const frameworks: string[] = [];
  const externalServices: string[] = [];
  const databases: string[] = [];
  for (const d of dependencies) {
    const hit = DEP_MAP[d] ?? DEP_MAP[d.toLowerCase()];
    if (!hit) continue;
    const [label, cat] = hit;
    if (cat === "framework" || cat === "frontend" || cat === "orm" || cat === "auth") frameworks.push(label);
    else if (cat === "db") databases.push(label);
    else externalServices.push(label);
  }
  // marker-file detection
  const relSet = new Set(files.map((f) => f.rel));
  const has = (re: RegExp) => files.some((f) => re.test(f.rel));
  if (has(/(^|\/)schema\.prisma$/)) {
    frameworks.push("Prisma");
    const prismaFile = files.find((f) => /(^|\/)schema\.prisma$/.test(f.rel))!;
    const prov = /provider\s*=\s*"(\w+)"/.exec(readText(prismaFile.abs));
    if (prov) databases.push({ postgresql: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite", mongodb: "MongoDB", sqlserver: "SQL Server", cockroachdb: "CockroachDB" }[prov[1]] ?? prov[1]);
  }
  if (has(/(^|\/)manage\.py$/)) frameworks.push("Django");
  if (has(/(^|\/)artisan$/)) frameworks.push("Laravel");
  if (has(/(^|\/)nest-cli\.json$/)) frameworks.push("NestJS");
  if (has(/(^|\/)next\.config\.(js|mjs|ts)$/)) frameworks.push("Next.js");
  if (has(/(^|\/)angular\.json$/)) frameworks.push("Angular");
  if (has(/(^|\/)config\/routes\.rb$/)) frameworks.push("Rails");
  if (has(/(^|\/)docker-compose\.ya?ml$/)) {
    const dc = files.find((f) => /(^|\/)docker-compose\.ya?ml$/.test(f.rel))!;
    const txt = readText(dc.abs);
    if (/image:\s*['"]?(postgres|postgis)/i.test(txt)) databases.push("PostgreSQL");
    if (/image:\s*['"]?(mysql|mariadb)/i.test(txt)) databases.push("MySQL");
    if (/image:\s*['"]?mongo/i.test(txt)) databases.push("MongoDB");
    if (/image:\s*['"]?redis/i.test(txt)) databases.push("Redis");
    if (/image:\s*['"]?(rabbitmq)/i.test(txt)) externalServices.push("RabbitMQ");
    if (/image:\s*['"]?(elasticsearch|opensearch)/i.test(txt)) externalServices.push("Elasticsearch");
    if (/image:\s*['"]?(minio)/i.test(txt)) externalServices.push("MinIO (S3)");
  }
  void relSet;

  const featureNames = uniq(files.filter((f) => !f.isTest).map((f) => f.feature)).sort();

  const index: ProjectIndex = {
    root,
    scannedAt: new Date().toISOString(),
    files,
    languages,
    frameworks: uniq(frameworks).sort(),
    manifests,
    externalServices: uniq(externalServices).sort(),
    databases: uniq(databases).sort(),
    totalLoc,
    featureNames,
    dependencies,
    name: projectName(root, manifests),
  };
  cache.set(root, index);
  return index;
}

export function sourceFiles(index: ProjectIndex, langs?: string[], includeTests = false): FileInfo[] {
  return index.files.filter((f) => (includeTests || !f.isTest) && (!langs || langs.includes(f.lang)));
}

/** Resolve a relative import specifier from a file to an indexed file (best effort). */
export function resolveImport(index: ProjectIndex, fromRel: string, spec: string): FileInfo | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  const candidates = [base, ...["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "php", "rb", "go"].map((e) => `${base}.${e}`), ...["ts", "tsx", "js", "jsx", "mjs", "py"].map((e) => `${base}/index.${e}`), `${base}/__init__.py`];
  const byRel = new Map(index.files.map((f) => [f.rel, f] as const));
  for (const c of candidates) {
    const hit = byRel.get(c) ?? byRel.get(c.replace(/\.js$/, ".ts"));
    if (hit) return hit;
  }
  return undefined;
}
