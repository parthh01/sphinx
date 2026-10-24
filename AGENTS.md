# Sphinx

Sphinx helps developers retain understanding of agent-assisted changes. Keep assessment policy provider-neutral. Use Node.js 22.19+ and the embedded Pi coding-agent SDK for the reviewer session, tool loop, and native compaction. Keep the Pi SDK and model transport dependencies pinned to the reviewed versions in package.json and package-lock.json.

- Git decides when a checkpoint is required; an independent evaluator writes and grades questions.
- Never inherit the coding conversation into an assessment. Use committed/staged evidence and a fresh isolated reviewer session. Codex/Claude routes are isolated model transports underneath Pi, not persistent native reviewer sessions.
- Keep Pi's discovered project resources and general-purpose tools disabled. Sphinx owns filtered immutable Git tools, exact evidence archives, project context, counted usage, and explicitly configured request caps; do not add a parallel custom agent loop or compactor.
- Model-call caps are optional and default to null. Preserve explicit user limits; size-based planning targets must not become hidden request caps. Context, output, tool-page, and timeout limits remain enforced.
- Assess consequences, failure modes, and invariants. A wrong answer leads to an explanation and a new transfer question when the grader supplies a usable one; otherwise the same question stays open.
- Never treat model errors or ambiguous questions as successful completion.
- Bind completion to exact Git content, destination, and policy. Agent and Git integrations share that state.
- Preserve existing hooks/settings. Install and uninstall must be idempotent and reversible.
- Do not install into a developer's real home or change global Git config during tests. Use temporary directories and explicit test environments.
- Use node:test for meaningful behavior and real temporary Git repositories for Git integration tests.
- Build a clear, polished terminal interface with explanatory options, restrained colors, and an ASCII sphinx. The user explicitly requested this visual direction. Keep JSON and hook protocol output machine-readable; honor NO_COLOR, non-TTY output, and narrow terminals.

Run `npm test` before finishing changes.
