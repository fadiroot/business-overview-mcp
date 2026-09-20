import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Analysis, UseCase } from "../types.js";
import { endpointKey } from "../extractors/endpoints.js";

export const MODEL = process.env.BUSINESS_LENS_MODEL || "claude-opus-5";

const UseCaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  actors: z.array(z.string()),
  feature: z.string(),
  goal: z.string(),
  preconditions: z.array(z.string()),
  main_flow: z.array(z.string()),
  restrictions: z.array(z.string()),
  endpoints: z.array(z.string()),
  entities: z.array(z.string()),
  business_value: z.string(),
});

const RoleSchema = z.object({
  name: z.string(),
  description: z.string(),
  can: z.array(z.string()),
  cannot: z.array(z.string()),
  evidence: z.array(z.string()),
});

const RestrictionSchema = z.object({
  rule: z.string(),
  enforced_at: z.enum(["backend", "frontend", "both", "unclear"]),
  evidence: z.array(z.string()),
  risk: z.string().nullable(),
});

const FeatureAssessmentSchema = z.object({
  feature: z.string(),
  business_purpose: z.string(),
  status: z.enum(["core", "supporting", "questionable", "likely_unused"]),
  rationale: z.string(),
});

export const SynthesisSchema = z.object({
  executive_summary: z.string(),
  what_the_product_does: z.array(z.string()),
  actors: z.array(z.object({ name: z.string(), description: z.string(), is_human: z.boolean() })),
  roles: z.array(RoleSchema),
  use_cases: z.array(UseCaseSchema),
  restrictions: z.array(RestrictionSchema),
  feature_assessment: z.array(FeatureAssessmentSchema),
  over_build_signals: z.array(z.string()),
  open_questions_for_owner: z.array(z.string()),
});

export type Synthesis = z.infer<typeof SynthesisSchema>;

export interface SynthesisResult {
  ok: boolean;
  synthesis?: Synthesis;
  useCases?: UseCase[];
  model?: string;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null };
  truncated?: string[];
  error?: string;
  servedBy?: string;
}

const SYSTEM = `You are a senior business analyst and software architect. You receive machine-extracted facts about a codebase (features, endpoints with guards/roles/permissions, data entities and relations, role and permission definitions, access checks, and automated findings).

Your job is to explain the system to a non-technical business owner and to a new engineer at the same time:
- Derive real business use cases (what an actor achieves), not one per endpoint. Merge CRUD endpoints on the same resource into one or two use cases when they serve one goal. Name use cases as "<Actor> <verb> <object>" in plain language.
- Derive roles and, for each, what they can and cannot do, based only on the evidence. When the evidence is missing, say so ("no restriction found") instead of guessing.
- List restrictions (business rules on who may do what) and where they are enforced. Flag rules enforced only in the frontend as a risk.
- Assess each feature: core, supporting, questionable (unclear business purpose or duplicate) or likely unused (no endpoints, no references). Be candid about over-building: features, roles or entities that exist in code but seem unnecessary or unfinished.
- Finish with the questions the business owner needs to answer (e.g. "Should managers be able to delete orders? Today they can.").

Use file references given in the facts as evidence (e.g. "src/orders/orders.controller.ts:42"). Never invent endpoints, roles or files that are not in the facts. Keep language concrete and short.`;

function compactFacts(a: Analysis): { facts: unknown; truncated: string[] } {
  const truncated: string[] = [];
  const cap = <T>(arr: T[], n: number, label: string): T[] => { if (arr.length > n) truncated.push(`${label}: ${arr.length} → ${n}`); return arr.slice(0, n); };
  const facts = {
    project: { name: a.index.name, frameworks: a.index.frameworks, databases: a.index.databases, external_services: a.index.externalServices, languages: a.index.languages, total_loc: a.index.totalLoc },
    features: cap(a.features, 80, "features").map((f) => ({ name: f.name, files: f.files, loc: f.loc, endpoints: f.endpoints, entities: f.entities.slice(0, 15), paths: f.paths })),
    endpoints: cap(a.endpoints, 500, "endpoints").map((e) => ({ id: endpointKey(e), feature: e.feature, handler: e.handler, guards: e.guards.slice(0, 5), roles: e.roles, permissions: e.permissions, public: e.isPublic, at: `${e.source.file}:${e.source.line}` })),
    entities: cap(a.model.entities, 200, "entities").map((e) => ({ name: e.name, feature: e.feature, fields: e.fields.slice(0, 25).map((f) => `${f.name}:${f.type}${f.pk ? " PK" : ""}${f.fk ? ` FK→${f.fk}` : ""}`), at: `${e.source.file}:${e.source.line}` })),
    relations: cap(a.model.relations, 400, "relations").map((r) => `${r.from} ${r.kind} ${r.to}${r.field ? ` (${r.field})` : ""}`),
    roles: a.access.roles.map((r) => ({ name: r.name, defined_as: r.kind, raw: r.raw.slice(0, 4), at: r.sources.slice(0, 3).map((s) => `${s.file}:${s.line}`) })),
    permissions: cap(a.access.permissions, 150, "permissions").map((p) => ({ name: p.name, at: p.sources.slice(0, 2).map((s) => `${s.file}:${s.line}`) })),
    path_rules: a.access.pathRules.map((p) => ({ pattern: p.pattern, effect: p.effect, roles: p.roles, permissions: p.permissions, at: `${p.source.file}:${p.source.line}` })),
    backend_checks: cap(a.access.checks, 200, "backend_checks").map((c) => ({ kind: c.kind, roles: c.roles, permissions: c.permissions, feature: c.feature, snippet: c.snippet, at: `${c.source.file}:${c.source.line}` })),
    frontend_checks: cap(a.access.frontendChecks, 100, "frontend_checks").map((c) => ({ kind: c.kind, roles: c.roles, feature: c.feature, snippet: c.snippet, at: `${c.source.file}:${c.source.line}` })),
    access_matrix: a.access.matrix,
    heuristic_use_cases: cap(a.useCases, 200, "heuristic_use_cases").map((u) => ({ id: u.id, name: u.name, actors: u.actors, feature: u.feature, endpoints: u.endpoints, restrictions: u.restrictions })),
    automated_findings: a.findings.map((f) => ({ id: f.id, severity: f.severity, category: f.category, title: f.title, detail: f.detail })),
  };
  return { facts, truncated };
}

export function claudeAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE || process.env.HOME);
}

export async function synthesizeWithClaude(a: Analysis, focus?: string): Promise<SynthesisResult> {
  let client: Anthropic;
  try {
    client = new Anthropic();
  } catch (e) {
    return { ok: false, error: `Anthropic client could not be created: ${(e as Error).message}. Set ANTHROPIC_API_KEY or run "ant auth login".` };
  }
  const { facts, truncated } = compactFacts(a);
  const factsJson = JSON.stringify(facts);
  const userText = `${focus ? `Focus: ${focus}\n\n` : ""}Here are the extracted facts about the project "${a.index.name}" as JSON:\n\n${factsJson}\n\nProduce the structured analysis.`;
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: betaZodOutputFormat(SynthesisSchema) },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") return { ok: false, error: `Model declined the request (${msg.stop_details?.category ?? "unknown category"}).`, truncated };
    if (msg.stop_reason === "max_tokens") return { ok: false, error: "Output hit max_tokens before completing; try focusing on a single feature.", truncated };
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    let json: unknown;
    try { json = JSON.parse(text); } catch (e) { return { ok: false, error: `Model output was not valid JSON: ${(e as Error).message}`, truncated }; }
    const parsed = SynthesisSchema.safeParse(json);
    if (!parsed.success) return { ok: false, error: `Model output failed schema validation: ${parsed.error.message.slice(0, 500)}`, truncated };
    const s = parsed.data;
    const useCases: UseCase[] = s.use_cases.map((u, i) => ({
      id: u.id || `UC-${String(i + 1).padStart(3, "0")}`,
      name: u.name,
      actors: u.actors,
      feature: u.feature,
      action: u.goal,
      resource: u.entities[0] ?? "",
      endpoints: u.endpoints,
      entities: u.entities,
      restrictions: u.restrictions,
      description: `${u.goal}${u.business_value ? ` — ${u.business_value}` : ""}`,
      source: "claude",
    }));
    const servedBy = (msg.usage.iterations ?? []).some((it) => it.type === "fallback_message") ? msg.model : undefined;
    return { ok: true, synthesis: s, useCases, model: msg.model, usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens, cache_read_input_tokens: msg.usage.cache_read_input_tokens }, truncated, servedBy };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: "Authentication failed. Set ANTHROPIC_API_KEY (or run `ant auth login`) in the environment that starts this MCP server.", truncated };
    if (e instanceof Anthropic.RateLimitError) return { ok: false, error: "Rate limited by the Claude API; retry in a moment.", truncated };
    if (e instanceof Anthropic.BadRequestError) return { ok: false, error: `Bad request: ${e.message}`, truncated };
    if (e instanceof Anthropic.APIError) return { ok: false, error: `Claude API error ${e.status}: ${e.message}`, truncated };
    return { ok: false, error: String(e), truncated };
  }
}
