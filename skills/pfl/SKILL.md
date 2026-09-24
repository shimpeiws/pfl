---
name: pfl
description: Static, read-only inspection of a coding-agent harness (Claude Code, Codex, OpenCode). Reconstructs what skills, subagents, commands, hooks, MCP servers, instructions, and memory a runtime actually resolves, without executing the agent. Use when the user asks to inspect or audit their agent harness, list the skills or commands or hooks an agent loads, explain why an element is partial or shadowed, compare two harness snapshots, or says things like inspect my agent harness, why is pfl partial, list the skills my agent loads, what hooks does my agent have, or what changed in my agent config.
---

# pfl

Pre-Flight Listen for coding-agent harnesses.

## What it is

`pfl` **statically** inspects the harness configuration surrounding a coding
agent (Claude Code, Codex, OpenCode) and reconstructs the effective harness
without executing the agent. It does not run discovered tools, skills, hooks,
or MCP servers. It never modifies discovered files.

Three questions it answers:

1. What harness elements exist?
2. How are they resolved by the target runtime?
3. What can theoretically affect the agent's process or output right now?

## Install

```sh
npm install -g @shimpeiws/pfl
# or
npx @shimpeiws/pfl
```

The binary is `pfl`. Supported runtimes: `claude-code`, `codex`, `opencode`.

## Static workflow

1. **Inspect** — discover the harness, resolve it, store immutable snapshots:

   ```sh
   pfl inspect --runtime claude-code
   ```

2. **Interpret** — read the stored snapshot:

   ```sh
   pfl report                  # summary
   pfl list                    # all elements
   pfl list --facet actions    # filter by facet
   pfl list --origin user      # filter by origin
   pfl list --status shadowed  # filter by status
   pfl show <element-id>       # drill into one element
   ```

3. **Export** — the full sanitized IR (Observed + Resolved + Interpretation +
   relations + findings, joined by element id) as one document, for a
   downstream agent that would otherwise need `list` followed by `show` per
   element:

   ```sh
   pfl export --json
   ```

4. **Compare** — structural, effective, and facet-level diff:

   ```sh
   pfl diff <snapshot-a> [snapshot-b]
   ```

5. **Render** — provenance and resolution graph:

   ```sh
   pfl graph
   ```

6. **Manage** — list snapshots, reclaim old ones:

   ```sh
   pfl snapshots
   pfl gc --dry-run
   pfl gc --keep 10 --prune-orphans
   ```

The default snapshot for read commands is `latest` — the newest run across all
runtimes. The literal `latest` is accepted anywhere an id is. Scope `latest`
to one runtime with `--runtime <id>` on `report`, `list`, `show`, `graph`,
`export`, or `diff` when the store mixes runtimes.

`pfl list` and `pfl graph` can be verbose on a real harness — hundreds of
elements and thousands of lines, which costs tens of thousands of tokens as
`--json`. Prefer the filters (`--kind`, `--facet`, `--origin`, `--status`,
`--scope` on `graph`, `--limit` on `list`) over printing the whole document.

Common recipes:

```sh
pfl list --kind skills --origin project --origin user   # what skills load?
pfl list --kind hooks --status effective                # what hooks are active?
pfl list --kind subagents                               # what subagents exist?
pfl list --status shadowed                              # what is shadowed?
pfl list --kind mcp-configuration                       # what MCP servers?
pfl show <mcp-element-id>                               # …and the server names inside
pfl graph --status effective --json                     # the effective harness only
```

## Consent and the user scope

Project-local discovery is implicit. Reading anything outside the project — the
user harness (`~/.claude`, `~/.codex`) and installation metadata — requires
explicit consent, per runtime + scope. A non-interactive run that lacks the
user scope exits 5 rather than guessing. Grant it for one run:

```sh
pfl inspect --runtime claude-code --allow-scope claude-code:user
```

Persistent grants are stored in `~/.pfl/permissions.json`.

## Machine-readable output

Every output-producing command accepts `--json` and writes exactly one JSON
envelope to stdout. Failures emit the same envelope with `ok: false`. Check
`completeness` for partial results (not `ok`). The full contract is in
[references/json-contract.md](references/json-contract.md).

## Invariants

- **Read-only.** Never modifies discovered harness files.
- **No execution.** Never executes the runtime, tools, skills, hooks, or MCP
  servers.
- **Static first.** Do not execute the runtime to inspect it.
- **No symlink/hardlink traversal.** Symlinks are recorded but never followed.
- **Deny-by-default persistence.** Only allowlisted fields persist. Raw
  instructions, secrets, and environment values are never stored.
- **Immutable snapshots.** Existing ids are never overwritten.
- **Best effort, never silently incomplete.** Unreadable or unknown elements
  are recorded, not ignored.

See [references/invariants.md](references/invariants.md) for the full list.

## When not to use

- To execute or dry-run the agent.
- To score output quality or rank ROI.
- To infer semantics from natural language via LLM.
- To convert between runtimes.
- To reconstruct opaque runtime-provided instructions.

These are deliberate non-goals.
