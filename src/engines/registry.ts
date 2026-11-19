import { astGrep } from "./ast-grep.ts";
import type { Engine } from "./engine.ts";
import { gitleaks } from "./gitleaks.ts";
import { osvScanner } from "./osv-scanner.ts";
import { semgrep } from "./semgrep.ts";
import { trivy } from "./trivy.ts";

/** Every engine the CLI knows. Order is irrelevant; category + priority decide selection. */
export const ENGINES: readonly Engine[] = [gitleaks, semgrep, osvScanner, trivy, astGrep];
