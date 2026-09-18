# pfl

Pre-Flight Listen for coding-agent harnesses. A CLI that **statically**
inspects the harness configuration surrounding a coding agent (Claude Code,
Codex) and reconstructs the effective harness without executing the agent.

Full design: [`docs/design/pfl-design-v0.1.md`](docs/design/pfl-design-v0.1.md).
That document is authoritative. When the summary below and the design doc
disagree, the design doc is right.

## Status

v0.1. Static inspection is implemented end to end for `claude-code`, `codex`,
and `opencode`: discovery, four-dimension resolution, the deterministic facet
classifier and descriptive findings, immutable snapshot storage, and rendering
(`inspect`, `report`, `list`, `show`, `graph`, `diff`, `snapshots`). M4b
(inferred graph) and M5 (Analyzer integration) remain deferred; see
`docs/design/pfl-design-v0.1.md`.

v1.0's security-hardening milestone (**M6**) is complete: reads outside the
project are consent-gated and fail closed, symlinks and hardlinks are never
followed, resource ceilings bound every walk and parse, every persisted or
displayed field passes the allowlist or the redaction layer, the consent wording
is derived from the read-path inventory, and the security-ops baseline (CI
scans, the `security-review` required check, the `security-auditor` agent, and
`docs/security/`) is in place.

v1.0's harness-depth milestone (**M7**) is complete: a shared frontmatter parser
resolves skills, subagents, commands, rules, output styles, and memory files; the
Claude Code and Codex adapters reach their real discovery surfaces (managed
scope, `.mcp.json`, plugins, hooks, the `CLAUDE.md`/`AGENTS.md` trees,
project-scoped skills, and the full `config.toml` section surface); and kind
assignments, dead kinds, version handling, and the classification and findings
gaps are settled.

v1.0's interface-and-schema milestone (**M8**) is complete: stored artifacts and
the command documents are frozen, interpretations are persisted, the version
knobs and root index/gc are in place, and consent is split into scopes with a
headless grant path and a single choke point.

v1.0's OpenCode milestone (**M9**) is complete: the shared adapter scaffold was
extracted, the semantic layer (facet mappings and finding kinds) opened to
adapters, adapter registration unified, and the OpenCode adapter added end to
end. Its read paths join the M6 inventory and the choke-point test runs over the
extended inventory. M10 (release preparation) remains; it carries the items M6
deferred plus the OpenCode model reconciliation (#144). See
`docs/design/pfl-roadmap-v1.0.md`.

## Commands

```sh
pnpm test              # vitest run
pnpm run check         # oxlint --deny-warnings
pnpm run format        # oxfmt --check
pnpm run build         # tsc --build (type check)
pnpm run knip          # unused exports
```

Prefer targeted test files over the full suite locally (`pnpm test <path>`).
Node and pnpm are pinned with mise (`mise install`).

## Invariants

These are guarantees the implementation is expected to uphold. A change that
breaks one is a defect, not a tradeoff. The normative wording is the design
document's Security Model; the list below is a working summary.

- **Read-only.** `pfl` never modifies discovered harness files.
- **No execution.** `pfl` never executes the runtime, discovered tools,
  skills, scripts, hooks, or MCP servers.
- **Static first.** Do not execute the runtime in order to inspect it.
- **Resolution over listing.** Explain not only what exists, but how the
  runtime resolves it.
- **Do not infer more than can be supported.** Opaque or unknown behavior is
  recorded as such, never guessed.
- **No symlink traversal.** Symlinks are recorded (`status: "skipped"`,
  `reason: "symlink-not-followed"`) but never followed.
- **Consent boundary.** Project-local discovery is implicit. Reading outside
  the project requires explicit consent, stored per runtime + scope.
- **Persistence is deny-by-default.** Persist existence, structure,
  relationships, safe metadata, and digests only. Never persist raw
  instructions, memory, or knowledge content; secrets; auth headers; tokens;
  passwords; environment values; or arbitrary command arguments.
- **Safe metadata allowlist.** Each adapter explicitly defines which metadata
  fields may be persisted; unknown fields are not persisted automatically.
- **Best effort, never silently incomplete.** Unreadable, unsupported,
  skipped, or unknown elements are recorded, not ignored, and do not abort
  the inspection.
- **Newer-than-verified runtimes do not block.** Collect observed facts, produce
  resolved facts best-effort, attach a visible warning, and downgrade
  resolution confidence.
- **Snapshots are immutable.** Observation events are distinguished from
  harness state. Store state under `~/.pfl/`, never inside the inspected
  project.

## Out of scope (Non-Goals)

v0.1 deliberately does **not** provide these. When reviewing, do not raise them
as findings; if they are relevant, name them as deferred:

- agent execution or dry-run execution
- tool, skill, hook, or MCP execution
- output-quality scoring, ROI ranking, or automatic harness optimization
- LLM-based classification or semantic dependency inference from natural
  language
- cross-runtime harness conversion
- full reconstruction of opaque runtime-provided instructions
- remote/cloud inventory aggregation
