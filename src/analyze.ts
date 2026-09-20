import type { Analysis } from "./types.js";
import { buildIndex } from "./indexer.js";
import { extractDataModel } from "./extractors/schema.js";
import { extractEndpoints } from "./extractors/endpoints.js";
import { extractAccessModel } from "./extractors/access.js";
import { buildFeatures, computeFindings, heuristicUseCases } from "./analysis/model.js";
import { synthesizeWithClaude, type Synthesis, type SynthesisResult } from "./analysis/claude.js";

const cache = new Map<string, Analysis>();
const synthCache = new Map<string, { synthesis: Synthesis; result: SynthesisResult }>();

export async function getAnalysis(root: string, refresh = false): Promise<Analysis> {
  const index = await buildIndex(root, refresh);
  if (!refresh && cache.has(index.root)) return cache.get(index.root)!;
  const model = extractDataModel(index);
  const endpoints = extractEndpoints(index);
  const access = extractAccessModel(index, endpoints);
  const features = buildFeatures(index, model, endpoints);
  const useCases = heuristicUseCases(endpoints, model, access);
  const findings = computeFindings(index, model, endpoints, access, features);
  const analysis: Analysis = { index, model, endpoints, access, features, useCases, findings };
  cache.set(index.root, analysis);
  if (refresh) synthCache.delete(index.root);
  return analysis;
}

/** Run (or reuse) the Claude synthesis. Returns the analysis with Claude use cases swapped in when successful. */
export async function getSynthesis(root: string, refresh = false, focus?: string): Promise<{ analysis: Analysis; result: SynthesisResult }> {
  const analysis = await getAnalysis(root, refresh);
  const key = `${analysis.index.root}|${focus ?? ""}`;
  if (!refresh && synthCache.has(key)) { const c = synthCache.get(key)!; return { analysis: withClaudeUseCases(analysis, c.result), result: c.result }; }
  const result = await synthesizeWithClaude(analysis, focus);
  if (result.ok && result.synthesis) synthCache.set(key, { synthesis: result.synthesis, result });
  return { analysis: withClaudeUseCases(analysis, result), result };
}

function withClaudeUseCases(a: Analysis, r: SynthesisResult): Analysis {
  if (!r.ok || !r.useCases?.length) return a;
  return { ...a, useCases: r.useCases };
}
