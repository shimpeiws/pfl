# Security review — M6 Phase 5 (consent wording S2/S4, permissions.json S10)

- Date: 2026-09-17
- Reviewer: `codex exec` (independent model), three passes over the Phase 5 diff
- Trigger: changes in `src/discovery/consent.ts`, `src/runtime/*/consent.ts`,
  `src/runtime/*/detect.ts`, `src/util/fs.ts`
- Result: initially "approve 不可"; all findings remediated across three passes

## Findings and disposition

| #   | Severity             | Finding                                                                                                                                                                                | Disposition                                                                                                                                                                                                                                                                          |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Critical             | Detection read install paths (`~/.local/bin/claude`, `~/.codex/packages/standalone`) the prompt did not list                                                                           | **Fixed.** Installation locations are exported constants; the prompt derives from them and a literal per-adapter test anchors the list                                                                                                                                               |
| 2   | Critical             | `✗ Follow symlinks` was false for a symlinked user config root (`checkSymlinkAncestors` excludes its base)                                                                             | **Fixed by narrowing the claim** to `✗ Follow symlinks inside the listed locations`, which is accurate: the scope base (`$HOME` / home-root prefix) is OS-resolved as a prefix; a symlink inside a searched area or at a fixed target is refused. ADR 0002 §1 and design §24 updated |
| 3   | Critical (re-review) | Detection followed **intermediate** symlinks: `pathExists` / `readDirectoryNames` only `lstat`ed the leaf, so `~/.local -> /outside` was traversed                                     | **Fixed.** Both take a `baseDir` and check every component with `checkSymlinkAncestors`; Claude install uses base `home`, Codex install base `~/.codex`; both call sites guarded; hostile intermediate-symlink tests added                                                           |
| 4   | Warning (re-review)  | The per-adapter test re-derived from the production constants, so a hard-coded read would not be caught; `read-paths.md` said `~/.local/bin` while the code used `~/.local/bin/claude` | **Fixed.** The tests assert an independent literal expectation; `read-paths.md` updated to the exact paths and guard bases. The residual — a read added to discovery without a constant — is stated in the test comment and below                                                    |
| 5   | Warning (re-review)  | `~/.pfl` / `permissions.json` symlinks were still followed by the consent store                                                                                                        | **Fixed.** `loadConsentStore` returns empty and `grantConsent` refuses (exit 6) when the store path is reached through a symlink; test added                                                                                                                                         |
| 6   | Warning              | `grantConsent`'s `mkdir` and directory `chmod` were outside the `try`, so a directory-setup failure escaped as a raw error                                                             | **Fixed.** They are inside the guarded block; failure maps to `PflError(EXIT_CODES.SNAPSHOT_STORE_FAILED)`                                                                                                                                                                           |
| 7   | Consider             | The grant is an atomic file replace but the read-modify-write is not serialized, so two concurrent grants can lose one scope                                                           | **Deferred** to M8, which settles store locking                                                                                                                                                                                                                                      |

## Remaining residual (stated, not fixed)

The consent-group test guarantees the prompt covers the adapter's **declared**
path constants. A read added to discovery with a hard-coded path, not promoted
to a constant, would not be caught. Closing that structurally needs a typed read
registry that both discovery and the consent groups generate from; that is a
larger refactor than M6, and it is recorded here.

## Verification

- Falsifiability: removing the install ancestor guard turns the intermediate
  symlink tests red; removing the store-path guard turns the symlinked-store
  test red; a new constant changes `CONSENT_GROUPS` and turns the literal test
  red.
- Full gate green: `test` (299), `check`, `format`, `build`, `typecheck:test`,
  `knip`.
