# Security review — M9 OpenCode inventory and hostile fixtures (#94)

- Date: 2026-09-18
- Reviewer: maintainer self-review, building on the independent adversarial
  review of the adapter itself
  (`docs/security/reviews/2026-09-18-m9-opencode-adapter.md`).
- Trigger: `test/fixtures/**`, `test/integration/**`, and
  `docs/security/read-paths.md` changed. No `src/` file changed, so no
  trust-boundary code path moved.
- Result: the OpenCode adapter's read set is now enumerated in the inventory and
  exercised by the same consent, safety, and hostile-input suites as the other
  two adapters.

## What changed

- `test/fixtures/opencode/{project,home,parent}/**`: a committed synthetic
  harness covering the config files, the element directories, cross-runtime
  skills, a legacy `mode/` file, a parent-directory instruction, and the
  installer-free detection surface.
- `test/fixtures/materialize.ts`: `opencode` is a `FixtureRuntime`; the
  materializer plants the escaping symlink, the symlinked config, the
  mode-000 unreadable skill, and the opencode sentinels/secrets.
- The consent boundary (`consent.test.ts`), the consent choke point
  (`consent-choke-point.test.ts`), the read-only / no-leak invariants
  (`security-invariants.test.ts`), and the relation producers
  (`relation-producers.test.ts`) now run over `opencode` as a third
  parameterisation.
- `docs/security/read-paths.md` gains a `runtime/opencode` section.

## Trust-boundary check

- **No `src/` change**, so no read is added, removed, or reordered by this PR.
  The adapter's reads were reviewed and dispositioned in #93.
- **Every adapter read is classified** in the new inventory section:
  project-implicit (`AGENTS.md`/`CLAUDE.md` tree, `opencode.json[c]`,
  `.opencode/**`, project cross-runtime skills), user-scope
  (`~/.config/opencode/**`, `~/.claude/**`, `~/.agents/**`), external-gated
  (parent-directory instructions, the managed config), and install-scope
  (external install scan). The remote-org and MDM layers are recorded with **no
  read** and are therefore absent from the inventory by construction.
- **Declared targets are not reads.** `instructions`/`references` and
  non-package `plugin` specifiers are opaque declarations; the inventory does
  not list them, and the adapter never opens them.
- **`.mcp.json` is not an OpenCode MCP source** and is not listed.

## Hostile-input coverage

| Hostile shape                        | Fixture                                          | Assertion                                                                   |
| ------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------- |
| Escaping symlink at a read candidate | `.opencode/command/link.md` → outside            | recorded once as `skipped`/`symlink-not-followed`; target never read        |
| Symlinked config file                | `.opencode/opencode.json` → outside secret JSON  | recorded once as `skipped`; no `#`-fragment elements parsed from the target |
| Unreadable file                      | `~/.config/opencode/skill/broken/SKILL.md` (000) | recorded `unreadable`; `unreadable-file` diagnostic; completeness `partial` |
| Content a raw read would persist     | instruction/skill/command/agent bodies           | no sentinel appears in any stored artifact or interpretation text           |
| Secret-shaped values                 | `sk-ant-…` in a skill body and a plugin URL      | no secret appears in any stored artifact                                    |
| Config values                        | plugin URL, unknown-key value                    | not persisted as values (kind/count only); sentinel absent                  |
| Read-only run                        | whole project/home/outside tree                  | fingerprints unchanged by a full inspect; only `~/.pfl` is written          |

Two security-invariants assertions are OpenCode-specific in a deliberate way:
the legacy `mode/` directory yields an `unsupported` element pinned to
`.opencode/mode/legacy.md` (so deleting the fixture file fails the test), and
the install-detection case asserts a null version because OpenCode has no
installer-managed version source — a hermetic fixture cannot resolve a version,
and the invariant under test is scope separation. To keep that case
discriminating despite the null version, it now also asserts the grant took
effect (`consent-not-granted:install` is absent) and the user scope is still
closed; the grant-effect assertion was added for all three runtimes.

## Adversarial review of this PR

An independent review of the test/docs diff raised test-validity findings, all
remediated or bounded:

| #   | Severity | Finding                                                                                                   | Disposition                                                                                                                         |
| --- | -------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Critical | The symlinked-config payload carried no tracked marker, so a regression that followed it could still pass | Fixed: the payload is now `{ "mcp": { "<sentinel>": {} } }`; a persisted server name would leak, and the sentinel is in `SENTINELS` |
| 2   | Consider | For OpenCode the `version` field is null in every choke-point case, making it non-discriminating          | Fixed: the install case asserts the grant took effect for every runtime; the user case asserts `consent-not-granted:user` is absent |
| 3   | Consider | The `unsupported` assertion was over-determined (the remote/MDM opaque layers could satisfy it)           | Fixed: pinned to `.opencode/mode/legacy.md`                                                                                         |
| 4   | Consider | `.mcp.json` "not a source" was an unbacked negative                                                       | Fixed: a sentinel-bearing `.mcp.json` fixture plus a negative assertion                                                             |
| 5   | Consider | User cross-runtime skill roots and the project-root config had no fixture                                 | Fixed: `~/.claude/skills`, `~/.agents/skills`, and `<root>/opencode.json` fixtures added                                            |

**Coverage boundaries, stated rather than hidden.** Two doc rows are exercised
only at unit level, not through the integration fixtures: the **managed** config
(the integration `runInspect` path does not inject a managed base, so only
`collectOpencodeHarness` unit tests read one) and the **declared
`instructions`/`references` targets** (unit-tested in
`src/runtime/opencode/discovery.test.ts`, which asserts the opaque element and
the absence of the target string). The `mode(s)/` row names both spellings; the
fixture carries `mode/` only.

## Verification

- Full gate green: `test` (63 files, 572 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`. The `opencode` consent, choke-point, invariants, and
  relation tests all pass.
- `docs/security/read-paths.md`'s closing note ("The M8 choke-point test is
  parameterised by this inventory") now holds for all three adapters, with the
  two unit-level-only rows named above.
