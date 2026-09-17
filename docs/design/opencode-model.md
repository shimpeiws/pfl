# OpenCode scope, origin, and path model

- **Status:** investigation complete; input to the M8 freeze. M9 implements the
  adapter against this document and does not alter it.
- **Runtime:** OpenCode **1.18.30** was the measured binary
  (`/opt/homebrew/bin/opencode` → `…/Cellar/opencode/1.18.30/bin/opencode`,
  Homebrew formula `anomalyco/tap/opencode`, build dated 2026-09-09).
- **Verified range:** **1.18.0 and 1.18.30 only** — discrete versions, not a
  floor. yuurei verified 1.18.0; this document measured 1.18.30. Nothing at or
  above 1.18.31 has been verified.
- **Version pinned:** 2026-09-17.
- **The host has since moved to 1.18.31.** Homebrew upgraded the installed binary
  the same day (`/opt/homebrew/bin/opencode` →
  `…/Cellar/opencode/1.18.31/bin/opencode`, installed 2026-09-17 19:24), and
  1.18.30 is no longer present in the Cellar. Three consequences, which the rest
  of this document respects:
  - The **[installed: measured]** observations below were taken on 1.18.30 and
    **can no longer be re-derived on this host**. They stand as observations of
    that binary, and are not evidence about 1.18.31.
  - One claim has been re-probed on 1.18.31 and **it no longer holds**: the
    skill-name collision of §6 resolved the other way. Nothing else has been
    re-probed.
  - The reconciliation §10 describes is therefore **already due**, not a future
    trigger. Until it runs, read this document as "measured on 1.18.30, not
    re-verified on 1.18.31" and do not extend it to 1.18.31.
- **What this means for M9.** Every **[installed: measured]** layout row must be
  **re-verified against the installed binary before M9 implements against it** —
  those rows describe a build that is no longer on this host. The schema
  conclusions of §9 rest on the union of origins and kinds, not on the layout
  rows, and stand as written.
- **Issue:** [#78](https://github.com/shimpeiws/pfl/issues/78); milestone M8,
  design references `pfl-roadmap-v1.0.md` §5 (M8, ordering constraints) and
  `pfl-design-v0.1.md` §11 (Resolution Model), §12 (Builtin), §31 (Initial
  Discovery Scope).
- **Read-only:** no configuration file was written. Every layout probe that
  could create or read runtime state ran under a throwaway `HOME`/`XDG_*`/`TMPDIR`;
  the real installation was otherwise only read (`--help`, `debug paths`,
  `debug info`). See §0.

## 0. Evidence basis and its limits

Each claim below carries one of four tags:

| Tag                          | Meaning                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[installed: measured]**    | The installed 1.18.30 binary's own behaviour: `--help`, the `debug` subcommands, `agent list`, or an isolated run against a throwaway `HOME`/`XDG_*` tree. This is the strongest evidence here.                 |
| **[installed: self-described]** | Text the installed binary embeds and prints — in practice the `debug skill` body of `customize-opencode`. That the text exists, and that this binary printed it, is measured. The layout and merge rules *inside* that text are the vendor's own description of its layout, not independently reproduced on this host, and are weaker than a measured behaviour. |
| **[yuurei]**                 | Prior evidence in the sibling project's adapter and spike (verified on 1.18.0 and 1.18.30). Re-verified here where relied on.                                                                                    |
| **[upstream]**               | The vendor's published documentation (`opencode.ai/docs/*`, schema `opencode.ai/config.json`). Not reproducible from this host.                                                                                  |

The distinction between the two installed tags is load-bearing. `debug skill`
returning a `customize-opencode` body proves the binary ships that skill and
describes its layout; it does not by itself prove the described rules hold. The
tag is therefore applied **per row**, and rows are marked
**[installed: self-described]** where they rest on that body rather than on a
probe — most clearly §4.1's `mode`/`tool`/`theme` directories and §6's plugin
hook catalogue. §2's search order is **measured**, not self-described: §2 records
the probe results that confirmed it row by row. Where a row was re-checked on
1.18.31, the header and §11.6 say so rather than letting the tag imply more than
was done.

Where the documentation and the installed binary could disagree, the installed
binary wins and the document says so. Two structural sources are quoted from the
installation itself:

- `opencode debug paths` — the resolved roots [installed: measured].
- `opencode debug skill` — the binary ships a built-in `customize-opencode`
  skill whose body documents the file locations and merge rules. The runtime is
  describing itself, so this is installed evidence about 1.18.30 and not
  third-party prose — but it is the runtime's *account* of its layout, so it
  carries the self-described tag [installed: self-described].

**Limit of the claim.** Most of this document rests on **one** observed
installation (macOS arm64, 1.18.30). It supports "present in 1.18.30", not
"present in every OpenCode version" and not "cannot exist". The managed-file and
remote layers could not be exercised on this host (no MDM, no org provider); they
are marked **[upstream]** and must be re-checked when the verified range moves
(§10). The same caution the M7 note applies to Codex's withdrawn kinds applies
here: absence of a surface in one installation is not proof of its absence.

That limit is no longer hypothetical: the header records that the host moved to
1.18.31 the same day, that 1.18.30 is gone from the Cellar, and that the one claim
re-probed did not reproduce. Read "present in 1.18.30" as a hard boundary — these
are observations of a binary that is no longer installed.

### The isolated probe

No user configuration was written or read outside a throwaway tree. The probe
must be run as a whole: redirecting the roots is not sufficient, because OpenCode
also accepts configuration through `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` and
`OPENCODE_CONFIG_CONTENT` (§2), and those are inherited from the parent shell.
Left set, `OPENCODE_CONFIG` can point at an arbitrary path — including the real
`~/.config/opencode/opencode.json` — and the run would no longer be isolated at
all.

No `OPENCODE_*` or `XDG_*` variable is set in the environment this document was
recorded in (`env | grep -E '^(OPENCODE|XDG)'` returns nothing), so the
observations below were taken from the default layout rather than from an
inherited override. The probe below is the script that produced every
**[installed: measured]** row in this document. It is reproduced in full so those observations can be re-derived
rather than taken on trust; it writes only under a `mktemp` directory, and the
decoy files it creates are never the user's own.

```sh
#!/bin/sh
# OpenCode layout probe for docs/design/opencode-model.md (§0).
# Writes only under $ROOT; reads the real installation only via the binary.
set -u

ROOT=$(mktemp -d "${TMPDIR:-/tmp}/ocprobe.XXXXXX")
H="$ROOT/home"; G="$H/.config/opencode"; P="$ROOT/proj"
mkdir -p "$G/agent" "$G/command" "$G/skill/marker" \
         "$P/.opencode/agent" "$P/.opencode/command" "$P/.opencode/skill/marker" \
         "$H/.local/share" "$H/.local/state" "$H/.cache" "$ROOT/tmp"
git init -q "$P" >/dev/null 2>&1   # §2's walk stop needs a real repository
printf 'PROJECT AGENTS.md\n' > "$P/AGENTS.md"

# One decoy per config source, each carrying its own `model` marker.
printf '{"model":"global-marker"}\n'         > "$G/opencode.json"
printf '{"model":"project-marker"}\n'        > "$P/opencode.json"
printf '{"model":"dot-opencode-marker"}\n'   > "$P/.opencode/opencode.json"
printf '{"model":"above-git-root-marker"}\n' > "$ROOT/opencode.json"
printf '{"model":"env-file-marker","small_model":"env-file-small-marker"}\n' > "$ROOT/custom.json"

# One name (`marker`) in all three surfaces, in both scopes, for §6.
mk_agent()   { printf -- '---\ndescription: %s agent marker\nmode: subagent\n---\n%s agent body\n' "$1" "$1" > "$2"; }
mk_command() { printf -- '---\ndescription: %s command marker\n---\n%s command body\n' "$1" "$1" > "$2"; }
mk_skill()   { printf -- '---\nname: marker\ndescription: %s skill marker\n---\n%s skill body\n' "$1" "$1" > "$2"; }
mk_agent   GLOBAL  "$G/agent/marker.md";              mk_agent   PROJECT "$P/.opencode/agent/marker.md"
mk_command GLOBAL  "$G/command/marker.md";            mk_command PROJECT "$P/.opencode/command/marker.md"
mk_skill   GLOBAL  "$G/skill/marker/SKILL.md";        mk_skill   PROJECT "$P/.opencode/skill/marker/SKILL.md"

# Redirect every root into $ROOT and drop the config redirectors, so the only
# source in play is the one a probe sets on purpose.
export HOME="$H" \
       XDG_CONFIG_HOME="$H/.config" XDG_DATA_HOME="$H/.local/share" \
       XDG_STATE_HOME="$H/.local/state" XDG_CACHE_HOME="$H/.cache" \
       TMPDIR="$ROOT/tmp" \
       OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1
unset OPENCODE_CONFIG OPENCODE_CONFIG_DIR OPENCODE_CONFIG_CONTENT
cd "$P" || exit 1

cfg()   { opencode debug config 2>&1 | grep -E '"(model|small_model)":' ; }
model() { opencode debug config 2>&1 | grep -o '"model": "[^"]*"' | head -1; }
skill() { opencode debug skill  2>&1 | grep -o '\(GLOBAL\|PROJECT\) skill marker'; }
agent() { opencode debug config 2>&1 | grep -o '\(GLOBAL\|PROJECT\) agent marker'; }

echo "version $(opencode --version 2>&1 | tail -1); roots:"
opencode debug paths 2>&1 | sed 's/^/  /'

echo "1. both project configs present";           cfg
mv "$P/.opencode/opencode.json" "$ROOT/h1"; echo "2. .opencode config removed"; cfg; mv "$ROOT/h1" "$P/.opencode/opencode.json"
mv "$P/opencode.json" "$ROOT/h2";           echo "3. both removed (global + parent remain)"
model
printf '   parent-dir config read? '; [ "$(model)" = '"model": "above-git-root-marker"' ] && echo yes || echo no
mv "$ROOT/h2" "$P/opencode.json"
echo "4. OPENCODE_CONFIG set";  OPENCODE_CONFIG="$ROOT/custom.json" cfg
echo "5. OPENCODE_CONFIG_CONTENT set"
OPENCODE_CONFIG_CONTENT='{"model":"env-content-marker"}' cfg
echo "6. same-name agent / command / skill, three consecutive invocations"
i=1; while [ "$i" -le 3 ]; do printf '   run %s: agent=%s command=%s skill=%s\n' "$i" "$(agent)" "$(opencode debug config 2>&1 | grep -o '\(GLOBAL\|PROJECT\) command marker')" "$(skill)"; i=$((i+1)); done
echo "7. .mcp.json beside the project config"
printf '{"mcpServers":{"probe":{"command":"true"}}}\n' > "$P/.mcp.json"
printf '   mcp mentions in debug config: %s\n' "$(opencode debug config 2>&1 | grep -ci mcp)"
rm "$P/.mcp.json"
```

Three details in it are load-bearing, each the fix for a first attempt that
measured something else:

- **`git init`, not `mkdir .git`.** §2's walk stop only appears against a real
  repository. With `.git` present as an empty directory, or as a file holding a
  dangling `gitdir:` line, the walk continues past the project and reads the
  parent directory's config — the opposite of the recorded behaviour, from the
  same binary.
- **`env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_DIR -u OPENCODE_CONFIG_CONTENT`.**
  Without it a probe measures whatever the invoking shell happened to carry. §2's
  rows 3 and 6 are measured by setting those variables deliberately, with the
  custom path under `$ROOT`.
- **`debug config` for agents and commands, `debug skill` for skills.**
  `opencode agent list` reports nothing for a `mode: subagent` fixture, so a probe
  that reads it concludes no agent was loaded at all; the winning agent is visible
  in `debug config`'s `agent` map.

### What the probe exercises, and what it does not

**Exercised**, on 1.18.31 unless noted: the XDG-derived roots (§1); precedence
between the global, project, `.opencode/`, `$OPENCODE_CONFIG` and
`$OPENCODE_CONFIG_CONTENT` sources, and the survival of non-conflicting keys
through the merge (§2); the walk stop at a real git root, and its absence without
one (§2, §3); the loading of `.opencode/{agent,command,skill}/<name>` and their
`$XDG_CONFIG_HOME` counterparts (§4); that a same-name agent and command resolve
to the project's copy while a same-name skill is lost unstably (§6); that a
`.mcp.json` beside the project config contributes nothing (§4.2); and that the
built-in skill layer surfaces as `customize-opencode` (§5, §7).

**Not exercised**, so those rows stand on the source their tag names: the plural
element directory names (`agents`, `commands`, `skills`); `mode/`, `tool/`,
`tool(s)/`, `theme/`, `formatter`, `lsp`, and the `instructions` array; plugins
(local and npm); `permission` patterns and MCP servers configured through
`opencode.json`; `.claude/skills`, `.agents/skills` and the `CLAUDE.md` fallback;
global and nested `AGENTS.md` walking; `OPENCODE_CONFIG_DIR`; and the data and
state paths of §4 and §9. A row in those areas claims only what its cited source
claims, which is what the per-row tags below record.

## 1. Roots

OpenCode resolves every root from the XDG base-directory variables, with `HOME`
and `TMPDIR` fallbacks. `opencode debug paths` is authoritative [installed: measured]:

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
`~/.opencode/` directory [installed: self-described].

## 2. Configuration file locations and search order

Two naming forms are accepted everywhere: `opencode.json` and `opencode.jsonc`
(JSONC: comments and trailing commas) [upstream; both parsed by the same loader].
Config sources are **deep-merged**, later overriding earlier for conflicting
keys; non-conflicting keys are preserved. Order [upstream; the local half measured
in §0]:

| # | Source                            | Path                                                                              | Origin    | Tag          |
| - | --------------------------------- | --------------------------------------------------------------------------------- | --------- | ------------ |
| 1 | Remote (organizational defaults)  | `.well-known/opencode` on the provider's host                                     | remote    | [upstream]   |
| 2 | Global (user)                     | `$XDG_CONFIG_HOME/opencode/opencode.json[c]`                                      | user      | [installed: measured]  |
| 3 | Custom file                       | `$OPENCODE_CONFIG` (arbitrary path)                                               | custom    | [installed: measured]  |
| 4 | Project                           | `<project>/opencode.json[c]`, walking up from cwd to the git/worktree root        | project   | [installed: measured]  |
| 5 | Project `.opencode/` directory    | `<project>/.opencode/opencode.json[c]` (+ element subdirs, §4)                    | project   | [installed: measured]  |
| 6 | Inline                            | `$OPENCODE_CONFIG_CONTENT` (JSON string)                                          | custom    | [installed: measured]  |
| 7 | Managed file                      | macOS `/Library/Application Support/opencode/opencode.json[c]`; Linux `/etc/opencode/` | managed   | [upstream]   |
| 8 | macOS managed preferences (MDM)   | `/Library/Managed Preferences/<user>/ai.opencode.managed.plist` (or `/Library/Managed Preferences/…`) | managed   | [upstream]   |

`OPENCODE_CONFIG_DIR` names an additional directory searched for agents,
commands, modes, and plugins "just like the standard `.opencode` directory",
loaded **after** the global config and `.opencode/`, so it can override them
**Measured:** an `agent/` subdir under that directory is loaded. **Not measured
(upstream only):** the `command/`, `mode/` and `plugin/` subdirs, and the load
order stated in this sentence — the §0 probe does not exercise this variable, so
the rest of the sentence is the binary's own documentation rather than an
observation here. `OPENCODE_TUI_CONFIG`
points at a separate TUI-only config (`tui.json[c]`); UI chrome is outside the
harness boundary (§7) and is not modelled.

Verified precedence behaviours (isolated probe, §0; all four re-run on 1.18.31,
where they reproduced):

- All three on-disk local configs loaded, and the later source won each conflict:
  `.opencode/opencode.json` over the project's `opencode.json`
  (`dot-opencode-marker` beat `project-marker`), and both over the global config
  → #5 over #4 over #2, the documented order.
- `$OPENCODE_CONFIG` was loaded and still lost to the project: its `small_model`
  appeared while the `.opencode/` `model` won → #4 above #3.
- `$OPENCODE_CONFIG_CONTENT`'s `model` won over every on-disk local source while
  the on-disk `small_model` survived → #6 is the highest local scope, and merging
  is **by key, not by file**.
- Project lookup stopped at the git root: with a config beside the project and
  another in the parent directory, the parent's was not read, from either the
  project root or a nested cwd. **The stop needs a real repository.** With `.git`
  present as an empty directory, or as a file containing a dangling `gitdir:`
  line, the walk continued past the project and read the parent's config. A
  fixture that creates `.git` with `mkdir` therefore measures the opposite of one
  that runs `git init`, so §0 uses `git init` and both cases are recorded here.

**Invalid config is fatal.** Unknown top-level keys are rejected with
`ConfigInvalidError` rather than ignored [installed: self-described; upstream].
For `pfl` this is a diagnostic-worthy condition, not a reason to abort an
inspection (best-effort invariant).

## 3. Project config discovery

Project-scoped lookup walks **up** from the current directory and stops at the
nearest Git/worktree root [upstream; the stop was measured]. That means more
than the config file is found along the way: skills discovery walks the same path
and loads `.opencode/skills`, `.claude/skills`, and `.agents/skills` from each
directory up to the worktree root [upstream]. The OpenCode model therefore has a
`directory-subtree` applicability axis (§6), not only a flat project scope.

## 4. Element source surfaces

### 4.1 User scope (requires consent; under `$XDG_CONFIG_HOME/opencode`)

| Surface                | Path                                                                            | Tag                    |
| ---------------------- | ------------------------------------------------------------------------------- | ---------------------- |
| Instructions           | `AGENTS.md` (fallback `~/.claude/CLAUDE.md`)                                     | [installed: self-described]            |
| Agents / subagents     | `agent(s)/<name>.md`                                                             | [installed: measured]            |
| Commands               | `command(s)/<name>.md`                                                           | [installed: measured]            |
| Skills                 | `skill(s)/<name>/SKILL.md`                                                       | [installed: measured]            |
| Plugins (local)        | `plugin(s)/*.ts`, `plugin(s)/*.js` (auto-discovered; no config entry needed)     | [installed: self-described]            |
| Modes (legacy)         | `mode(s)/`                                                                       | [installed: self-described] |
| Tools                  | `tool(s)/`                                                                       | [installed: self-described] |
| Themes (UI)            | `theme(s)/`                                                                      | [installed: self-described] |
| Cross-runtime skills   | `~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md`           | [installed: self-described]            |
| npm plugins            | `plugin` array in a config file (npm spec, pinned spec, path, `file://`, tuple)  | [upstream]             |
| MCP servers            | `mcp` key in a config file                                                       | [installed: measured]            |
| Permissions / policy   | `permission` key                                                                 | [upstream]            |
| Model / provider       | `model`, `small_model`, `provider`, `disabled_providers`, `enabled_providers`    | [installed: measured] (`model`, `small_model`) |
| Instructions (extra)   | `instructions` array: paths/globs relative to the declaring config, or URLs       | [installed: self-described]            |

Plural and singular subdirectory names are both accepted; the plural form is the
documented current spelling and the singular form is kept for compatibility. The
§0 probe exercises the **singular** form only (`agent/`, `command/`,
`skill/<name>/`); the plural spellings are [upstream].

### 4.2 Project scope (implicit; under the project root)

The same element directories, under `<project>/.opencode/`, plus the
Claude/agent-compatible surfaces that OpenCode loads directly from the project:

| Surface                       | Path                                                         | Tag         |
| ----------------------------- | ------------------------------------------------------------ | ----------- |
| Instructions                  | `AGENTS.md` (fallback `CLAUDE.md`), walked up from cwd       | [installed: self-described] |
| Extra instructions            | `instructions` array in the project config                   | [installed: self-described] |
| Agents / subagents            | `.opencode/agent(s)/<name>.md`                               | [installed: measured] |
| Commands                      | `.opencode/command(s)/<name>.md`                             | [installed: measured] |
| Skills                        | `.opencode/skill(s)/<name>/SKILL.md`                         | [installed: measured] |
| Cross-runtime skills          | `.claude/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md` | [installed: self-described] |
| Plugins (local)               | `.opencode/plugin(s)/*.ts`, `*.js`                           | [installed: self-described] |
| MCP servers                   | `mcp` key in `opencode.json[c]`                              | [installed: measured] |
| Permissions / model / config  | the config keys of §2, §7                                    | config keys [installed: measured] (`model`); `permission` [upstream] |

**Claude-compat is narrower than Claude Code's own surface.** OpenCode reads
Claude skills and the `CLAUDE.md` rules fallback, but does **not** read Claude
Code's `.mcp.json`: a probe placed a `.mcp.json` with an MCP server in the
project root and `opencode debug config` contributed no `mcp` entry at all to the resolved config — the top-level keys
of `opencode debug config` were `$schema, agent, command, mode, model, plugin,
username`, with no `mcp` among them [installed: measured]. (`mcp` appears in that
output only when a server is configured some other way; it is omitted, not
`null`.)
MCP is configured only through `opencode.json` `mcp` or a provided plugin.

## 5. The scope model against `NativeOrigin`

`NativeOrigin` (`src/core/observed.ts:11`) is
`project | user | managed | plugin | builtin | unknown`.

Two rules keep this mapping honest, and they are what the rest of the section
applies:

1. **`origin` describes the declaring scope, not where the bytes live.** A
   surface declared by the project is `project` even when it resolves elsewhere:
   Claude Code's `../CLAUDE.md`, found one directory above the project root, is
   recorded as `origin: 'project'`, `scope: 'project'`
   (`src/runtime/claude-code/discovery.ts:226-235`). For a fixed search area the
   declaring scope and the location coincide, which is why `~/.claude/skills`
   is `user` — but the rule that decides is the declaring scope.
2. **`unknown` means unknown *provenance*. It is not how pfl records content it
   simply does not read.** An element whose layer is known but whose contents are
   unreadable keeps its real origin and says so through `inspectability`. Claude
   Code's built-in instruction layers are `origin: 'builtin'`,
   `inspectability: 'opaque'`, never `unknown`
   (`src/runtime/claude-code/discovery.ts:834-844`). `unknown` is reserved for a
   layer whose native source pfl cannot establish statically.

| OpenCode layer                                                       | `NativeOrigin` | `scope` (free string)             | Notes |
| -------------------------------------------------------------------- | -------------- | --------------------------------- | ----- |
| Project `opencode.json`, `.opencode/**`, project `AGENTS.md`/`CLAUDE.md` | `project`  | `project`                         | The walk up to the git root stays project-local. |
| Global `~/.config/opencode/**`                                       | `user`         | `user`                            | |
| `~/.claude/skills`, `~/.agents/skills`, `~/.claude/CLAUDE.md`        | `user`         | `claude-compat` / `agents-compat` | Location-based origin; the cross-runtime provenance is carried by `scope`, not by a new origin. |
| Project `.claude/skills`, `.agents/skills`, `CLAUDE.md`              | `project`      | `claude-compat` / `agents-compat` | Same reasoning. |
| Managed file `/Library/Application Support/opencode/…`               | `managed`      | `managed-file`                    | [upstream] |
| macOS MDM `ai.opencode.managed` plist                                | `managed`      | `managed-preferences`             | [upstream] |
| Plugin-provided elements (npm module or local plugin)                | `plugin`       | `plugin`                          | A plugin's *contents* are opaque; the elements it declares are `plugin` origin. A local `.opencode/plugins/*.ts` file is itself `project`. |
| Built-in instruction and skill layer (`customize-opencode`, built-in tools and agents) | `builtin` | `builtin`              | Compiled into the binary. Modelled as one opaque layer, `kind: runtime-provided-instructions`, `inspectability: 'opaque'`. **Measured:** the binary ships a `customize-opencode` skill and built-in agents/tools. **Decided, not measured:** collapsing them into one opaque layer — that follows the encoding Claude Code and Codex already use for their own built-in layers, not an OpenCode observation. See §7. |
| Remote `.well-known/opencode` org defaults                           | `unknown`      | `remote-org`                      | Its provenance is *probably* organizational policy, but pfl cannot confirm that it exists, is authenticated, or is org-scoped. So the native origin is left unasserted rather than inferred; `scope` and `inspectability: 'opaque'` carry what is known. See §9. |
| Declared targets named by a config value (§5.2)                       | declaring scope | declaring scope's `scope`, plus a target marker | `origin` is the layer that declared the target; `inspectability: 'opaque'` because pfl does not open it. |

Element identity is `runtime + origin + path + kind` (`src/core/ids.ts:88`,
ADR 0003), so the OpenCode adapter's view of `~/.claude/skills/x` and the Claude
Code adapter's view are different `ElementId`s (different `runtimeId`).
Cross-runtime import needs no identity change.

### 5.1 What `pfl` opens

`pfl` opens files at locations it derives itself from the declared scopes and
roots of §1–§3, plus literal path constants such as `../AGENTS.md` and
`~/.claude/CLAUDE.md`. **It does not open a path that a configuration value
names** — not even when that path would resolve inside a root `pfl` already has
consent for, because the decision would then rest on a value (`..`, a symlink, an
absolute path) instead of on the declared scope. A walk refuses any path that
resolves outside its root (`src/discovery/walk.ts:356-381`). §5.2 lists the
OpenCode surfaces this covers.

This is not a new rule invented for OpenCode; it is what the existing adapters
already do, and OpenCode's config schema contains surfaces that only make sense
under it:

- Claude Code instruction files are digested and their path recorded; the `@path`
  imports **inside** them are never parsed, so nothing they name is opened
  (`src/runtime/claude-code/discovery.ts:519-532`).
- `additionalDirectories` and `experimental_instructions_file` are not read at
  all.
- The one declared path that *is* followed is a `.git` **file**'s `gitdir:`
  target, and that is explicitly gated on `allowExternalGit` consent
  (`src/discovery/project-identity.ts:103-124`, `:30-36`).
- The design speaks only of *declared search areas and scopes*
  (`pfl-design-v0.1.md` §9.1, §19); no design statement sanctions opening a file
  named by a config value.

So "OpenCode reads X" and "pfl reads X" are different claims, and §4's surface
lists are claims of the first kind. Where the two diverge, §5.2 says so.

### 5.2 Declared targets `pfl` records but does not open

Two OpenCode surfaces name a target rather than living at a fixed location. Both
are **recorded as declarations and never opened** — `pfl` does not chase them,
and their contents are not digested:

| Surface | Declared target | `pfl` treatment |
| ------- | --------------- | --------------- |
| `instructions` array (§4.1, §4.2) | path, glob, absolute path, or URL | Recorded as an `instructions` element carrying the declaring layer's `origin` and `inspectability: 'opaque'`. The target is **not** opened, whatever it names: an in-project path, a `../` escape, an absolute path and a URL all get the same treatment. |
| `references` (§6, §7) | local directory, glob, or Git repository | Recorded as a `references` element, `inspectability: 'opaque'`. Nothing under the directory is walked and no repository is fetched. |

Consequences, stated plainly:

- **`pfl`'s snapshot of such a run is incomplete by design.** OpenCode will read
  the target when it runs; `pfl` will report that the declaration exists and that
  its contents were not part of the inventory. That gap is visible in the
  document rather than hidden behind a guessed origin.
- **These are not consented reads, because they are not reads.** Consent (§19)
  is granular per `runtime + scope` and is asked for before `pfl` opens an
  out-of-project *scope*; it is not a mechanism for opening a target named by a
  config value. No new consent scope is introduced here.
- **M9's read-path inventory must therefore not include them**, and its
  containment check must reject them if a future change tries to open one. The
  external Git case already has the precedent for gating such a read — it is
  opt-in and consent-backed — and this document does not extend it.

### 5.3 Execution context this model does not inventory

The design excludes arbitrary environment variables from the Harness Inventory
(`pfl-design-v0.1.md` §5 Harness Boundary, "Excluded: execution context" —
labelled §4.2 in that document) and forbids persisting environment values
(§19, §32.5). `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` and
`OPENCODE_CONFIG_CONTENT` are environment variables. They **belong to execution
context and are not `ObservedElement`s.**

This matches the existing adapters exactly: neither reads `CLAUDE_CONFIG_DIR` nor
`CODEX_HOME`, although both variables redirect those runtimes' configuration and
both exist today. The adapters model the default on-disk layout and leave
invocation-time redirection to the execution layer (yuurei), which is where the
design's "Excluded: execution context" list already puts it.

Stated as a limit: **under an `OPENCODE_CONFIG` override, a `pfl` snapshot
describes the default layout, not the layout of that run.** That limitation is
identical to the one that already exists for `CLAUDE_CONFIG_DIR`, and the
alternative — detecting the variable, resolving the path it names, reading the
file, and deciding what consent covers — is a change to the harness boundary
(§5) and §19 of the design, not something this document can settle on its own.
§11 records it as such.

## 6. Resolution semantics — the four axes

The resolver separates Native source, Applicability, Resolution semantics, and
Activation (design doc §11). OpenCode's behaviour on each [installed: measured
unless noted]:

### Native source

`project | user | managed | plugin | builtin | unknown`, as mapped in §5.
Managed configuration overrides everything and is not user-overridable
[upstream].

### Applicability

| Value                | OpenCode surface                                                                | Tag |
| -------------------- | ------------------------------------------------------------------------------- | --- |
| `global`             | `~/.config/opencode/AGENTS.md`, global config keys                               | config keys [installed: measured]; `AGENTS.md` [installed: self-described] |
| `project`            | project `opencode.json`, `.opencode/**`, project `AGENTS.md`                      | config + element dirs [installed: measured]; `AGENTS.md` [installed: self-described] |
| `directory-subtree`  | a nested `AGENTS.md`/`CLAUDE.md` and skills found along the walk to the git root | [upstream] — the walk stop is measured, the content found along it is not |
| `tool-event`         | `permission.bash` patterns; plugin hook events                                   | [upstream] |
| `config-rule`        | `permission` patterns, `references`, `instructions` globs — the last two name targets rather than fixed locations, so §5.2 records them as declarations instead of opening them | [upstream] |
| `runtime-defined`    | built-in agent permission rulesets                                               | [installed: self-described] |
| `unknown`            | remote/invocation layers                                                          | [upstream] |

### Resolution semantics

| Value             | OpenCode evidence                                                                 | Verified? |
| ----------------- | --------------------------------------------------------------------------------- | --------- |
| `override`        | config deep-merge, later source wins; same-name agent/command: project overrides global [installed: measured]. Same-name skills are not overridden but lost, unstably — see below. |
| `accumulate`      | agents, commands, and skills from every scope appear in the merged catalog, deduplicated by name, so a collision yields a single surviving entry; `instructions` files combine | [installed: measured] |
| `available`       | skills are loaded on demand through the `skill` tool; `references` are consultable on demand [installed: measured]. `pfl` records the declaration and does not follow it (§5.2) |
| `policy`          | `permission` (allow/ask/deny, pattern objects; `external_directory` for paths outside the project) | [installed: measured] |
| `event-pipeline`  | plugin hooks (`chat.*`, `tool.execute.*`, `permission.ask`, …)                    | [installed: self-described] |
| `runtime-defined` | built-in tool/agent defaults                                                     | [installed: measured] |

**Name collisions across scopes are undefined behaviour, and are not stable
across versions or even across invocations of one binary.**

Fixture: one name (`marker`) defined in all three surfaces in both scopes —
`$ROOT/home/.config/opencode/{agent,command,skill}/marker…` and
`$ROOT/proj/.opencode/{agent,command,skill}/marker…` — each copy carrying a
distinguishing body, inspected from `$ROOT/proj` under the §0 probe. The agent and
command winners are read from the `agent`/`command` maps of `debug config`, not
from `agent list`, which reports nothing for a `mode: subagent` fixture; the skill
winner is read from `debug skill`, which lists one surviving entry per name.

| Binary and fixture                              | Agent   | Command | Skill, three consecutive invocations |
| ----------------------------------------------- | ------- | ------- | ------------------------------------ |
| 1.18.30 (as originally recorded)                | project | project | global                               |
| 1.18.31, collision fixture alone                | project | project | global, **project**, **project**     |
| 1.18.31, the §0 fixture (with the config decoys) | project | project | **global**, **global**, project      |

The documentation requires these names to be unique across locations, so a
collision is undefined behaviour rather than a documented tie-break. On 1.18.31 the
skill winner changed **between consecutive invocations with nothing changed on
disk** — four times in six runs, in both directions, and once in the same run that
recorded the opposite first. Agent and command were `project` in all six runs and
the skill was not.
That is what an unordered directory scan deciding the skill catalog looks like, and
it means the earlier 1.18.30 record of "global" was never a stable property of that
version either — the re-probe did not refute it so much as fail to reproduce it.
M9 must therefore record a duplicate-name diagnostic and must not depend on any
winner: a fixture cannot be trusted to reproduce the loss. This row is also the
concrete instance of the drift the header describes.

### Activation

| Value          | OpenCode surface                                                        | Tag |
| -------------- | ----------------------------------------------------------------------- | --- |
| `always`       | `AGENTS.md` / `instructions` — in context every session                  | [installed: self-described] |
| `on-demand`    | skills (skill tool), commands (user-invoked), references                 | [installed: self-described]; skills are measured to *appear* in the catalog (§0), their activation is not |
| `conditional`  | permissions (`ask`/`deny`), `enabled` flags on MCP servers               | [upstream] |
| `event-driven` | plugin hooks                                                            | [upstream] |
| `unknown`      | remote/invocation layers                                                 | [upstream] |

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
| Built-in instruction and skill layer (`customize-opencode`) | `runtime-provided-instructions` (existing)                    | `instructions` (opaque)        |
| Built-in agents (`build`, `plan`, `general`, `explore`; hidden `compaction`, `title`, `summary`) and built-in tools | **not modelled** as elements | — |
| themes, keybinds, TUI                  | **not modelled** — UI chrome, outside the harness boundary (design doc §5)        | —                              |

**Built-in layers are one opaque element, not a catalogue.** Claude Code records
its built-in instruction layers as a single element — `origin: 'builtin'`,
`kind: 'runtime-provided-instructions'`, `path: '(builtin) claude-code instruction
layers'`, `inspectability: 'opaque'`
(`src/runtime/claude-code/discovery.ts:834-844`) — and does not model its own
built-in tools at all. OpenCode follows the same shape: one
`runtime-provided-instructions` element for the compiled-in instruction and skill
layer, and **no elements for built-in agents or built-in tools**, which are the
runtime's own execution surface rather than user harness. `classify/classifier.ts:97`
already maps that kind and `classify/findings.ts:84-91` already reports such
elements as an opaque-layer finding, so this needs no new kind and no new finding.

That is also why the row no longer offers `runtime-provided` (new; M9) as an
alternative: a two-way choice left open is not an input M9 can implement, and the
existing kind is the one the classifier, the findings pass and the other two
adapters already agree on. Note that this is a different question from `tools`
(custom tools, `tool(s)/` and the `tools` key), which *are* user-declared and map
to `actions`.

**`references` is recorded as a declaration.** It names local directories or Git
repositories, and `pfl` neither walks nor fetches them (§5.2), so the element is
`inspectability: 'opaque'` and no content is digested. Its facet is `knowledge`
because that is what it makes available to the agent — not because `pfl` has read
any of it.

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
  `opencode agent list` with no on-disk path [installed: measured].
- **Built-in skill** `customize-opencode`, reported by `opencode debug skill`
  with `"location": "<built-in>"` [installed: measured].
- **Built-in tools, default providers, and the fetched model catalog** — the
  catalog cache is materialised at `$XDG_CACHE_HOME/opencode/models.json`
  [yuurei; measured]. Runtime-provided, not user harness.
- **Remote `.well-known/opencode`** organizational defaults [upstream;
  unexercised here]. Not statically observable.
- **Default plugins / `--pure` plugin surface** [yuurei §8].

None of these is mixed into the content digest as if its contents were known
(design doc §12).

## 9. The verdict for the freeze

**The frozen schema accommodates OpenCode as found. No new `NativeOrigin` is
required, and no change to `NativeOrigin` is proposed here.**

Every OpenCode surface that lives at a location `pfl` derives itself — the
project and user scopes of §1–§3, the managed layers, plugins, and the compiled-in
layers — maps onto `project | user | managed | plugin | builtin`. Nothing found
needs a seventh member.

Three groups were previously lumped into that claim and are now separated,
because they are not the same kind of thing:

- **Declared targets named by a config value** — absolute `instructions` paths,
  `instructions` URLs, and `references` directories or repositories (§5.2). These
  are not an origin question at all. `pfl` does not open them, so they are
  recorded as declarations carrying the **declaring layer's** origin with
  `inspectability: 'opaque'`. They are not `unknown`: their provenance is known,
  only their contents are not read (§5, rule 2).
- **`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`** —
  environment variables, therefore execution context, therefore **not
  `ObservedElement`s at all** (§5.3). The design excludes arbitrary environment
  variables from the inventory (§5, "Excluded: execution context") and forbids
  persisting environment values (§19, §32.5), and neither existing adapter reads
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME` either. The cost is stated rather than
  hidden: under such an override a snapshot describes the default layout, not that
  run's layout.
- **Remote `.well-known/opencode` organizational defaults** — genuinely `unknown`.
  This is the one layer whose *provenance* `pfl` cannot establish statically: it
  cannot confirm the layer exists, is authenticated, or is org-scoped. `unknown`
  is used here for that reason, not as a bin for unreadable content, and `scope`
  (`remote-org`) plus `inspectability: 'opaque'` carry what is known.

Note that the built-in layers are *not* in the third group: Claude Code records
its own as `origin: 'builtin'` with `inspectability: 'opaque'`
(`src/runtime/claude-code/discovery.ts:834-844`), and OpenCode's follow the same
encoding (§7). `unknown` is for unknown provenance, not for known layers whose
contents are unreadable.

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

**What this verdict does not cover.** This conclusion is about the *schema* and
survives the version drift recorded in the header: no union member is added or
removed by it. The *layout* claims are a separate matter, and §10 makes their
reconciliation due before M9 implements against them.


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

**The trigger has already fired** (2026-09-17, per the header), so this is an
outstanding obligation rather than a future one — tracked as §11.6. Meanwhile the
**schema** conclusion (§9) is unaffected. The **layout** claims were re-checked on
1.18.31 as far as the §0 probe reaches — §2's four precedence behaviours, which
reproduced, and the §6 collision rows, which did not — and §0 now states that
coverage explicitly. Any **[installed: measured]** row on a surface the probe does
not exercise must not be extended to 1.18.31 by assumption.

## 11. Open questions

1. **Remote `.well-known/opencode` reachability.** Whether an unauthenticated
   installation ever fetches it, and what it can set, is unverified here. It
   would be settled by an authenticated run against an org provider, or by
   reading `packages/core` for the fetch trigger. Until then it stays an opaque
   layer, never an origin.
2. **`OPENCODE_CONFIG*` — decided, not open.** `pfl` inspects a project, not a run
   environment, and this document puts the config redirectors outside the
   inventory (§5.3), consistent with the design's exclusion of environment
   variables (§5, "Excluded: execution context") and with both existing adapters
   ignoring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. Leaving it as an M9 judgement
   call is what made the previous draft contradict §5.3, so it is settled here.
   If the model should cover these variables after all, that is a deliberate
   change to the design's harness boundary and consent policy — not an adapter
   decision.
3. **Skill-name collision tie-break** (§6) — **settled by re-probe, as undefined
   behaviour.** On 1.18.31 one fixture produced both winners across consecutive
   invocations with unchanged on-disk state, so there is no tie-break to record:
   M9 records a duplicate-name diagnostic and relies on no winner. Nothing remains
   open here beyond the general reconciliation below.
4. **Nested `.opencode` directories.** Skills are documented to load along the
   walk to the git root; whether a nested `<subdir>/.opencode/agents/` is also
   loaded is unverified. A probe with agents in a nested directory would settle
   it.
5. **Data-dir read paths in M9's inventory.** That
   `~/.local/share/opencode/{auth.json,mcp-auth.json,opencode.db}`,
   `~/.cache/opencode/models.json` and `~/.local/state/opencode/` are runtime
   state and credentials rather than harness elements is **already decided** by
   the harness boundary and the persistence policy: none is an element, and all
   are deny-by-default. What is genuinely open is narrower — the read paths
   OpenCode actually uses to reach them, and how M9's inventory enumerates them.
   Stated this way so the mandatory security review starts from the full set
   without re-litigating the classification.
6. **Reconciling this document with 1.18.31.** The header records the drift. The
   §0 probe has since been re-run on 1.18.31 and the surfaces it reaches
   re-checked: §2's precedence behaviours reproduced, §6 changed, and the per-row
   tags of §4 and §6 are now scoped to that measured set. What remains undone is
   the rest of the reconciliation — every **[upstream]** and not-exercised row
   still stands on the source it names — and §10 makes that the prerequisite M9
   inherits.
