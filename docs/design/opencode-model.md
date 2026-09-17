# OpenCode scope, origin, and path model

- **Status:** investigation complete; input to the M8 freeze. M9 implements the
  adapter against this document and does not alter it.
- **Runtime:** OpenCode **1.18.30**
  (`/opt/homebrew/bin/opencode` → `…/Cellar/opencode/1.18.30/bin/opencode`,
  Homebrew formula `anomalyco/tap/opencode`, build dated 2026-09-09).
- **Verified range:** `>= 1.18.0` (yuurei verified 1.18.0 and 1.18.30; this
  document verifies 1.18.30 only).
- **Version pinned:** 2026-09-17.
- **Issue:** [#78](https://github.com/shimpeiws/pfl/issues/78); milestone M8,
  design references `pfl-roadmap-v1.0.md` §5 (M8, ordering constraints) and
  `pfl-design-v0.1.md` §11 (Resolution Model), §12 (Builtin), §31 (Initial
  Discovery Scope).
- **Read-only:** no configuration file was written. Every layout probe that
  could create or read runtime state ran under a throwaway `HOME`/`XDG_*`/`TMPDIR`;
  the real installation was otherwise only read (`--help`, `debug paths`,
  `debug info`). See §0.

## 0. Evidence basis and its limits

Each claim below carries one of three tags:

| Tag              | Meaning                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **[installed]**  | Observed on the installed 1.18.30 binary: `--help`/`debug` output, or an isolated run against a throwaway `HOME` and `XDG_*` home. |
| **[yuurei]**     | Prior evidence in the sibling project's adapter and spike (verified on 1.18.0 and 1.18.30). Re-verified here where relied on.    |
| **[upstream]**   | The vendor's published documentation (`opencode.ai/docs/*`, schema `opencode.ai/config.json`). Not reproducible from this host.   |

Where the documentation and the installed binary could disagree, the installed
binary wins and the document says so. Two structural sources are quoted from the
installation itself:

- `opencode debug paths` — the resolved roots [installed].
- `opencode debug skill` — the binary ships a built-in `customize-opencode`
  skill whose body documents the file locations and merge rules. Its output is
  the runtime describing its own layout, so it is treated as installed evidence
  about 1.18.30, not as third-party prose [installed].

**Limit of the claim.** Most of this document rests on **one** observed
installation (macOS arm64, 1.18.30). It supports "present in 1.18.30", not
"present in every OpenCode version" and not "cannot exist". The managed-file and
remote layers could not be exercised on this host (no MDM, no org provider); they
are marked **[upstream]** and must be re-checked when the verified range moves
(§10). The same caution the M7 note applies to Codex's withdrawn kinds applies
here: absence of a surface in one installation is not proof of its absence.

The isolated probe (reproducible, no user config touched) was:

```sh
ROOT=$TMPDIR/ocprobe
# throwaway HOME with decoy global config, project config, .opencode/, AGENTS.md
HOME=$ROOT/home XDG_CONFIG_HOME=$ROOT/home/.config XDG_DATA_HOME=$ROOT/home/.local/share \
  XDG_STATE_HOME=$ROOT/home/.local/state XDG_CACHE_HOME=$ROOT/home/.cache \
  TMPDIR=$ROOT/tmp OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
  opencode debug config
```

## 1. Roots

OpenCode resolves every root from the XDG base-directory variables, with `HOME`
and `TMPDIR` fallbacks. `opencode debug paths` is authoritative [installed]:

| Root   | Path (this host)                                         | Derivation                     |
| ------ | -------------------------------------------------------- | ------------------------------ |
| home   | `$HOME`                                                  | `HOME`                         |
| config | `$XDG_CONFIG_HOME/opencode` (`~/.config/opencode`)       | `XDG_CONFIG_HOME` → `~/.config`|
| data   | `$XDG_DATA_HOME/opencode` (`~/.local/share/opencode`)    | `XDG_DATA_HOME`                |
| state  | `$XDG_STATE_HOME/opencode` (`~/.local/state/opencode`)   | `XDG_STATE_HOME`               |
| cache  | `$XDG_CACHE_HOME/opencode` (`~/.cache/opencode`)         | `XDG_CACHE_HOME`               |
| bin    | `$XDG_CACHE_HOME/opencode/bin`                           | cache                          |
| log    | `$XDG_DATA_HOME/opencode/log`                            | data                           |
| repos  | `$XDG_DATA_HOME/opencode/repos`                          | data                           |
| tmp    | `$TMPDIR/opencode` (falls back to `/tmp/opencode`)       | `TMPDIR`                       |

`TMPDIR` is a real redirection the adapter owns: it does not follow `HOME`
[yuurei, re-verified]. The probe confirmed every root moved under the throwaway
home. The `config` root is the "user scope" of §4; the runtime never reads a
`~/.opencode/` directory [installed, built-in skill].

## 2. Configuration file locations and search order

Two naming forms are accepted everywhere: `opencode.json` and `opencode.jsonc`
(JSONC: comments and trailing commas) [upstream; both parsed by the same loader].
Config sources are **deep-merged**, later overriding earlier for conflicting
keys; non-conflicting keys are preserved. Order [upstream; local half verified
installed §0]:

| # | Source                            | Path                                                                              | Origin    | Tag          |
| - | --------------------------------- | --------------------------------------------------------------------------------- | --------- | ------------ |
| 1 | Remote (organizational defaults)  | `.well-known/opencode` on the provider's host                                     | remote    | [upstream]   |
| 2 | Global (user)                     | `$XDG_CONFIG_HOME/opencode/opencode.json[c]`                                      | user      | [installed]  |
| 3 | Custom file                       | `$OPENCODE_CONFIG` (arbitrary path)                                               | custom    | [installed]  |
| 4 | Project                           | `<project>/opencode.json[c]`, walking up from cwd to the git/worktree root        | project   | [installed]  |
| 5 | Project `.opencode/` directory    | `<project>/.opencode/opencode.json[c]` (+ element subdirs, §4)                    | project   | [installed]  |
| 6 | Inline                            | `$OPENCODE_CONFIG_CONTENT` (JSON string)                                          | custom    | [installed]  |
| 7 | Managed file                      | macOS `/Library/Application Support/opencode/opencode.json[c]`; Linux `/etc/opencode/` | managed   | [upstream]   |
| 8 | macOS managed preferences (MDM)   | `/Library/Managed Preferences/<user>/ai.opencode.managed.plist` (or `/Library/Managed Preferences/…`) | managed   | [upstream]   |

`OPENCODE_CONFIG_DIR` names an additional directory searched for agents,
commands, modes, and plugins "just like the standard `.opencode` directory",
loaded **after** the global config and `.opencode/`, so it can override them
[upstream; the agents subdir was confirmed loaded installed]. `OPENCODE_TUI_CONFIG`
points at a separate TUI-only config (`tui.json[c]`); UI chrome is outside the
harness boundary (§7) and is not modelled.

Verified precedence behaviours (isolated probe, §0):

- Global `model` was overridden by project `model`; a global-only `instructions`
  key survived the merge → **merge, not replace**.
- Root `opencode.json` and `.opencode/opencode.json` were both loaded; on
  conflict the `.opencode/` value won (`model: DOTOPENCODE/marker`) → #5 above
  #4, matching the documented order.
- `$OPENCODE_CONFIG`'s `small_model` was preserved while the project's `model`
  won → #4 above #3.
- `$OPENCODE_CONFIG_CONTENT`'s `username` won over every on-disk local source →
  #6 is the highest local scope.
- Project lookup stopped at the `.git` marker: a config one directory **above**
  the git root was not read from a nested cwd.

**Invalid config is fatal.** Unknown top-level keys are rejected with
`ConfigInvalidError` rather than ignored [installed, built-in skill; upstream].
For `pfl` this is a diagnostic-worthy condition, not a reason to abort an
inspection (best-effort invariant).

## 3. Project config discovery

Project-scoped lookup walks **up** from the current directory and stops at the
nearest Git/worktree root [upstream; stop confirmed installed]. That means more
than the config file is found along the way: skills discovery walks the same path
and loads `.opencode/skills`, `.claude/skills`, and `.agents/skills` from each
directory up to the worktree root [upstream]. The OpenCode model therefore has a
`directory-subtree` applicability axis (§6), not only a flat project scope.

## 4. Element source surfaces

### 4.1 User scope (requires consent; under `$XDG_CONFIG_HOME/opencode`)

| Surface                | Path                                                                            | Tag                    |
| ---------------------- | ------------------------------------------------------------------------------- | ---------------------- |
| Instructions           | `AGENTS.md` (fallback `~/.claude/CLAUDE.md`)                                     | [installed]            |
| Agents / subagents     | `agent(s)/<name>.md`                                                             | [installed]            |
| Commands               | `command(s)/<name>.md`                                                           | [installed]            |
| Skills                 | `skill(s)/<name>/SKILL.md`                                                       | [installed]            |
| Plugins (local)        | `plugin(s)/*.ts`, `plugin(s)/*.js` (auto-discovered; no config entry needed)     | [installed]            |
| Modes (legacy)         | `mode(s)/`                                                                       | [installed, built-in skill] |
| Tools                  | `tool(s)/`                                                                       | [installed, built-in skill] |
| Themes (UI)            | `theme(s)/`                                                                      | [installed, built-in skill] |
| Cross-runtime skills   | `~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md`           | [installed]            |
| npm plugins            | `plugin` array in a config file (npm spec, pinned spec, path, `file://`, tuple)  | [upstream]             |
| MCP servers            | `mcp` key in a config file                                                       | [installed]            |
| Permissions / policy   | `permission` key                                                                 | [installed]            |
| Model / provider       | `model`, `small_model`, `provider`, `disabled_providers`, `enabled_providers`    | [installed]            |
| Instructions (extra)   | `instructions` array: paths/globs relative to the declaring config, or URLs       | [installed]            |

Plural and singular subdirectory names are both accepted; the plural form is the
documented current spelling and the singular form is kept for compatibility
[upstream; both accepted installed].

### 4.2 Project scope (implicit; under the project root)

The same element directories, under `<project>/.opencode/`, plus the
Claude/agent-compatible surfaces that OpenCode loads directly from the project:

| Surface                       | Path                                                         | Tag         |
| ----------------------------- | ------------------------------------------------------------ | ----------- |
| Instructions                  | `AGENTS.md` (fallback `CLAUDE.md`), walked up from cwd       | [installed] |
| Extra instructions            | `instructions` array in the project config                   | [installed] |
| Agents / subagents            | `.opencode/agent(s)/<name>.md`                               | [installed] |
| Commands                      | `.opencode/command(s)/<name>.md`                             | [installed] |
| Skills                        | `.opencode/skill(s)/<name>/SKILL.md`                         | [installed] |
| Cross-runtime skills          | `.claude/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md` | [installed] |
| Plugins (local)               | `.opencode/plugin(s)/*.ts`, `*.js`                           | [installed] |
| MCP servers                   | `mcp` key in `opencode.json[c]`                              | [installed] |
| Permissions / model / config  | the config keys of §2, §7                                    | [installed] |

**Claude-compat is narrower than Claude Code's own surface.** OpenCode reads
Claude skills and the `CLAUDE.md` rules fallback, but does **not** read Claude
Code's `.mcp.json`: a probe placed a `.mcp.json` with an MCP server in the
project root and `opencode debug config` still reported `mcp: null` [installed].
MCP is configured only through `opencode.json` `mcp` or a provided plugin.

## 5. The scope model against `NativeOrigin`

`NativeOrigin` (`src/core/observed.ts:11`) is
`project | user | managed | plugin | builtin | unknown`. Every OpenCode surface
found maps onto a member of that union; nothing on disk needs a seventh member.

| OpenCode layer                                          | `NativeOrigin` | `scope` (free string)            | Notes |
| ------------------------------------------------------- | -------------- | -------------------------------- | ----- |
| Project `opencode.json`, `.opencode/**`, project `AGENTS.md`/`CLAUDE.md` | `project`  | `project`                        | The walk up to the git root stays project-local. |
| Global `~/.config/opencode/**`                          | `user`         | `user`                           | |
| `~/.claude/skills`, `~/.agents/skills`, `~/.claude/CLAUDE.md` | `user`   | `claude-compat` / `agents-compat`| Location-based origin; the cross-runtime provenance is carried by `scope`, not by a new origin. |
| Project `.claude/skills`, `.agents/skills`, `CLAUDE.md` | `project`      | `claude-compat` / `agents-compat`| Same reasoning. |
| Managed file `/Library/Application Support/opencode/…`  | `managed`      | `managed-file`                   | [upstream] |
| macOS MDM `ai.opencode.managed` plist                   | `managed`      | `managed-preferences`            | [upstream] |
| Plugin-provided elements (npm module or local plugin)   | `plugin`       | `plugin`                         | A plugin's *contents* are opaque; the elements it declares are `plugin` origin. A local `.opencode/plugins/*.ts` file is itself `project`. |
| Built-in agents, built-in skill, built-in tools, default catalog | `builtin` | `builtin`                 | Compiled into the binary; `inspectability` is `known-runtime-provided` or `opaque`. |
| Remote `.well-known/opencode` org defaults              | `unknown`      | `remote-org`                        | Not statically readable (network + org auth). Modelled as a known-runtime-provided opaque layer with a diagnostic; see §9. |
| `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG_CONTENT` | `unknown` | `invocation-override`        | Supplied by the run's environment, which `pfl` cannot know statically. Recorded as an opaque/unknown layer, never guessed. |

Element identity is `runtime + origin + path` (`src/core/ids.ts:88`), so the
OpenCode adapter's view of `~/.claude/skills/x` and the Claude Code adapter's
view are different `ElementId`s (different `runtimeId`). Cross-runtime import
needs no identity change.

## 6. Resolution semantics — the four axes

The resolver separates Native source, Applicability, Resolution semantics, and
Activation (design doc §11). OpenCode's behaviour on each [installed unless
noted]:

### Native source

`project | user | managed | plugin | builtin | unknown`, as mapped in §5.
Managed configuration overrides everything and is not user-overridable
[upstream].

### Applicability

| Value                | OpenCode surface                                                                |
| -------------------- | ------------------------------------------------------------------------------- |
| `global`             | `~/.config/opencode/AGENTS.md`, global config keys                               |
| `project`            | project `opencode.json`, `.opencode/**`, project `AGENTS.md`                      |
| `directory-subtree`  | a nested `AGENTS.md`/`CLAUDE.md` and skills found along the walk to the git root |
| `tool-event`         | `permission.bash` patterns; plugin hook events                                   |
| `config-rule`        | `permission` patterns, `references`, `instructions` globs                        |
| `runtime-defined`    | built-in agent permission rulesets                                               |
| `unknown`            | remote/invocation layers                                                          |

### Resolution semantics

| Value             | OpenCode evidence                                                                 | Verified? |
| ----------------- | --------------------------------------------------------------------------------- | --------- |
| `override`        | config deep-merge, later source wins; same-name agent/command: project overrides global | [installed] |
| `accumulate`      | agents, commands, and skills from every scope appear in the merged catalog; `instructions` files combine | [installed] |
| `available`       | skills are loaded on demand through the `skill` tool; `references` are consultable on demand | [installed] |
| `policy`          | `permission` (allow/ask/deny, pattern objects; `external_directory` for paths outside the project) | [installed] |
| `event-pipeline`  | plugin hooks (`chat.*`, `tool.execute.*`, `permission.ask`, …)                    | [installed] |
| `runtime-defined` | built-in tool/agent defaults                                                     | [installed] |

**Skill-name collisions behave differently from agent/command collisions.**
With the same name defined in both global and project scope, the agent and the
command resolved to the **project** definition, but the skill resolved to the
**global** definition [installed]. The documentation requires skill names to be
unique across locations, so this is an observed tie-break, not a contract; M9
should record a duplicate-name diagnostic rather than depend on either winner.

### Activation

| Value          | OpenCode surface                                                        |
| -------------- | ----------------------------------------------------------------------- |
| `always`       | `AGENTS.md` / `instructions` — in context every session                  |
| `on-demand`    | skills (skill tool), commands (user-invoked), references                 |
| `conditional`  | permissions (`ask`/`deny`), `enabled` flags on MCP servers               |
| `event-driven` | plugin hooks                                                            |
| `unknown`      | remote/invocation layers                                                 |

## 7. Element kinds and the six facets

The six facets are `instructions | knowledge | memory | actions | delegation |
controls` (`src/core/facets.ts:6`). Mapping the OpenCode kinds found:

| OpenCode kind                          | Proposed `kind`                                                                 | Facet(s)                       |
| -------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| `AGENTS.md`, fallback `CLAUDE.md`, `instructions` entries | `instructions` (existing)                          | `instructions`                 |
| skills (`.opencode/skills`, `.claude/skills`, `.agents/skills`) | `skills` (existing)                        | `knowledge`, `actions`         |
| commands                               | `commands` (existing)                                                            | `actions`                      |
| agents, `mode: subagent`               | `subagents` (existing)                                                           | `delegation`                   |
| agents, `mode: primary`                | `agents` (new kind; M9)                                                          | `delegation` / `controls`      |
| MCP servers (`mcp`)                    | `mcp-configuration` (existing)                                                   | `actions`                      |
| `permission`                           | `permissions` (existing)                                                         | `controls`                     |
| `model`, `small_model`, `provider*`    | `model-configuration` (existing)                                                 | `controls`                     |
| `compaction`, `tool_output`            | `compaction-controls` (existing)                                                 | `controls`                     |
| `shell`                                | `shell-environment` (existing)                                                   | `controls`                     |
| project config scalars (`share`, `snapshot`, `autoupdate`, `default_agent`, `subagent_depth`, `watcher`, `username`) | `project-configuration` (existing) | `controls` |
| local/npm plugins                      | `plugin` (existing)                                                              | `knowledge`, `actions`, `delegation`, `controls` |
| custom tools (`tool(s)/`, `tools` key) | `tools` (new kind; M9)                                                           | `actions`                      |
| `references` (local dirs / git repos)  | `references` (new kind; M9)                                                      | `knowledge`                    |
| `formatter`, `lsp`                     | `tooling-configuration` (new kind; M9)                                           | `controls`                     |
| built-in agents / skill / tools        | `runtime-provided-instructions` (existing) or `runtime-provided` (new; M9)       | `instructions` (opaque)        |
| themes, keybinds, TUI                  | **not modelled** — UI chrome, outside the harness boundary (design doc §5)        | —                              |

**No seventh facet is required.** `references` → `knowledge`, `tools` →
`actions`, `formatter`/`lsp` → `controls`: all are covered by the existing six.
`memory` has no OpenCode surface found in this installation; that is a
"not present in 1.18.30" observation, not a claim that OpenCode has none.

Some kinds are new strings (`agents`, `tools`, `references`,
`tooling-configuration`), but `kind` is a plain `string` on `ObservedElement`
(`src/core/observed.ts:63`), so new kinds need no core type change — only rows in
`FACETS_BY_KIND` and a `CLASSIFIER_VERSION` bump in M9 (roadmap M9). No kind
found requires a facet the current six do not cover.

## 8. Opaque runtime-provided layers

Recorded, never guessed (design doc §12):

- **Built-in agents** compiled into the binary: `build`, `plan`, `general`,
  `explore`, plus hidden `compaction`, `title`, `summary` — listed by
  `opencode agent list` with no on-disk path [installed].
- **Built-in skill** `customize-opencode`, reported by `opencode debug skill`
  with `"location": "<built-in>"` [installed].
- **Built-in tools, default providers, and the fetched model catalog** — the
  catalog cache is materialised at `$XDG_CACHE_HOME/opencode/models.json`
  [yuurei; installed]. Runtime-provided, not user harness.
- **Remote `.well-known/opencode`** organizational defaults [upstream;
  unexercised here]. Not statically observable.
- **Default plugins / `--pure` plugin surface** [yuurei §8].

None of these is mixed into the content digest as if its contents were known
(design doc §12).

## 9. The verdict for the freeze

**The frozen schema accommodates OpenCode as found. No new `NativeOrigin` is
required, and no change to `NativeOrigin` is proposed here.**

Every configuration and element surface OpenCode reads from disk maps onto
`project | user | managed | plugin | builtin`; the two layers that do not sit
cleanly in that taxonomy — the network-fetched `.well-known/opencode` org config
and the `OPENCODE_CONFIG*` invocation overrides — are **not statically
observable**, so M9 records them as opaque/known-runtime-provided layers with
`native.origin: "unknown"` and a diagnostic, rather than widening the union for
something `pfl` cannot read. `unknown` is already a member, and `scope`
(`native.scope: string | null`) plus `inspectability` carry the provenance. This
is the same treatment Claude Code's opaque built-in instruction layers already
receive.

Cross-runtime imports (`~/.claude`, `~/.agents`, project `.claude`/`.agents`) are
location-based `user`/`project` elements whose cross-runtime provenance lives in
`scope`, not in a new origin; `ElementId` already includes `runtimeId`, so they
cannot collide with the Claude Code adapter's elements.

**What M8 must therefore freeze, on this issue's account:** nothing in
`NativeOrigin`, the element schema, or `ElementId`. The render order in
`src/cli/graph-model.ts:40` and `src/cli/list.ts:20` already contains all six
members and is unaffected — OpenCode adds no origin to order. The freeze needs
only to (a) keep `unknown` in the union and `scope` as a free string, and (b) not
narrow `inspectability` to exclude `known-runtime-provided`/`opaque`. This
document is the written model M9 implements against; it is version-pinned above
and superseded only by moving that pin (§10). If a future OpenCode version
introduces an on-disk layer that is neither project, user, managed, plugin, nor
builtin, that is a schema change and reopens the freeze under the roadmap's
entry condition — not a quiet widening in M9.

## 10. Keeping this claim honest

The M7 withdrawal of `multi-agent-configuration` established the rule this
document follows: a withdrawn or accepted claim is re-checked whenever the
verified range moves. The trigger for this document is the same **layout
reconciliation**: when M9 (or a later adapter change) moves the verified range,
compare the surfaces above against the runtime's actual configuration surface for
that version, record the difference here, and re-check every **not-modelled**,
**opaque**, and **[upstream]** row. A fixture only exercises a searched area, so
a surface in an unsearched directory stays green; the reconciliation is what
catches it.

## 11. Open questions

1. **Remote `.well-known/opencode` reachability.** Whether an unauthenticated
   installation ever fetches it, and what it can set, is unverified here. It
   would be settled by an authenticated run against an org provider, or by
   reading `packages/core` for the fetch trigger. Until then it stays an opaque
   layer, never an origin.
2. **`OPENCODE_CONFIG*` under an inspected run.** `pfl` inspects a project, not
   a run environment, so it cannot know these values. Whether M9 should read the
   `pfl` process environment at all, or always report the layer as unknown, is an
   M9 decision; this document recommends the latter to preserve "do not infer
   more than can be supported".
3. **Skill-name collision tie-break** (§6) — observed, not documented. A
   multi-version check would settle whether it is stable.
4. **Nested `.opencode` directories.** Skills are documented to load along the
   walk to the git root; whether a nested `<subdir>/.opencode/agents/` is also
   loaded is unverified. A probe with agents in a nested directory would settle
   it.
5. **Data-dir read paths.** `~/.local/share/opencode/{auth.json,mcp-auth.json,
   opencode.db}`, `~/.cache/opencode/models.json`, and `~/.local/state/opencode/`
   are runtime state and credentials, not harness elements. They are recorded
   here so M9's read-path inventory and its mandatory security review start from
   the full set; none is a harness element and all are deny-by-default for
   persistence.
