# Security review — M7 Phase 6 (runtime version handling and external installs)

- Date: 2026-09-17
- Reviewer: `codex exec -s read-only` (independent model), three passes against the
  uncommitted diff (an initial pass, a follow-up after the ancestor-guard fix, and
  a final pass after the fixture and leaf-symlink test fixes); plus a maintainer
  self-review
- Trigger: trust-boundary changes in `src/runtime/claude-code/detect.ts`,
  `src/runtime/codex/detect.ts`, both `consent.ts`, both `discovery.ts`, and the
  new read path `src/runtime/external-install.ts`
- Result: 3 independent findings, all fixed (two High, one Low); 1 pre-existing
  Medium recorded as a follow-up; the rest checked and dismissed with reasoning

## What changed

Issue #76 makes runtime version handling substantive. `versionPosition` replaces
the boolean range check and separates below/within/above/unknown; detection emits
a distinct `runtime-version-below-verified` diagnostic while a newer-than-verified
version keeps `runtime-version-unverified` and still does not block. `installed`
becomes `yes | no | unknown`, so a not-consented detection is no longer reported
as "not installed". Detection now also finds installs the runtime's installer
does not manage — npm global, Homebrew, PATH-only — by reading a bin directory's
entries and, where a manifest or Cellar version directory exists, reading a
version from it; disagreeing sources raise `runtime-version-disagreement` and the
highest parseable version is used. Each adapter gained a documented
`semanticsFor(version)` that selects its resolution axes and drives resolved
confidence from the version position. `docs/security/read-paths.md` gains the new
reads, and the consent prompt lists them.

## Invariants checked

Read-only, no execution (no new `child_process` / `exec` / `spawn` / dynamic
import), no symlink traversal (leaf **or** ancestor), hardlinks and non-regular
files never opened, consent gating for every new read, deny-by-default
persistence (only normalized versions and fixed labels leave detection),
fail-closed on a symlinked PATH entry or ancestor, best effort with recorded
completeness, and falsifiable tests (roadmap §3.1 / §3.2, ADR 0002).

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                           | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | Pass 1: `src/runtime/external-install.ts`. The bin-dir listing used the directory's parent as the guard base, so a symlinked **ancestor** of a PATH entry (`PATH=/tmp/link/bin`, `/tmp/link -> /etc`, or `~/.local -> /outside`) was traversed even though the leaf was checked. Two tests only covered the leaf. | **Fixed.** Every external-install read now guards from the filesystem root (`readDirectoryNames('/', …)` and `readTextFileGuarded(…, '/')`), so a symlink at any component — leaf, PATH entry, or ancestor — refuses the read. `FILESYSTEM_ROOT` documents why a PATH entry has no scope base. Tests for a symlinked PATH ancestor were added to both adapters; reverting the base to `dirname(dir)` turns both red. On macOS the root walk also refuses paths under `/var` (itself a symlink), which is the fail-closed behavior the invariant asks for and does not affect a canonical home. |
| 2   | High     | Pass 2: `test/integration/runtime-detection.test.ts`. The Claude fixture version file was placed under `…/home/.local/…`, which the repository `.gitignore` excludes via `*.local`; a clean checkout would lack it and the integration test would fail on CI even though it passed locally.                       | **Fixed.** The fixture version source moved to the installer-managed `test/fixtures/claude/home/.claude/.last-update-result.json`, which is not ignored and is a version source the adapter already reads. The fixture-backed test now passes from a clean tree.                                                                                                                                                                                                                                                                                                                               |
| 3   | Low      | Pass 3: no test placed a symlinked npm `package.json` or a symlinked Homebrew formula directory, so removing the leaf guard in `readNpmVersion` would leave the suite green.                                                                                                                                      | **Fixed.** Two tests added: a symlinked npm manifest and a symlinked Cellar formula directory both yield no version while the binary is still detected. Replacing the guarded read with a direct `readFile` turns the manifest test red.                                                                                                                                                                                                                                                                                                                                                       |
| 4   | Medium   | Pass 3: `src/util/fs.ts` `inspectFileTarget` / `readTextFileGuarded` do an `lstat` then open the path, a check-then-use race an attacker could win by swapping a regular file for a symlink.                                                                                                                      | **Pre-existing, already recorded as accepted risk A1 (`docs/security/accepted-risks.md`).** The file is unchanged by this diff and the race is inherent to its `lstat`-then-open design. A1's reopen condition is "a read path is added that takes a security decision from the checked type"; this diff's new reads only ever surface a normalized version string, and no `pfl` decision is taken from the checked type, so A1 still covers it. Reopening the symlink posture (`O_NOFOLLOW`) would require an ADR 0002 update per review-policy §"Changing the rules".                        |

## Dismissed (checked and fine)

- **PATH scanning does not execute anything.** It reads directory entry names and
  a JSON manifest; the no-execution text scan over `src/` still passes and the
  new files import no process or evaluation API.
- **Symlinked launchers are detected but never resolved.** A `claude` / `codex`
  entry that is a symlink appears in the listing by name only; no `realpath`, no
  `stat`, no read of the binary.
- **The disagreement diagnostic leaks nothing.** It names fixed labels
  (`installer update metadata`, `installer releases directory`, `npm global
package`, `Homebrew Cellar`) and normalized versions; the tests assert the
  message does not contain the home directory.
- **Consent gating is unchanged.** Detection — installer-managed and external —
  is called only inside `detect()` / `collect*Harness` under
  `access.allowOutsideProject`; a not-consented run returns `installed: 'unknown'`
  with `consent-not-granted` and reads no installation path. The integration test
  asserts the gate for both adapters.
- **`installed` tri-state is correct.** `yes` only when a source or a binary was
  found, `no` when detection looked and found nothing, `unknown` only when it
  could not look.
- **Below/above are distinct and above does not block.** Detection codes differ;
  resolved confidence is downgraded for both but the elements are still resolved
  best-effort (acceptance criterion 12), asserted by the resolve tests.
- **No new process or dynamic-loading API.** The only `child_process` use in the
  test tree (`mkfifo` in the Claude detect test) predates this diff.

## Follow-up (out of scope for this phase)

None new. The `lstat`-then-read race in `src/util/fs.ts` (finding 4) applies to
every harness read and to the directory listing (`lstat` then `readdir`); it is
pre-existing and already dispositioned as accepted risk **A1**, whose reopen
condition is not met by this diff. Changing the symlink posture would require an
ADR 0002 update, so it is left out of this phase.

## Verification

- Independently reviewed with `codex exec -s read-only` in three passes; each
  finding was confirmed by the next pass after the fix, and the final pass
  reported no new defects.
- Falsifiability, verified by actually reverting the guard and watching the suite
  go red: reverting the external-install guard base to `dirname(dir)` turns the
  two symlinked-ancestor tests red; replacing the guarded npm-manifest read with a
  direct `readFile` turns the symlinked-manifest test red. By inspection:
  removing the consent gate turns the not-consented integration test red;
  collapsing the below diagnostic into the above code turns the below test red.
- Full gate green: `test` (413 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
- End-to-end through the built CLI against a canonical temp home: an npm-global
  `@anthropic-ai/claude-code` `2.1.150` on an injected `PATH` is detected
  (`runtimeVersion: "2.1.150"`, `runtimeCompatibility: "verified"`); a stale
  Codex `releases/0.139.0-…` beside an npm `@openai/codex` `0.154.0` resolves to
  `0.154.0` and raises `runtime-version-disagreement`. A temp base under macOS
  `/var` is refused (no symlink traversal), which is the documented fail-closed
  behavior.
