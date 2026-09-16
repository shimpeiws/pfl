# pfl

> pfl — Pre-Flight Listen for coding-agent harnesses

Inspect a coding-agent harness before it runs: what's registered as
skills, hooks, instructions, and memory, and how it's wired together.

_Named after the pre-fade listen button on a mixing console — the one you
press to hear a channel before it hits the house._

`pfl` statically inspects the harness configuration surrounding a coding
agent and answers three questions:

1. What harness elements exist?
2. How are they resolved by the target runtime?
3. What can theoretically affect the agent's process or output right now?

It does not execute the target agent, and it does not run discovered tools,
skills, hooks, or MCP servers. It reconstructs the effective harness from
files, runtime configuration, scope rules, precedence, and known runtime
semantics. The first supported runtimes are `claude-code` and `codex`.

`pfl` belongs to the same tool family as [`yuurei`](https://github.com/shimpeiws/yuurei),
which isolates and executes: `pfl` inspects before execution, `yuurei` runs it
in an isolated environment, and a future Analyzer compares harness changes
against outcomes.

## Status

**v0.1.** `pfl` implements static inspection end to end for `claude-code` and
`codex`:

- `pfl inspect` discovers a runtime's harness, resolves it, and stores immutable
  observed and resolved snapshots.
- `pfl report`, `pfl list`, and `pfl show` interpret the stored snapshot.
- `pfl graph` renders provenance and resolution.
- `pfl diff` compares two snapshots structurally, by effective state, and by
  semantic facet.

It never executes the runtime, discovered tools, skills, hooks, or MCP servers.
See the [design document](docs/design/pfl-design-v0.1.md) for the full design.

## Commands

```sh
pfl inspect --runtime claude-code
pfl inspect --runtime codex

pfl report
pfl report --snapshot <id>

pfl list
pfl list --facet actions
pfl list --origin user
pfl list --status shadowed

pfl show <element-id>

pfl graph
pfl graph --snapshot <id>

pfl snapshots

pfl diff <snapshot-a> <snapshot-b>
```

The default snapshot for read commands is `latest`.

## Exit codes

| Code | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Success                                                                        |
| 2    | Configuration error — a missing or invalid argument                            |
| 3    | Runtime unsupported — the requested runtime id is unknown                      |
| 4    | Inspection failed — an unexpected error during inspection                      |
| 5    | Consent required — a read outside the project needs consent and none was given |
| 6    | Snapshot store failure — writing or reading `~/.pfl/` failed                   |

## Examples

The output below is real, from inspecting a small project with a `CLAUDE.md`, a
user `~/.claude/CLAUDE.md`, and one skill.

```text
$ pfl inspect --runtime claude-code

Inspecting Claude Code harness...

Observed        4 elements
Effective       4
Conditional     0
Shadowed        0
Opaque layers   1

Snapshot
  observed   obs_633c7f61defd
  resolved   res_dbc9364a88c4

Run:
  pfl report
  pfl graph
  pfl diff
```

```text
$ pfl report

Harness Report
Claude Code · shimpeiws/pfl

Effective elements      4
Shadowed                0
Conditional             0
Opaque runtime layers   1

Semantic facets
  Instructions  3
  Knowledge     1
  Memory        0
  Actions       1
  Delegation    0
  Controls      0

Notable
  1 runtime-provided instruction layer(s) are opaque
```

```text
$ pfl list
el_cff282ddc0b14d10  instructions  project  effective  instructions
el_e53975ad56eddb00  instructions  user     effective  instructions
el_9e0c49bbd513d2c5  skills        user     effective  knowledge,actions
el_e411b87f4f06ceaf  runtime-provided-instructions  builtin  effective  instructions
```

```text
$ pfl show el_cff282ddc0b14d10

Element el_cff282ddc0b14d10
  kind            instructions
  origin          project (project)
  source          CLAUDE.md  sha256:a6917d46c2…
  inspectability  observable
  status          effective
  activation      always
  applicability   project
  resolution      accumulate — accumulates with the other layers
  facets          instructions  [high] defines agent behavior
```

```text
$ pfl graph

user
├─ ~/.claude/CLAUDE.md
└─ ~/.claude/skills/bar/SKILL.md

project
└─ CLAUDE.md
   └─ accumulates → ~/.claude/CLAUDE.md

builtin
└─ (builtin) claude-code instruction layers (opaque)

effective
├─ instructions
│  ├─ (builtin) claude-code instruction layers (opaque)
│  ├─ CLAUDE.md
│  └─ ~/.claude/CLAUDE.md
├─ knowledge
│  └─ ~/.claude/skills/bar/SKILL.md
└─ actions
   └─ ~/.claude/skills/bar/SKILL.md
```

```text
$ pfl snapshots
1 snapshot(s) for shimpeiws/pfl:
obs_633c7f61defd  res_dbc9364a88c4  2026-09-16T06:24:43.542Z  claude-code@unknown  complete

$ pfl diff res_dbc9364a88c4 res_dbc9364a88c4

Harness Diff
Snapshot res_dbc9364a88c4 → res_dbc9364a88c4

Changes
  + 0 added
  - 0 removed
  ~ 0 changed

Effective changes
  + 0 newly effective
  - 0 no longer effective
  ~ 0 activation changed

Semantic impact
  Instructions  0
  Knowledge     0
  ...
```

Findings and diffs describe structure; `pfl` never says whether a harness is
good or bad.

## Consent and storage

Project-local discovery is implicit. Reading anything outside the project — your
`~/.claude` / `~/.codex` user scope, and the installed runtime's version metadata
— requires explicit, persisted consent. A non-interactive run without it fails
closed with exit code 5 rather than assuming consent.

Consent is stored per runtime + scope in `~/.pfl/permissions.json`. Snapshots are
written under `~/.pfl/projects/<project-id>/` as immutable, atomically published
files:

```text
~/.pfl/
  permissions.json
  projects/<project-id>/
    observations/     observed facts (obs_…)
    snapshots/        resolved facts (res_…)
    interpretations/  reserved
    latest            {"observed":"obs_…","resolved":"res_…"}
```

`pfl` persists existence, structure, relationships, digests, and allowlisted
metadata only. It never stores raw instruction or memory content, secrets,
environment values, or command arguments, and it never writes inside the
inspected repository.

## Development

Node.js `>=22` and pnpm `11.6.0` (this repository pins both with
[mise](https://mise.jdx.dev/); `mise install` sets them up).

```sh
pnpm install
pnpm test              # vitest run
pnpm run check         # oxlint --deny-warnings
pnpm run format        # oxfmt --check
pnpm run build         # tsc --build (type check)
pnpm run typecheck:test # tsc -p tsconfig.test.json
pnpm run knip          # unused exports
```

## Releasing

Publishing is tag-driven and runs only from CI
(`.github/workflows/release.yml`), never from a developer machine.

Prerequisites, once:

1. The repository is public (npm provenance is generated from a public source).
2. A **trusted publisher** is configured for `@shimpeiws/pfl` on npmjs.com:
   GitHub user `shimpeiws`, repository `pfl`, workflow `release.yml`,
   environment `npm`. No npm token is stored — publishing uses GitHub OIDC.

To cut a release:

```sh
# bump "version" in package.json, then:
git tag v<version>
git push origin v<version>
```

The workflow re-runs every gate, checks that the tag matches the package
version, inspects and smoke-installs the tarball, then publishes with
`npm publish --access public` (provenance attached automatically).

## Learn more

See the [design document](docs/design/pfl-design-v0.1.md) for the full
design.
