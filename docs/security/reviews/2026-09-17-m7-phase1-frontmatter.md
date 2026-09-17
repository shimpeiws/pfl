# Security review — M7 Phase 1 (shared frontmatter parser)

- Date: 2026-09-17
- Reviewer: `codex exec` 0.154.0 (independent model), against the working-tree
  diff of M7 Phase 1
- Trigger: trust-boundary changes in `src/discovery/walk.ts` and
  `src/limits.ts`, and adapter changes in `src/runtime/*/discovery.ts`; a new
  content-derived metadata channel (`src/discovery/frontmatter.ts`)
- Result: 2 "Act on" findings and 2 "Consider" findings; the Act-on findings are
  remediated in this change, one Consider is addressed, one is recorded with its
  reasoning

## What changed

Issue #68 introduces a shared frontmatter reader and wires it into both adapters
so skills, subagents, commands, rules, output styles, and memory files resolve
what they declare instead of being listed by path and digest. The reader returns
only structural facts — declared key names, a description _length_, and declared
tool names. It runs inside `walkHarnessPaths` through an optional
`describeFile(relativePath, content)` callback on the bytes the walk already read
to hash, so raw content never leaves the walk; only the caller's allowlisted,
redacted record is attached to the entry.

## Invariants checked

Read-only, no execution, no symlink traversal, deny-by-default persistence / safe
metadata allowlist, redaction, best effort without silent incompleteness, and
resource ceilings (roadmap §3.1 / §3.2, ADR 0002).

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                                                                                             | Disposition                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Act on   | Arbitrary scalar text was persisted as tool names. `tools: password: hunter2` became `["password:", "hunter2"]`, and the redaction layer could not recognise a low-entropy fragment. Long prose in a tool field left raw fragments. | **Fixed.** A tool candidate must match a tool-name shape (`TOOL_NAME`, an identifier with at most one parenthesized specifier). Prose and `key: value` text are dropped, not fragmented. `splitTools` now delimits only on commas, so a space-containing scalar is never split into plausible-looking tokens. A secret-shaped name remains the redaction layer's responsibility and is masked to `[redacted]`. |
| 2   | Act on   | The parse input was bounded but the metadata _output_ was not. A hostile file could declare hundreds of thousands of tool names and inflate the in-memory snapshot and serialized artifact.                                         | **Fixed.** `MAX_FRONTMATTER_KEYS` (64), `MAX_TOOL_NAMES` (64), and `MAX_TOOL_NAME_LENGTH` (200) bound the record. Exceeding a cap drops the excess and marks the frontmatter malformed, so the adapter records a diagnostic rather than persisting a truncated fragment. Values are shared with the tests.                                                                                                     |
| 3   | Consider | A synchronous `describeFile` callback can block the walk.                                                                                                                                                                           | **Dismissed with reasoning.** The callback is supplied by the shipped adapters, not by untrusted content; harness content cannot select or replace it. There is no extension surface in v1.0 (the unified adapter registry and any hook are M9 and stay internal). An explicit async/timeout contract is deferred to the point where a callback is externally supplied.                                        |
| 4   | Consider | The prototype-pollution test was weaker than it appeared: a reverted implementation storing scalars in a normal object could still pass.                                                                                            | **Addressed.** The test now asserts the complete returned facts object and that `Object.prototype` itself gained no `polluted` property.                                                                                                                                                                                                                                                                       |

## Dismissed (checked and fine)

- No new filesystem read path was introduced: `describeFile` consumes bytes the
  walk already read; `docs/security/read-paths.md` is updated to say so.
- The symlink, hardlink, non-regular-file, entry, depth, and per-file-size guards
  all remain in the walk _before_ parsing.
- The parser is linear and non-recursive; the `MAX_PARSE_BYTES` slice bounds the
  input, and no pattern can backtrack catastrophically.
- Frontmatter keys do not become object properties (they are held in arrays), so
  a hostile key cannot reach a prototype.

## New limits

This change introduces three metadata-shape ceilings. Per `review-policy.md`,
`docs/design/adr/0002-security-hardening.md` §4 is updated to record them.

## Verification

- Falsifiability: reverting the tool-name validation turns the prose-drop test
  red; reverting the caps turns the cap tests red; removing the walk callback
  turns the `walkHarnessPaths` metadata tests red.
- End-to-end: a fixture skill declaring a secret-shaped `allowed-tools` entry
  persists `toolNames: ["Read", "[redacted]"]` — the raw secret is absent and the
  description value is never stored (length only).
- Full gate green: `test` (337), `check`, `format`, `build`, `typecheck:test`,
  `knip`.
