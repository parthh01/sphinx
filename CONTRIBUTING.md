# Contributing to Sphinx

Use Node.js 22.19+, install the pinned dependencies with `npm ci`, and run `npm test`. Tests must not call real models, change real agent settings, or modify a developer's global Git configuration. The test runner blocks outbound Node requests while permitting local fixtures.

Keep trigger policy deterministic and separate from model judgment. Preserve existing hooks. Filter paths before reading code. New integrations need isolated install/uninstall tests and clear coverage limitations.

The most useful assessment contributions are small, reproducible change fixtures with:

1. A baseline and patch with no private data.
2. The observable behavior or invariant a developer should understand.
3. A bounded question with stated assumptions.
4. Accepted answers and causal reasoning, including valid alternative explanations.
5. Common misconceptions and a new scenario that tests transfer after teaching.

Question-quality evaluation should include ambiguous questions and cases where an answer correctly identifies a bug. Do not grade on naming trivia, prose style, or similarity to a single model-written answer.

Run `npm run eval -- --out /tmp/sphinx-eval.json` for the deterministic fixture baseline. Use the separately authorized, bounded live workflow in [eval/README.md](eval/README.md) to measure model quality. Retain generated questions, source evidence, grading probes, and request/cost totals when comparing changes. Never answer a real human checkpoint as part of testing.

Before proposing a stronger model or additional model calls, measure whether the change improves the assessment enough to justify its usage. Keep model selection explicit and avoid silent paid fallback.

## Releases

Every push to `main` that passes the tests publishes to npm from that exact commit, through the `release` job in `.github/workflows/test.yml`. The version is the next minor after npm's latest, so 0.1.13 is followed by 0.2.0. To choose another version, such as a major or a patch, set `version` in `package.json` higher than every version published so far; one that is not higher than npm's latest is ignored. If npm's `latest` tag is ever moved back by hand, the next minor may already exist, and npm refuses it until `package.json` is set above the newest published version.

The job writes the version, and the commit as `gitHead`, into its own checkout and never writes to the repository: no commits and no tags. A release therefore cannot trigger another run, and `package.json` in the repository stays behind npm. npm records the commit each version was built from, so re-running the job for a published commit does nothing. Installed copies pin the Action that `sphinx init --github-check` sets up to that commit, so never rewrite `main`'s history. A run whose commit is no longer the tip of `main` skips and leaves the release to the newer commit's run. If that run fails, re-run it or push again; a commit whose message contains `[skip ci]` starts no run, so nothing is published until the next push.

Publishing uses npm trusted publishing, with no token or secret. It needs a one-time setup:

1. On GitHub, open the repository's **Settings**, **Environments**, **New environment**, and name it `npm`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add the branch `main`. It needs no secrets.
2. On npmjs.com, open the `sphinx-understand` package, then **Settings**, **Trusted publishing**, **GitHub Actions**, and enter owner `parthh01`, repository `sphinx`, workflow filename `test.yml`, and environment `npm`.

npm then accepts only the `npm` environment, which only `main` can use, so a workflow edited on another branch cannot publish. Renaming `test.yml`, the environment, or the repository stops publishing until these settings and the job match again. Without the npm setting, the release job fails without publishing; re-run it once the setting is saved.
