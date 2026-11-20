# First test: ten minutes, nothing touches your real projects

This walkthrough installs `code-intel`, plants three fake defects in a throwaway repository, and shows what a scan reports. Everything happens in a temporary directory that you delete at the end. Every command below was run as written against the published `0.1.0` package.

## 1. Install

```bash
npm install -g code-intelligence
brew install gitleaks semgrep osv-scanner
code-intel doctor
```

- `brew install gitleaks semgrep osv-scanner`: or see `code-intel doctor` for your OS

`doctor` must show `[ok]` for gitleaks, semgrep and osv-scanner. If one is missing it prints the exact install command. A missing engine is never skipped silently: a scan that needs it ends with exit code 3 (incomplete), not 0.

## 2. Create a throwaway project

Each block starts from its own `cd` and is one `&&` chain, so nothing runs if a step fails and nothing can touch another folder, even if you paste it into a terminal that is somewhere else. Step 1 deletes and recreates `/tmp/code-intel-demo`, so it is safe to repeat.

```bash
rm -rf /tmp/code-intel-demo &&
mkdir /tmp/code-intel-demo &&
cd /tmp/code-intel-demo &&
git init -q . &&
echo '{"name":"demo","version":"1.0.0","dependencies":{"lodash":"4.17.15"}}' > package.json &&
echo '{"name":"demo","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"demo","version":"1.0.0","dependencies":{"lodash":"4.17.15"}},"node_modules/lodash":{"version":"4.17.15","resolved":"https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz"}}}' > package-lock.json &&
git add -A &&
git commit -q --no-verify -m base
```

`--no-verify` skips any global pre-commit hook you may have installed, which is unrelated to this tool and would block the demo commit.

## 3. Plant the defects

```bash
cd /tmp/code-intel-demo &&
KEY="AKIA$(printf 'QYLPMN5HHHFPZAM2')" &&
printf 'const key = "%s";\nconst result = eval(req.query.expr);\n' "$KEY" > app.js &&
echo "" >> package-lock.json
```

- `KEY="AKIA$(printf 'QYLPMN5HHHFPZAM2')"`: a fake AWS-shaped key, assembled at run time
- `echo "" >> package-lock.json`: touch the lockfile so dependencies are in scope

Two details that matter:

- **Do not use AWS's documented example key** (`AKIAIOSFODNN7EXAMPLE`). Scanners deliberately ignore it, so the scan would report nothing and look broken.
- **Dependency scanning only runs when a lockfile or manifest is part of the change.** That is why the lockfile is touched. Without it the scan reports the dependency check as skipped, with the reason.

## 4. Scan

```bash
cd /tmp/code-intel-demo && code-intel scan; echo "exit code: $?"
```

Expected (versions and advisory ids will differ over time):

```text
Engines
  [FOUND  ] gitleaks ...    1 finding(s)
  [FOUND  ] semgrep ...     2 finding(s)
  [FOUND  ] osv-scanner ... 5 finding(s)

Findings
  HIGH     app.js:1  [gitleaks +semgrep] aws-access-token
  HIGH     package-lock.json  [osv-scanner] GHSA-...        (lodash 4.17.15)
  MEDIUM   app.js:2  [semgrep] ...eval-detected
  ...
Result: FAIL (exit 1): findings at or above 'high'.
```

Things to notice:

- The key is reported **once**, credited to both engines (`[gitleaks +semgrep]`), and its value is never printed.
- Each finding has a severity, a location, an explanation and a `fix:` line.
- The exit code is 1 because there are findings at or above `--fail-on` (default `high`).

## 5. Other views

```bash
code-intel scan --format json
code-intel scan --format sarif
code-intel scan --staged
code-intel scan --engines secrets
code-intel doctor --json
```

- `code-intel scan --format json`: stable schema for agents and CI
- `code-intel scan --format sarif`: for GitHub code scanning
- `code-intel scan --staged`: only what is staged (pre-commit)
- `code-intel scan --engines secrets`: one category only
- `code-intel doctor --json`: machine-readable engine status

Optional, slower, JavaScript/TypeScript only: `code-intel impact` (which tests a change affects) and `code-intel mutate` (would your tests notice a behavior change). See the [CLI reference](cli.md).

## 6. Use it from your agent

```bash
npx code-intelligence-skills install --agent claude
```

- `npx code-intelligence-skills install --agent claude`: or codex, opencode, pi, gentle-shell

Then ask your agent, explicitly: _"Use the code-intelligence skill to check my changes."_ Vague requests such as "is this safe?" may be answered with the agent's own built-in tools instead; see the compatibility notes in [code-intelligence-skills](https://github.com/micio86dev/code-intelligence-skills/tree/main/docs/integrations).

## 7. Clean up

```bash
npx code-intelligence-skills uninstall --agent claude
npm uninstall -g code-intelligence
rm -rf /tmp/code-intel-demo
```

The result cache lives in your user cache directory (`code-intel doctor` prints the path) and is safe to delete.

## Reading the exit code

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Complete scan, nothing at or above `--fail-on`                          |
| 1    | Findings at or above `--fail-on`                                        |
| 2    | Usage or configuration error                                            |
| 3    | **Incomplete**: an engine is missing, timed out or crashed. Not a pass. |
