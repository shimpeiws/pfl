# Security review — M9 OpenCode adapter (#93)

- Date: 2026-09-18
- Reviewer: independent adversarial review (Claude Code CLI; the codex reviewer
  was rate-limited until 2026-09-19) plus maintainer disposition. Three passes:
  an initial review, a re-review after the first fixes, and a confirmation pass.
- Trigger: new trust-boundary paths — `src/runtime/opencode/paths.ts`,
  `src/runtime/opencode/detect.ts`, `src/runtime/opencode/consent.ts` — plus
  `src/runtime/external-install.ts` and `src/runtime/version-compat.ts` changed.
- Result: three CRITICAL findings, all remediated; no trust-boundary regression
  remained at the confirmation pass.

## What changed

Issue #93 adds the third runtime adapter (`opencode`): discovery, resolution,
classification, consent groups, detection, redaction, and a bounded JSONC reader.
The model is `docs/design/opencode-model.md` (authoritative, version-pinned).
`src/runtime/external-install.ts` makes `npmPackage` optional (OpenCode's npm
package name is not verified); `src/runtime/version-compat.ts` adds a discrete
`VersionSet` (the verified versions are 1.18.0/1.18.30/1.18.31, not a range).
Shared `commands`/`subagents`/`model-configuration`/`compaction-controls`/
`shell-environment`/`project-configuration` facet mappings moved to the core
table because a third adapter made them shared; `CLASSIFIER_VERSION` 4→5.

## Trust-boundary check

- **Reads are declared and consent-classified.** Project-local reads are
  implicit; `~/.config/opencode/**`, `~/.claude/**`, `~/.agents/**`, the managed
  scope, and parent-directory instructions are gated on the `user` grant;
  install detection is gated on `install`. `consent.ts` derives the prompt from
  the same constants discovery uses, and `consent.test.ts` pins them literally.
- **`.mcp.json` is not read**; MCP server names come only from the `mcp` key of
  an `opencode.json[c]` (model doc §4).
- **Declared targets are never opened.** The `instructions` array and
  `references` key yield opaque elements; only a derived target _kind_ is
  persisted. Now also enforced for `plugin` specifiers (finding 3).
- **Symlinks/hardlinks/non-regular files are refused** by the shared walk and
  `readTextFileGuarded`; the project instruction walk re-checks the candidate
  name per entry so a symlink is not misrecorded as an instruction (found during
  self-review, fixed before review — finding 4).
- **Persistence is deny-by-default.** Counts, names, key names, and booleans
  only; a per-string cap (`MAX_METADATA_STRING`) and per-key element cap
  (`MAX_CONFIG_ITEMS`) bound what one hostile config can contribute. Redaction
  runs before the allowlist at the `persistence` tier.

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                                                    | Disposition                                                                                                                                                                                                     |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Critical | A declared `instructions` target (config array entry) was resolved as an `accumulate`/`always` instruction, and classified `high` confidence — asserting behavior for content never opened | Fixed: `axesFor` routes an `opaque` instruction to `config-rule`/`available`/`on-demand` (like `references`), and `classifyElement` caps an opaque element's confidence at `unknown`. Both covered by new tests |
| 2   | Critical | The unknown-config-key loop was the one uncapped element producer; a hostile 1 MiB document could mint ~10^5 elements                                                                      | Fixed: the unmodelled keys are computed, a `config-items-truncated` diagnostic is emitted past `MAX_CONFIG_ITEMS`, and at most that many are recorded; tested with 300 keys                                     |
| 3   | Critical | `pluginNames` persisted an author-controlled URL/path specifier verbatim; redaction cannot de-identify a host/path/org name                                                                | Fixed: only a bare npm-style specifier is persisted as a name; a URL/path/glob specifier is persisted as its _kind_ in `pluginTargetKinds`. Tested with a secret-bearing URL; `pluginNames` is empty            |
| 4   | Critical | Symlinks and non-regular entries bypass the walk's `selectFile`, so the project instruction walk recorded arbitrary symlinks as `instructions`                                             | Fixed during self-review: the candidate name/path is re-checked for every entry kind, and `kindForEntry` re-applies `selectFile`. Tested with a non-candidate symlink and a symlinked command                   |
| 5   | Medium   | Agent/subagent name collisions were keyed on pfl's kind, hiding a real one-namespace collision, and counted skipped symlinks as definitions                                                | Fixed: `catalogIdentity` normalizes `agents`/`subagents` to one namespace and ignores non-`observed` elements; tested                                                                                           |
| 6   | Medium   | A malformed frontmatter block could still flip an element's kind (the local `mode` reader diverged from the shared reader)                                                                 | Fixed: the scalar read runs only when `!read.malformed`; otherwise the conservative `subagents` default applies                                                                                                 |
| 7   | Medium   | `ambiguous-config-form` false-positived on a symlinked config file (normal for chezmoi/stow/yadm), which pfl never reads                                                                   | Fixed: only `status === 'ok'` regular files count                                                                                                                                                               |
| 8   | Medium   | Remote-org and MDM opaque layers were consent-gated despite performing no filesystem read                                                                                                  | Fixed: emitted outside the consent branch; consent gates reads, and these perform none                                                                                                                          |
| 9   | Medium   | Author-controlled fragment keys (`unknown_…`, `agent.<name>`, …) reached `source.path` unbounded                                                                                           | Fixed: capped with `capMetadataString` before `withFragment`                                                                                                                                                    |
| 10  | Medium   | Plugin truncation was silent; a non-string `instructions`/`references` entry was dropped with no element                                                                                   | Fixed: a truncation diagnostic is emitted, and the non-string entry is recorded `unsupported`                                                                                                                   |
| 11  | Low      | `OPENCODE_REDACTION_RULES` enumerated providers and omitted ANTHROPIC/OPENAI, a maintenance trap                                                                                           | Fixed: replaced with a provider-agnostic `PROVIDER_…_KEY\|TOKEN\|SECRET=` shape rule                                                                                                                            |
| 12  | Low      | JSONC stripped `/*…*/` to nothing, so `1/*c*/2` became `12` — a document the runtime rejects was accepted with different data                                                              | Fixed: a space is emitted in place of the comment; tested with `{"a":1/*c*/2}`                                                                                                                                  |
| 13  | Low      | `ruleCount` counted top-level keys while allow/ask/deny counted nested decisions, so the figures did not reconcile                                                                         | Renamed to `topLevelRuleCount` with a comment                                                                                                                                                                   |
| 14  | Low      | The consent prompt listed `MCP configuration metadata`, a read that does not exist separately (MCP is inline in the config already listed)                                                 | Removed                                                                                                                                                                                                         |
| 15  | Low      | `agentMode` persisted an arbitrary config string                                                                                                                                           | Normalized to `primary`/`subagent`/`other`                                                                                                                                                                      |

### Deliberately not changed (documented, not risks)

- Remote/MDM are opaque `config`-kind elements rather than diagnostics; the
  model doc and the M9 handoff specify an opaque `remote-org` element, and an
  opaque, unresolved layer is the honest encoding. Noted as a deliberate
  divergence from a reviewer preference.
- Ancestor instructions keep `origin: 'project'`, `scope: 'project'` — the
  existing Claude Code/Codex convention; applicability recovers location from
  the `../` path.
- An undeclared agent `mode` defaults to `subagents`, per the handoff's
  "record conservatively"; `agentMode` is only persisted when declared.
- `versionSetPosition` returns `unknown` for both an in-span non-member and an
  unparseable version; the diagnostic message disambiguates, and this matches
  the other adapters' use of `runtime-version-unverified`.

## Verification

- The three CRITICALs were fixed across two review rounds; the confirmation pass
  ("CRITICAL still open: none") confirmed both blockers close, and the one
  remaining discriminating check — that the opaque-confidence guard does not
  change Claude Code or Codex output — was run: the only opaque emitter outside
  OpenCode is the shared `builtinLayer` (`runtime-provided-instructions`, already
  `unknown`). No Claude/Codex golden moves beyond the `classifierVersion` bump.
- Full gate green: `test` (63 files, 554 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
- The #94 read-path inventory and the parameterised choke-point test are a
  separate change and extend this review.
