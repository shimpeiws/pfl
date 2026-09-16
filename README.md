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

**Scaffold.** The repository currently contains the toolchain, the domain
model from the design document, and a CLI whose commands are not yet
implemented. See the [design document](docs/design/pfl-design-v0.1.md) for
the full plan and milestones.

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
| 7    | Not implemented — the command exists but carries no logic yet (scaffold only)  |

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
