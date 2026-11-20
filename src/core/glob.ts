/**
 * Glob matcher for repo-relative POSIX paths, with no dependencies and no regular expressions.
 *
 * Why not a regex: patterns can come from an untrusted repository's configuration, and a regex built
 * from a hostile glob can run for minutes (JavaScript has no regex timeout). Capping the wildcard count
 * only lowers the polynomial degree. This matcher is a dynamic program over (pattern tokens x path
 * characters), so its cost is O(tokens x path length) for any input.
 *
 * Syntax: `**` (any characters including `/`), `**` followed by `/` (zero or more directories), `*` (any
 * characters except `/`), `?` (one character except `/`), `[abc]` / `[a-z]` / `[!abc]`, and `{a,b}`.
 * A pattern without `/` matches that name at any depth (gitignore-style), and a match on a directory
 * excludes everything beneath it.
 */

type Tok =
  | { t: "lit"; c: string }
  | { t: "any" }
  | { t: "cls"; neg: boolean; items: Array<[string, string]> }
  | { t: "star" }
  | { t: "gstar" }
  | { t: "gslash" };

export const MAX_GLOB_LENGTH = 200;
export const MAX_DOUBLE_STAR = 3;
const MAX_WILDCARDS = 12;
const MAX_BRACE_EXPANSIONS = 32;

/** Expand non-nested `{a,b}` alternatives. Unbalanced braces stay literal. */
function expandBraces(p: string): string[] {
  if (p.split("{").length !== p.split("}").length) return [p];
  const open = p.indexOf("{");
  if (open === -1) return [p];
  let depth = 0;
  let close = -1;
  for (let i = open; i < p.length; i++) {
    if (p[i] === "{") depth += 1;
    else if (p[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [p];
  const parts: string[] = [];
  let cur = "";
  depth = 0;
  for (const ch of p.slice(open + 1, close)) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const head = p.slice(0, open);
  const tail = p.slice(close + 1);
  const out: string[] = [];
  for (const part of parts) {
    for (const rest of expandBraces(`${part}${tail}`)) {
      out.push(`${head}${rest}`);
      if (out.length > MAX_BRACE_EXPANSIONS) throw new Error("too many brace alternatives");
    }
  }
  return out;
}

function tokenize(p: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < p.length) {
    const ch = p[i] as string;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          toks.push({ t: "gslash" });
          i += 3;
        } else {
          toks.push({ t: "gstar" });
          i += 2;
        }
      } else {
        toks.push({ t: "star" });
        i += 1;
      }
    } else if (ch === "?") {
      toks.push({ t: "any" });
      i += 1;
    } else if (ch === "[") {
      const close = p.indexOf("]", i + 2);
      if (close === -1) {
        toks.push({ t: "lit", c: "[" });
        i += 1;
      } else {
        let body = p.slice(i + 1, close);
        const neg = body.startsWith("!") || body.startsWith("^");
        if (neg) body = body.slice(1);
        const items: Array<[string, string]> = [];
        for (let k = 0; k < body.length; k++) {
          const a = body[k] as string;
          if (body[k + 1] === "-" && k + 2 < body.length) {
            items.push([a, body[k + 2] as string]);
            k += 2;
          } else items.push([a, a]);
        }
        toks.push({ t: "cls", neg, items });
        i = close + 1;
      }
    } else {
      toks.push({ t: "lit", c: ch });
      i += 1;
    }
  }
  return toks;
}

function classHas(tok: Extract<Tok, { t: "cls" }>, ch: string): boolean {
  const hit = tok.items.some(([a, b]) => ch >= a && ch <= b);
  return tok.neg ? !hit : hit;
}

/** O(tokens x path length): reach[j] means "the tokens so far can consume path[0..j)". */
function matchTokens(toks: readonly Tok[], path: string): boolean {
  const n = path.length;
  let reach = new Uint8Array(n + 1);
  reach[0] = 1;
  for (const tok of toks) {
    const next = new Uint8Array(n + 1);
    let any = false;
    switch (tok.t) {
      case "lit":
        for (let j = 0; j < n; j++) if (reach[j] && path[j] === tok.c) next[j + 1] = 1;
        break;
      case "any":
        for (let j = 0; j < n; j++) if (reach[j] && path[j] !== "/") next[j + 1] = 1;
        break;
      case "cls":
        for (let j = 0; j < n; j++) {
          const ch = path[j] as string;
          if (reach[j] && ch !== "/" && classHas(tok, ch)) next[j + 1] = 1;
        }
        break;
      case "star": {
        let on = false;
        for (let k = 0; k <= n; k++) {
          on = Boolean(reach[k]) || (on && k > 0 && path[k - 1] !== "/");
          if (on) next[k] = 1;
        }
        break;
      }
      case "gstar": {
        let on = false;
        for (let k = 0; k <= n; k++) {
          on = on || Boolean(reach[k]);
          if (on) next[k] = 1;
        }
        break;
      }
      case "gslash": {
        let seen = false;
        for (let k = 0; k <= n; k++) {
          if (k > 0 && reach[k - 1]) seen = true;
          if (reach[k] || (seen && k > 0 && path[k - 1] === "/")) next[k] = 1;
        }
        break;
      }
    }
    for (let j = 0; j <= n; j++) {
      if (next[j]) {
        any = true;
        break;
      }
    }
    if (!any) return false;
    reach = next;
  }
  // The pattern may end at the path's end or at a directory boundary (everything beneath matches).
  for (let j = 0; j <= n; j++) if (reach[j] && (j === n || path[j] === "/")) return true;
  return false;
}

function normalize(pattern: string): string {
  let p = pattern.replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

const WILD = /[*?[\]{}]/;

export function compileGlobs(patterns: readonly string[]): (path: string) => boolean {
  const names = new Set<string>(); // bare literal names: `node_modules`
  const suffixes: string[] = []; // bare `*.ext` patterns
  const general: Tok[][] = [];
  for (const raw of patterns) {
    let alternatives: string[];
    try {
      alternatives = expandBraces(normalize(raw));
    } catch {
      alternatives = [normalize(raw)]; // validation rejects these; never throw while matching
    }
    for (const p of alternatives) {
      if (!p.includes("/")) {
        if (!WILD.test(p)) {
          names.add(p);
          continue;
        }
        if (p.startsWith("*") && !p.startsWith("**") && !WILD.test(p.slice(1))) {
          suffixes.push(p.slice(1));
          continue;
        }
        general.push(tokenize(`**/${p}`));
      } else {
        general.push(tokenize(p.replace(/^\//, "")));
      }
    }
  }
  return (path) => {
    if (names.size > 0 || suffixes.length > 0) {
      for (const seg of path.split("/")) {
        if (names.has(seg)) return true;
        for (const s of suffixes) if (seg.length >= s.length && seg.endsWith(s)) return true;
      }
    }
    for (const toks of general) if (matchTokens(toks, path)) return true;
    return false;
  };
}

/** A path or pattern is unsafe if it is absolute or climbs out of the repo. */
export function isSafeGlob(pattern: string): boolean {
  const p = pattern.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
  return !p.split("/").includes("..");
}

/** Why a user-supplied glob must be rejected, or null if it is fine. */
export function globProblem(pattern: string): string | null {
  if (!isSafeGlob(pattern)) return "must be relative and must not contain '..'";
  if (pattern.length > MAX_GLOB_LENGTH) return `must be at most ${MAX_GLOB_LENGTH} characters`;
  const collapsed = pattern.replace(/(?:\*\*\/){2,}/g, "**/");
  if ((collapsed.match(/\*\*/g) ?? []).length > MAX_DOUBLE_STAR) {
    return `must use '**' at most ${MAX_DOUBLE_STAR} times`;
  }
  if ((collapsed.match(/[*?{[]/g) ?? []).length > MAX_WILDCARDS) {
    return `must use at most ${MAX_WILDCARDS} wildcard characters`;
  }
  try {
    expandBraces(normalize(pattern));
  } catch {
    return `must not expand to more than ${MAX_BRACE_EXPANSIONS} brace alternatives`;
  }
  return null;
}
