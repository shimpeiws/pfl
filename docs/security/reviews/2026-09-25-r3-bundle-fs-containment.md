# Security review — R3 bundle: checkSymlinkAncestors path containment fix

- Date: 2026-09-25
- Reviewer: Codex (independent model) + Devin AI, against R3 bundle PR
- Trigger: change to `src/util/fs.ts` (trust-boundary path), fixing path
  containment check in `checkSymlinkAncestors`
- Result: Bug fix — no new trust boundaries introduced; containment semantics
  corrected for edge-case directory names

## Change summary

`checkSymlinkAncestors` in `src/util/fs.ts` previously used
`rel.startsWith('..')` to detect paths that escape a base directory. This
matched any relative path beginning with `..`, including legitimate directory
names like `..draft/` (a dot-prefixed project-local directory). The check
was changed to `rel === '..' || rel.startsWith('../')`, which only matches
actual parent-directory traversal (`../`), not directory names that happen to
start with `..`.

## Findings and disposition

| #   | Severity      | Finding                                                                                                                                               | Disposition                                                                                                |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Bug fix       | `rel.startsWith('..')` falsely rejected `..draft/file.md` as `outside-base`, preventing reads of legitimate project-local files                       | **Fixed.** Changed to `rel === '..' \|\| rel.startsWith('../')` — only actual parent traversal is rejected |
| 2   | No regression | The fix does not weaken symlink traversal prevention: `../` paths are still correctly rejected, and the per-component symlink check remains unchanged | Verified by existing symlink tests passing                                                                 |
| 3   | Scope         | This fix is in a shared utility used by `readTextFileGuarded` and `inspectFileTarget`. It affects all callers, not just the bundle feature            | All existing tests pass; the fix is universally correct                                                    |

## Verification

- `checkSymlinkAncestors` returns `outside-base` for `../file.md` (correct)
- `checkSymlinkAncestors` returns `ok` for `..draft/file.md` (correct — no traversal)
- `checkSymlinkAncestors` returns `symlink` for symlinked files (unchanged)
- Full gate green: `test` (677), `check`, `format`, `build`, `typecheck:test`, `knip`
