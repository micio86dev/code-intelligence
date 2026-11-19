/**
 * Minimal glob matcher for repo-relative POSIX paths (no dependencies).
 * Supports `**`, `*`, `?`, `{a,b}` and character classes `[abc]`.
 * A pattern without a `/` matches that name at any depth (gitignore-style),
 * and a match on a directory name excludes everything below it.
 */

function escapeRe(ch: string): string {
  return ch.replace(/[.+^$()|\\]/g, "\\$&");
}

function translate(pattern: string): string {
  let out = "";
  let i = 0;
  let braceDepth = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const slashAfter = pattern[i + 2] === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 3 : 2;
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if (ch === "{") {
      braceDepth += 1;
      out += "(?:";
      i += 1;
    } else if (ch === "}" && braceDepth > 0) {
      braceDepth -= 1;
      out += ")";
      i += 1;
    } else if (ch === "," && braceDepth > 0) {
      out += "|";
      i += 1;
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
        i += 1;
      } else {
        out += `[${pattern.slice(i + 1, close).replace(/\\/g, "\\\\")}]`;
        i = close + 1;
      }
    } else {
      out += escapeRe(ch);
      i += 1;
    }
  }
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  const anchoredDir = p.endsWith("/");
  if (anchoredDir) p = p.slice(0, -1);
  const hasSlash = p.includes("/");
  const body = translate(hasSlash ? p.replace(/^\//, "") : `**/${p}`);
  // Match the entry itself or anything beneath it (directory exclusion).
  return new RegExp(`^${body}(?:/.*)?$`);
}

export function compileGlobs(patterns: readonly string[]): (path: string) => boolean {
  const res = patterns.map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}

/** A pattern is unsafe if it is absolute or climbs out of the repo. */
export function isSafeGlob(pattern: string): boolean {
  const p = pattern.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
  return !p.split("/").includes("..");
}
