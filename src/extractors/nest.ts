import type { FileInfo } from "../types.js";
import { joinPath, lineOf, matchBracket, stringLiterals } from "../util.js";
import { decoratorGuards, type Draft } from "./endpoints.js";

const HTTP_DECOS = /^(Get|Post|Put|Patch|Delete|All|Head|Options)$/;
const GQL_DECOS = /^(Query|Mutation|Subscription)$/;

interface Deco { name: string; args: string; start: number; end: number }

/** Read a run of decorators starting at `pos` (skipping whitespace). Returns decorators and the position after them. */
function readDecorators(text: string, pos: number, limit: number): { decos: Deco[]; pos: number } {
  const decos: Deco[] = [];
  let i = pos;
  while (i < limit) {
    const ws = /^\s*/.exec(text.slice(i, i + 200))?.[0].length ?? 0;
    i += ws;
    if (text[i] !== "@") break;
    const nm = /^@([\w.]+)/.exec(text.slice(i, i + 80));
    if (!nm) break;
    let end = i + nm[0].length;
    let args = "";
    if (text[end] === "(") { const close = matchBracket(text, end); if (close === -1) break; args = text.slice(end + 1, close); end = close + 1; }
    decos.push({ name: nm[1].split(".").pop()!, args, start: i, end });
    i = end;
  }
  return { decos, pos: i };
}

export function nest(text: string, f: FileInfo, out: Draft[]) {
  const classRe = /\bclass\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(text))) {
    // Decorator block directly before the class (allow export/default/abstract keywords)
    const before = text.slice(0, m.index);
    const kw = /(?:\s*(?:export|default|abstract)\s*)*$/.exec(before);
    const blockEnd = m.index - (kw?.[0].length ?? 0);
    // walk backwards over decorators: find the earliest '@' such that readDecorators from there ends at blockEnd
    let blockStart = blockEnd;
    let scan = blockEnd;
    for (let guard = 0; guard < 30; guard++) {
      const prev = text.lastIndexOf("@", scan - 1);
      if (prev === -1) break;
      const between = text.slice(prev, blockEnd);
      const r = readDecorators(text, prev, blockEnd + 1);
      const consumed = text.slice(r.pos, blockEnd).trim();
      if (r.decos.length && consumed === "" && !/[;{}]/.test(between.replace(/\([^)]*\)/g, ""))) { blockStart = prev; scan = prev; } else break;
    }
    if (blockStart === blockEnd) continue;
    const { decos: classDecos } = readDecorators(text, blockStart, blockEnd + 1);
    const ctrl = classDecos.find((d) => d.name === "Controller" || d.name === "Resolver");
    if (!ctrl) continue;
    const isResolver = ctrl.name === "Resolver";
    const prefix = isResolver ? "" : stringLiterals(ctrl.args)[0] ?? "";
    const classGuards = decoratorGuards(classDecos.filter((d) => d !== ctrl).map((d) => `@${d.name}(${d.args})`).join("\n"));
    const open = text.indexOf("{", m.index + m[0].length);
    const end = matchBracket(text, open);
    if (end === -1) continue;
    const className = m[1];

    // Iterate decorator runs inside the class body; a run that contains an HTTP/GraphQL decorator followed by a method name is an endpoint.
    let pos = open + 1;
    while (pos < end) {
      const at = text.indexOf("@", pos);
      if (at === -1 || at >= end) break;
      // skip '@' inside strings / parameter decorators: only consider '@' that starts a line (after whitespace) or follows ')' / '}' / ';'
      const lineStart = text.lastIndexOf("\n", at) + 1;
      const prefixOnLine = text.slice(lineStart, at);
      if (prefixOnLine.trim() !== "" && !/[)};]\s*$/.test(prefixOnLine)) { pos = at + 1; continue; }
      const r = readDecorators(text, at, end);
      if (!r.decos.length) { pos = at + 1; continue; }
      const http = r.decos.find((d) => (isResolver ? GQL_DECOS : HTTP_DECOS).test(d.name));
      if (!http) { pos = r.pos; continue; }
      const nameM = /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(/.exec(text.slice(r.pos, r.pos + 300));
      const methodName = nameM?.[1] ?? "unknown";
      const g = decoratorGuards(r.decos.filter((d) => d !== http).map((d) => `@${d.name}(${d.args})`).join("\n"));
      const pathLit = stringLiterals(http.args)[0] ?? "";
      const method = isResolver ? (http.name === "Query" ? "QUERY" : http.name === "Mutation" ? "MUTATION" : "SUBSCRIPTION") : http.name.toUpperCase();
      const gqlName = isResolver ? (/name\s*:\s*['"](\w+)['"]/.exec(http.args)?.[1] ?? methodName) : "";
      const pth = isResolver ? `/graphql/${gqlName}` : joinPath(prefix, pathLit);
      const explicitPublic = g.isPublic || (classGuards.isPublic && !g.hasAuth) ? true : undefined;
      const guards = explicitPublic ? ["@Public"] : [...classGuards.guards, ...g.guards];
      out.push({ method, path: pth, handler: `${className}.${methodName}`, framework: "NestJS", file: f.rel, line: lineOf(text, http.start), guards, roles: explicitPublic ? [] : [...classGuards.roles, ...g.roles], permissions: explicitPublic ? [] : [...classGuards.perms, ...g.perms], explicitPublic, feature: f.feature });
      pos = nameM ? r.pos + nameM.index + nameM[0].length : r.pos;
    }
  }
}
