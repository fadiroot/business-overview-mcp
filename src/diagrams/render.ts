import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

/** mermaid.live "pako" link for instant viewing/editing. */
export function mermaidLiveUrl(source: string, view = false): string {
  const state = JSON.stringify({ code: source, mermaid: JSON.stringify({ theme: "default" }), autoSync: true, updateDiagram: true });
  const compressed = zlib.deflateSync(Buffer.from(state, "utf8"), { level: 9 });
  const b64 = compressed.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `https://mermaid.live/${view ? "view" : "edit"}#pako:${b64}`;
}

/** Kroki renders Mermaid and PlantUML to SVG server-side (no local install). */
export function krokiUrl(source: string, kind: "mermaid" | "plantuml", fmt: "svg" | "png" = "svg"): string {
  const compressed = zlib.deflateSync(Buffer.from(source, "utf8"), { level: 9 });
  const b64 = compressed.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return `https://kroki.io/${kind}/${fmt}/${b64}`;
}

const PLANTUML_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
function plantumlEncode(buf: Buffer): string {
  let out = "";
  for (let i = 0; i < buf.length; i += 3) {
    const b1 = buf[i], b2 = buf[i + 1] ?? 0, b3 = buf[i + 2] ?? 0;
    out += PLANTUML_ALPHABET[(b1 >> 2) & 0x3f] + PLANTUML_ALPHABET[((b1 & 0x3) << 4) | ((b2 >> 4) & 0xf)] + PLANTUML_ALPHABET[((b2 & 0xf) << 2) | ((b3 >> 6) & 0x3)] + PLANTUML_ALPHABET[b3 & 0x3f];
  }
  return out;
}

export function plantumlServerUrl(source: string, fmt: "svg" | "png" = "svg"): string {
  const deflated = zlib.deflateRawSync(Buffer.from(source, "utf8"), { level: 9 });
  return `https://www.plantuml.com/plantuml/${fmt}/${plantumlEncode(deflated)}`;
}

export function mermaidHtml(title: string, source: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;padding:24px;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a}@media(prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}}h1{font-size:18px;margin:0 0 16px}.wrap{overflow:auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px}@media(prefers-color-scheme:dark){.wrap{background:#111a2e;border-color:#1e293b}}pre{display:none}</style></head>
<body><h1>${escapeHtml(title)}</h1><div class="wrap"><pre class="mermaid">${escapeHtml(source)}</pre></div>
<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";mermaid.initialize({startOnLoad:false,securityLevel:"loose",theme:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"default",maxTextSize:900000,maxEdges:4000});const el=document.querySelector(".mermaid");el.style.display="block";await mermaid.run({nodes:[el]});</script></body></html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function hasMmdc(): boolean {
  try { const r = spawnSync(process.platform === "win32" ? "where" : "which", ["mmdc"], { encoding: "utf8" }); return r.status === 0 && !!r.stdout.trim(); } catch { return false; }
}

export function renderWithMmdc(mmdPath: string, outPath: string): { ok: boolean; error?: string } {
  try {
    const r = spawnSync("mmdc", ["-i", mmdPath, "-o", outPath, "-b", "transparent"], { encoding: "utf8", timeout: 60_000 });
    return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || "").slice(0, 500) };
  } catch (e) { return { ok: false, error: String(e) }; }
}

export interface WrittenDiagram { sourcePath: string; htmlPath?: string; svgPath?: string; liveUrl?: string; krokiUrl?: string; plantumlUrl?: string }

export function writeDiagram(outDir: string, baseName: string, source: string, format: "mermaid" | "plantuml", title: string, render: boolean): WrittenDiagram {
  fs.mkdirSync(outDir, { recursive: true });
  const ext = format === "mermaid" ? "mmd" : "puml";
  const sourcePath = path.join(outDir, `${baseName}.${ext}`);
  fs.writeFileSync(sourcePath, source, "utf8");
  const out: WrittenDiagram = { sourcePath };
  if (format === "mermaid") {
    out.htmlPath = path.join(outDir, `${baseName}.html`);
    fs.writeFileSync(out.htmlPath, mermaidHtml(title, source), "utf8");
    if (source.length < 12_000) out.liveUrl = mermaidLiveUrl(source);
    if (source.length < 30_000) out.krokiUrl = krokiUrl(source, "mermaid");
    if (render && hasMmdc()) { const svg = path.join(outDir, `${baseName}.svg`); const r = renderWithMmdc(sourcePath, svg); if (r.ok) out.svgPath = svg; }
  } else {
    if (source.length < 30_000) { out.plantumlUrl = plantumlServerUrl(source); out.krokiUrl = krokiUrl(source, "plantuml"); }
  }
  return out;
}
