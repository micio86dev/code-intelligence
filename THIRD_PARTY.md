# Third-party notices

`code-intelligence` bundles **no** third-party code at runtime (zero runtime dependencies). It _invokes_ the following tools if you install them; each remains under its own license and is not redistributed here. Versions are those the project was developed and tested against.

| Tool                  | Used for                                  | License                                                                                                               | Project                                       |
| --------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| gitleaks 8.30.1       | secrets                                   | MIT                                                                                                                   | https://github.com/gitleaks/gitleaks          |
| Semgrep 1.186.0 (CLI) | SAST                                      | LGPL-2.1 (engine); rulesets carry their own licenses (the Semgrep registry rules are under the Semgrep Rules License) | https://github.com/semgrep/semgrep            |
| OSV-Scanner 2.7.1     | dependency vulnerabilities                | Apache-2.0                                                                                                            | https://github.com/google/osv-scanner         |
| Trivy 0.76.1          | dependency vulnerabilities (fallback)     | Apache-2.0                                                                                                            | https://github.com/aquasecurity/trivy         |
| ast-grep 0.51.3       | architecture rules                        | MIT                                                                                                                   | https://github.com/ast-grep/ast-grep          |
| CodeGraph 1.2.0       | test impact (optional)                    | MIT                                                                                                                   | https://github.com/colbymchenry/codegraph     |
| StrykerJS 10.1.1      | mutation testing (project dev dependency) | Apache-2.0                                                                                                            | https://github.com/stryker-mutator/stryker-js |

Development-only dependencies: TypeScript (Apache-2.0), `@types/node` (MIT), Biome (MIT/Apache-2.0).

License identifiers above are as published by each project at the time of writing; check the upstream repositories for the authoritative text.
