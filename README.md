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

## Development

Node.js `>=22` and pnpm `11.6.0` (this repository pins both with
[mise](https://mise.jdx.dev/); `mise install` sets them up).

```sh
pnpm install
pnpm test              # vitest run
pnpm run check         # oxlint --deny-warnings
pnpm run format        # oxfmt --check
pnpm run build         # tsc --build (type check)
pnpm run knip          # unused exports
```

## Learn more

See the [design document](docs/design/pfl-design-v0.1.md) for the full
design.
