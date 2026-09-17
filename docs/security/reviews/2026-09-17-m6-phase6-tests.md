# Security review — M6 Phase 6 (test credibility)

- Date: 2026-09-17
- Reviewer: Claude Code (`claude --print`, no tools; diff-only review — Codex was
  rate-limited)
- Trigger: test-only changes plus `src/version.ts`
- Result: "no regression, improves the suite", with findings that were closed in
  a follow-up commit

The reviewer had no filesystem or tool access, so its file-specific claims were
verified against the code before acting; the substantive ones held.

## Findings and disposition

| #   | Finding                                                                                                                                                      | Disposition                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The Codex deny test could be vacuous: a content sentinel is never persisted regardless of consent, so `not.toContain(sentinel)` proves nothing about consent | **Fixed.** A grant-side contrast test asserts user-origin elements appear once consent is granted, which makes the deny assertion (no user element) meaningful. The sentinels were confirmed present in the fixtures |
| 2   | The no-execution guard had no positive control; a scan that found zero files would stay green                                                                | **Fixed.** The walk asserts it scanned at least one file, and a canary test proves the patterns match known-bad input                                                                                                |
| 3   | `artifacts.length > 0` only proves the store is non-empty (the pointer alone satisfies it)                                                                   | **Fixed.** The persistence test also asserts a body marker (`"schemaVersion"`), so the snapshot artifacts were read                                                                                                  |
| 4   | `src/version.ts` resolving `../package.json` from the packed layout was untested                                                                             | **Fixed.** An end-to-end test compares `pfl --version` with `package.json` from the built `dist`                                                                                                                     |
| 5   | The no-execution patterns still missed `createRequire`, bare `'vm'`, `Function(`, `execFileSync`, `worker_threads`                                           | **Fixed.** Patterns widened; a comment states the scan is a tripwire, not a proof, and notes the type-position `import()` false-positive risk                                                                        |
| 6   | The read-only test left `<home>/.claude.json` (outside `<home>/.claude`) uncovered, and skipped symlink retargeting                                          | **Fixed.** It fingerprints the whole home except `.pfl`, plus the out-of-project fixture, and records symlink targets                                                                                                |
| 7   | The Codex end-to-end test asserted only exit 0 and `Observed`, so a silent Claude Code fallback or empty harness would pass                                  | **Fixed.** It asserts Codex-specific provenance (`~/.codex`), the `codex@` runtime id, and exercises `show` and `diff`                                                                                               |
| 8   | Per-runtime consent was untested                                                                                                                             | **Fixed.** A test grants Claude Code and asserts a Codex non-interactive run still exits 5                                                                                                                           |
| 9   | Hostile TOML did not test prototype pollution                                                                                                                | **Fixed.** `readTomlFacts` builds its map with `Object.create(null)`, and a test asserts `Object.prototype` is untouched; a duplicate-key test pins last-wins                                                        |
| 10  | The allowlist contract ("unknown fields are not persisted") was only tested through a secret value that redaction would also remove                          | **Fixed.** A dedicated unknown non-secret field is asserted absent from the persisted elements                                                                                                                       |

## Residuals (stated, not fixed)

- The no-execution guard is a text scan: obfuscation evades it, and type-position
  `import()` would false-positive. It has no false positives in `src` today.
- `readStoreArtifacts` is not filtered by extension; a future non-UTF-8 artifact
  would make it throw. It is test-only and can be narrowed when that happens.
- The TOML reader does not itself enforce the parse-size ceiling; it is enforced
  by `readTextFileGuarded` before the reader runs and is covered by the adapter's
  oversized `config.toml` test.

## Verification

- 309 tests pass; `check`, `format`, `build`, `typecheck:test`, `knip` green.
- Positive controls and the canary make the previously vacuous paths
  falsifiable; the TOML prototype test fails if the null-prototype map is
  reverted.
