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

Every push to `main` that passes the tests is released to npm by the `release` job in `.github/workflows/test.yml`.

The version is the next patch after npm's `latest`, so 0.1.13 is followed by 0.1.14. For a minor or major release, set `version` in `package.json` above npm's `latest` in a normal pull request, and that version is published as it is. Nothing is published at or below npm's `latest`. A version npm already has, or whose `v<version>` tag names another commit, is skipped for the next patch. Each release becomes npm's `latest`, even when npm has a higher version under another tag.

For each release, the job:

1. Commits the new version to `main` as `Release <version> [skip ci]`, by `github-actions[bot]`, changing only the version in `package.json` and `package-lock.json`. A version set by hand needs no release commit.
2. Tags the commit it publishes `v<version>`.
3. Pushes the commit and tag in one atomic push. If `main` moved on meanwhile, the push is rejected, nothing is published, and the newer commit's run releases.
4. Publishes that commit with npm trusted publishing and provenance, then checks that npm recorded it.

A release commit follows every merge, so pull before pushing to `main` directly.

A release commit never starts another release:

- The job's own token pushes it, and GitHub starts no workflow run for that.
- Its `[skip ci]` skips push runs whatever pushed it.
- The job skips any commit npm's `latest` was published from or already contains. Resetting `main` back to a released commit therefore releases nothing; push a revert instead.

Never connect an integration that commits to `main` whenever `main` changes, such as a badge, changelog or formatting bot, unless its commits say `[skip ci]`. Each of its commits would release a version, and each release commit would set it off again. Your own commit whose message contains `[skip ci]` starts no run either, and neither does a squash merge whose pull request's commit messages quote it. It is released with the next commit, or with **Run workflow** below.

If publishing fails, or the job is cancelled, after the push, `main` ends at a tagged commit whose version npm does not have, and no run starts for a release commit. Fix the cause, then open **Actions**, **Test**, **Run workflow** on `main`. That run publishes the version from that commit, reusing its tag, with no new commit. Re-running the failed job does nothing, and its log says to use **Run workflow**. If another commit reaches `main` first, its release skips the unpublished version and publishes the next patch.

Installed copies pin the Action that `sphinx init --github-check` sets up to their version's tag, so never move or delete release tags. `main` and `v*` tags must stay pushable by `github-actions`: branch protection, or a ruleset on `main` or on tags, that blocks its push stops releases, and each release job then fails without publishing.

Publishing uses npm trusted publishing, with no token or secret. It needs a one-time setup:

1. On GitHub, open the repository's **Settings**, **Environments**, **New environment**, and name it `npm`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add the branch `main`. It needs no secrets.
2. On npmjs.com, open the `sphinx-understand` package, then **Settings**, **Trusted publishing**, **GitHub Actions**, and enter owner `parthh01`, repository `sphinx`, workflow filename `test.yml`, and environment `npm`.

npm then accepts only the `npm` environment, which only `main` can use, so a workflow edited on another branch cannot publish. Renaming `test.yml`, the environment, or the repository stops publishing until these settings match again. Without the npm setting, the first release commit and tag are pushed and the publish fails; save the setting, then use **Run workflow**.
