# pfl Design Document v0.1

- **Status**: Draft
- **Updated**: 2026-09-15
- **Scope**: Static pre-flight inspection of coding-agent harnesses for Claude Code and Codex
- **Relationship to yuurei**: Inventory describes harness state; yuurei executes isolated runs; a future Analyzer compares harness changes against run outcomes.

---

## 0. Executive Summary

`pfl` — **Pre-Flight Listen for coding-agent harnesses** — is a CLI tool that statically inspects the harness configuration surrounding a coding agent and answers three questions:

1. What harness elements exist?
2. How are they resolved by the target runtime?
3. What can theoretically affect the agent's process or output right now?

The tool does not execute the target coding agent. It does not run discovered tools, skills, hooks, or MCP servers. It reconstructs the effective harness using files, runtime configuration, scope rules, precedence, and known runtime semantics.

The first supported runtimes are:

- `claude-code`
- `codex`

The broader ecosystem is:

```text
pfl
  = Pre-flight harness identity

yuurei
  = Execution identity

Analyzer
  = Comparison of harness changes against
    Outcome / Process / Cost / Reliability
```

Inventory is deliberately independent from execution. A later run may reveal which optional or conditional elements were actually used, but Inventory's responsibility is to describe what could affect the agent according to the current static environment.

---

## 1. Background

Coding-agent harnesses now contain far more than a single instruction file.

A typical environment may include:

- user instructions
- project instructions
- skills
- knowledge sources
- persistent memory
- MCP servers
- tools
- subagents
- delegation rules
- hooks
- permission settings
- approval policies
- context-management behavior
- planning modes
- compaction settings
- runtime-provided instruction layers
- plugins that bundle several of the above

These elements are distributed across project, user/global, managed, plugin, and runtime-provided scopes.

The main problem is not only discovery. The more important problem is resolution.

Examples:

- multiple instruction files may accumulate
- a project setting may override a user setting
- a skill may exist but only be available on demand
- a hook may affect only a matching tool event
- a subagent may have a broader tool surface than the parent context
- a runtime-provided instruction layer may exist but remain opaque
- a newer runtime version may change resolution semantics

A simple file listing does not answer the practical question:

> What harness can affect this agent, in this project, under this runtime?

`pfl` exists to answer that question without executing the agent.

---

## 2. Product Principle

### 2.1 In one sentence

> Statically reconstruct the harness that can affect a coding agent, without executing the coding agent or discovered harness content.

### 2.2 Design principles

1. **Static first** — do not execute the runtime in order to inspect it.
2. **Resolution over listing** — explain not only what exists, but how the runtime resolves it.
3. **Do not infer more than can be supported** — unknown or opaque behavior is recorded as such.
4. **Runtime-native semantics first** — Claude Code and Codex keep their native resolution models.
5. **Normalize meaning, not source format** — native representations remain visible while semantic facets are derived separately.
6. **Preserve provenance** — show where an effective element came from and why it is effective.
7. **Security by default** — do not persist raw harness contents or secrets.
8. **Composable with higher layers** — expose stable snapshot interfaces.
9. **Graph-compatible, not graph-dependent** — support relations from the beginning; advanced graph analysis comes later.
10. **Best effort, never silently incomplete** — unreadable, unsupported, skipped, or unknown elements are recorded.

---

## 3. Naming and Ecosystem Vocabulary

### 3.1 Product name

The product name is:

```text
pfl
```

The formal tagline is:

```text
pfl — Pre-Flight Listen for coding-agent harnesses
```

`pfl` is not merely an abbreviation invented for this tool. It intentionally overlaps with the audio-engineering term **PFL — Pre-Fade Listen**.

On a mixing console, PFL lets an operator monitor a channel before that signal reaches the main mix. In DJ equipment this is closely related to cue monitoring; in studio, broadcast, and live-sound contexts it is a standard way to inspect a channel before putting it on air or into the house mix.

`pfl` maps that idea onto coding-agent harnesses:

```text
profile / harness
       ↓
      pfl       : inspect the signal before execution
       ↓
     yuurei     : run it in an isolated environment
       ↓
   trace / eval : evaluate process and outcome afterward
```

The alternate expansion, **Pre-Flight Listen**, makes the meaning accessible even to users who do not know the audio term:

- **Pre-Flight** — inspect before execution
- **Listen** — observe the harness configuration and behavior it can induce

The abbreviation preserves the rhythm and cultural reference of Pre-Fade Listen while describing the product's role directly.

### 3.2 Relationship to `yuurei`

`yuurei` and `pfl` belong to the same tool family, but they intentionally represent different stages.

```text
pfl
  inspect before execution

yuurei
  isolate and execute

future Analyzer
  evaluate process and outcome
```

`yuurei` itself comes from a different but related audio metaphor: UREI mixer culture combined with the Japanese word 幽霊 (ghost).

Its conceptual mapping is:

```text
UREI / isolator
  separates signals

ghost
  appears temporarily and leaves no permanent trace

yuurei
  creates an isolated temporary harness execution environment
```

`pfl` extends the same studio / control-room vocabulary without reusing the isolation metaphor.

The ecosystem is therefore better imagined as a **studio or control room with multiple pieces of equipment**, not as a single DJ booth.

### 3.3 Naming philosophy

OSS names in this ecosystem are intentionally drawn from music and audio culture rather than being purely functional labels.

Examples:

| OSS | Cultural reference | Function |
|---|---|---|
| `yuurei` | UREI mixer + 幽霊 | isolated agent execution |
| `mumbl` | mumble rap | journaling |
| `barscan` | rap bars + scan | rapper vocabulary analysis |
| `mdub` | dub / dubbing | Markdown ↔ Google Docs sync |
| `pfl` | Pre-Fade Listen / Pre-Flight Listen | pre-execution harness inspection |

The cultural reference should reward discovery, not obscure function.

Therefore:

- README and docs should explain the product function first
- the audio reference should remain visible but secondary
- internal vocabulary should not become gimmicky at the expense of clarity

### 3.4 README opening

Recommended opening:

```md
# pfl

> pfl — Pre-Flight Listen for coding-agent harnesses

Inspect a coding-agent harness before it runs: what's registered as
skills, hooks, instructions, and memory, and how it's wired together.

*Named after the pre-fade listen button on a mixing console — the one you
press to hear a channel before it hits the house.*
```

Japanese explanation:

```md
# pfl

> pfl — Pre-Flight Listen for coding-agent harnesses

コーディングエージェントが実行される前に、ハーネスを点検する。
登録されたskills、hooks、instructions、memoryと、それらがどう接続されているかを解析する。

音響卓のpre-fade listenに由来する。チャンネルが本番のミックスに入る前に、その信号を聴くための機能だ。
```

### 3.5 Distribution names

The intended public names are:

```text
GitHub: shimpeiws/pfl
npm:    @shimpeiws/pfl
CLI:    pfl
```

The unscoped npm package `pfl` already exists, so the npm package uses the `@shimpeiws` scope while preserving `pfl` as the executable command.

Example:

```json
{
  "name": "@shimpeiws/pfl",
  "bin": {
    "pfl": "./dist/cli.js"
  }
}
```

### 3.6 Stable technical vocabulary

Branding and protocol vocabulary are separate.

The following terms are part of the technical model and should remain stable even if product copy changes:

```text
Observed Facts
Resolved Facts
Derived Interpretation

ObservedSnapshot
ResolvedSnapshot

effective
shadowed
conditional
unresolved
unknown

Instructions
Knowledge
Memory
Actions
Delegation
Controls
```

Audio-inspired terms such as `channel`, `patch`, `monitor`, or `cue` may be used later where they clarify the UX, but should not replace precise technical terms merely for theme.

---

## 4. Goals / Non-Goals

### 3.1 Goals

v0.1 aims to provide:

- static inspection of Claude Code
- static inspection of Codex
- runtime-specific harness discovery
- scope and precedence resolution
- effective / shadowed / conditional / unresolved state
- runtime-version-aware resolution confidence
- immutable snapshots and history
- reports, lists, drill-down, graphs, and diffs
- deterministic best-effort semantic classification
- descriptive findings
- safe local persistence
- explicit consent before reading outside the inspected project

### 3.2 Non-Goals

v0.1 does not provide:

- agent execution or dry-run execution
- tool, skill, hook, or MCP execution
- output-quality scoring
- ROI ranking
- automatic harness optimization
- LLM-based classification
- semantic dependency inference from natural language
- cross-runtime harness conversion
- full reconstruction of opaque runtime-provided instructions
- remote/cloud inventory aggregation

---

## 5. Harness Boundary

### 4.1 Included

`pfl` includes anything that can theoretically affect agent process or output through:

```text
Instructions
Knowledge
Memory
Actions
Delegation
Controls
```

These facets are extensible and are not a permanently closed taxonomy.

### 4.2 Excluded: execution context

The following are outside Harness Inventory:

- selected model
- current working directory as an execution variable
- arbitrary environment variables
- API credentials
- process-level timeout
- terminal dimensions
- logging destination
- unrelated CLI execution details

These belong to execution context and are expected to be recorded by yuurei or another execution-layer tool.

### 4.3 Behavioral controls are harness

A setting is harness when it changes agent trajectory.

Included examples:

- plan mode
- max agent turns
- approval policy
- permission constraints
- sandbox behavior
- context compaction behavior
- persistent memory behavior
- hook-based workflow gates

A process-level kill timeout is context. An agent-level turn limit is harness.

---

## 6. Initial Semantic Facets

### Instructions
Defines how the agent should think, behave, or proceed.

### Knowledge
Provides information the agent can consult.

### Memory
Persistent or carried-forward state from prior interactions or runs.

### Actions
Capabilities that let the agent affect or query the external environment.

### Delegation
Capabilities that let the agent pass work to another agent or specialized context.

### Controls
Mechanisms that constrain or shape trajectory.

Facets are additive. Readers must tolerate unknown future facets.

---

## 7. Core Data Model

Harness Inventory separates three conceptual layers:

```text
Observed Facts
     ↓
Resolved Facts
     ↓
Derived Interpretation
```

### 6.1 Observed Facts

Facts directly read from the filesystem or runtime configuration.

Examples:

- file exists
- config key exists
- skill metadata exists
- runtime version
- plugin reference exists
- file digest
- source scope
- MCP definition exists

### 6.2 Resolved Facts

Facts produced by applying deterministic runtime semantics.

Examples:

- project setting overrides user setting
- instruction files accumulate
- skill is available on demand
- hook applies only to a matching event
- element is shadowed
- element is effective
- element applies to a subtree

### 6.3 Derived Interpretation

Recomputable higher-level interpretation.

Examples:

- semantic facets
- report statistics
- findings
- graph projections
- semantic impact in a diff

Derived Interpretation may change when Inventory logic improves. Raw observations do not.

---

## 8. Runtime Adapters

```ts
interface RuntimeAdapter {
  id(): RuntimeId;

  detect(
    project: ProjectContext,
    access: AccessPolicy
  ): Promise<RuntimeDetection>;

  discover(
    project: ProjectContext,
    access: AccessPolicy
  ): Promise<ObservedSnapshot>;

  resolve(
    observed: ObservedSnapshot
  ): Promise<ResolvedSnapshot>;
}
```

Detection reads runtime installation metadata (for example, the installed
version) outside the project, so it obeys the consent boundary (§19) and takes
the same `AccessPolicy` as discovery. Without consent an adapter must not read
user/global locations: detection reports only project-local evidence and leaves
the version unknown.

Initial implementations:

- `ClaudeCodeAdapter`
- `CodexAdapter`

Adapters own:

- known config locations
- known user/project/managed scopes
- native formats
- runtime-specific discovery
- precedence and accumulation rules
- safe metadata extraction
- runtime-version compatibility metadata

Adapters do not own:

- semantic classification
- findings
- graph layout
- quality evaluation

---

## 9. Runtime Scope

Inspection is runtime-specific.

```bash
pfl inspect --runtime claude-code
pfl inspect --runtime codex
```

`pfl` does not inspect all installed runtimes by default.

Stable runtime IDs should match yuurei where possible.

---

## 10. Discovery Model

### 9.1 Follow normal runtime resolution paths

For the selected runtime, `pfl` discovers all relevant known scopes required to reconstruct the effective harness.

### 9.2 Unknown elements

Unknown items inside known runtime-specific discovery areas are not silently ignored.

```json
{
  "path": "~/.claude/new-feature.json",
  "native_kind": "unknown",
  "status": "unclassified",
  "reason": "unsupported-by-adapter"
}
```

Unknown detection is limited to known runtime-specific search areas.

### 9.3 Symlinks

Symlinks are never followed. They are recorded as skipped.

```json
{
  "path": ".claude/skills/foo",
  "status": "skipped",
  "reason": "symlink-not-followed"
}
```

---

## 11. Resolution Model

A single global precedence rank is insufficient.

The normalized model separates:

```text
Native source
Applicability
Resolution semantics
Activation
```

### Native source

```text
project
user
managed
plugin
builtin
unknown
```

### Applicability

```text
global
project
directory-subtree
tool-event
config-rule
runtime-defined
unknown
```

### Resolution semantics

```text
override
accumulate
available
policy
event-pipeline
runtime-defined
unknown
```

### Activation

```text
always
conditional
on-demand
event-driven
unknown
```

An on-demand skill is still effective if it is available to the agent.

For `pfl`:

> Effective means the element can affect agent process or output under the current static environment and runtime semantics.

---

## 12. Builtin / Runtime-Provided Harness

Some runtime-provided layers are known to exist but are not fully observable.

`pfl` records them without pretending their contents are known.

Inspectability values:

```text
observable
known-runtime-provided
opaque
```

Opaque builtin layers are not mixed into content digests as if their contents were known.

---

## 13. Stable Snapshot Interfaces

### 12.1 ObservedSnapshot

```ts
interface ObservedSnapshot {
  schemaVersion: string;
  snapshotId: string;
  capturedAt: string;

  project: {
    id: string;
    displayName: string;
    root: string;
    remote?: string;
  };

  runtime: {
    id: RuntimeId;
    version: string | null;
  };

  adapter: {
    id: string;
    version: string;
    runtimeCompatibility: "verified" | "unverified";
  };

  elements: ObservedElement[];
  diagnostics: Diagnostic[];

  completeness: "complete" | "partial" | "unknown";

  digests: {
    observed: string;
  };
}
```

### 12.2 ObservedElement

```ts
interface ObservedElement {
  id: ElementId;

  native: {
    kind: string;
    origin:
      | "project"
      | "user"
      | "managed"
      | "plugin"
      | "builtin"
      | "unknown";
    scope: string | null;
  };

  source: {
    path?: string;
    digest?: string;
    sizeBytes?: number;
    symlink?: boolean;
  };

  inspectability:
    | "observable"
    | "known-runtime-provided"
    | "opaque";

  metadata: Record<string, SafeMetadataValue>;

  status:
    | "observed"
    | "unreadable"
    | "unsupported"
    | "skipped"
    | "unknown";
}
```

### 12.3 ResolvedSnapshot

```ts
interface ResolvedSnapshot {
  schemaVersion: string;
  observedSnapshotId: string;

  runtime: {
    id: RuntimeId;
    version: string | null;
  };

  resolution: {
    semanticsVersion: string;
    confidence:
      | "verified"
      | "unverified-runtime-version";
  };

  elements: ResolvedElement[];
  relations: Relation[];
  effectiveElementIds: ElementId[];
  diagnostics: Diagnostic[];

  digests: {
    harnessContent: string;
    resolvedSnapshot: string;
  };
}
```

### 12.4 ResolvedElement

```ts
interface ResolvedElement {
  id: ElementId;

  status:
    | "effective"
    | "shadowed"
    | "conditional"
    | "unresolved"
    | "unknown";

  applicability?: {
    type:
      | "global"
      | "project"
      | "directory-subtree"
      | "tool-event"
      | "config-rule"
      | "runtime-defined"
      | "unknown";
    target?: string;
  };

  activation:
    | "always"
    | "conditional"
    | "on-demand"
    | "event-driven"
    | "unknown";

  resolution: {
    strategy:
      | "override"
      | "accumulate"
      | "available"
      | "policy"
      | "event-pipeline"
      | "runtime-defined"
      | "unknown";
    reason?: string;
  };
}
```

---

## 14. Relations and Graph Compatibility

Initial relation types:

```text
contains
discovered-from
accumulates-with
overrides
shadows
resolves-to
applies-to
```

Future milestones may add:

```text
requires
references
allows
uses
conflicts-with
duplicates
related-to
```

Only explicit, statically resolvable edges are required initially.

---

## 15. Snapshot Model

Snapshots are first-class:

```text
inspect → snapshot → report / list / graph / diff
```

Snapshots are immutable.

The system distinguishes an observation event from harness state.

### Harness Content Digest

Represents statically observable harness content.

### Resolved Snapshot Digest

Represents:

```text
harness content
+ runtime identity
+ runtime version
+ resolution semantics version
```

Thus the same harness content under a different runtime version may produce a different resolved snapshot.

---

## 16. Project Identity

For Git repositories:

```text
canonical remote URL
+ canonical repository root
```

For non-Git directories:

```text
canonical absolute path
```

A display name is derived automatically. User aliases are deferred.

---

## 17. Runtime Version Compatibility

`pfl` does not fail solely because the runtime is newer than the adapter's verified range.

Instead:

- Observed Facts are still collected.
- Resolved Facts are still produced best-effort.
- A visible compatibility warning is attached.
- Resolution confidence is downgraded.

Example:

```text
⚠ Runtime version 1.8.0 has not been verified against this adapter.
  Resolution results are best-effort and may be incomplete.
```

This is distinct from scan completeness.

---

## 18. Completeness and Diagnostics

Inspection is best-effort.

Unreadable, unsupported, skipped, or unknown elements do not abort the inspection.

Snapshot completeness:

```text
complete
partial
unknown
```

No numeric completeness score is used.

---

## 19. Security Model

### Read-only
`pfl` never modifies discovered harness files.

### No execution
`pfl` never executes the runtime, discovered tools, skills, scripts, hooks, or MCP servers.

### Consent boundary
Project-local discovery is implicit.

Reading outside the project requires explicit consent, stored per:

```text
runtime + scope
```

Runtime presence and version detection is a read outside the project and is
part of the same boundary. Without consent, detection leaves the version
unknown rather than reading user/global installation metadata; it never runs
the runtime to learn the version.

### No symlink traversal
Symlinks are recorded but never followed.

### Persistence policy
Persistence is deny-by-default.

Persist:

- existence
- structure
- relationships
- safe metadata
- digests

Do not persist:

- raw instruction text
- raw memory content
- raw knowledge content
- secret values
- auth headers
- tokens
- passwords
- environment values
- arbitrary command arguments

### Safe metadata allowlist
Each adapter explicitly defines metadata fields that may be persisted.

Unknown fields are not persisted automatically.

### Display vs persistence

```text
Interactive terminal
  richer

Machine-readable export
  safer

Snapshot persistence
  safest
```

---

## 20. Redaction

Redaction uses two layers.

### Common policy

Covers:

- token-like values
- secrets
- passwords
- authorization headers
- URL credentials
- sensitive query parameters
- environment values
- unknown sensitive-looking values

### Runtime-specific policy

Adapters add Claude Code / Codex-specific rules.

---

## 21. Derived Interpretation

```ts
interface Interpretation {
  interpretationId: string;
  resolvedSnapshotId: string;

  classifier: {
    id: string;
    version: string;
  };

  elements: {
    elementId: ElementId;
    facets: HarnessFacet[];
    confidence:
      | "high"
      | "medium"
      | "low"
      | "unknown";
  }[];

  stats: HarnessStats;
  findings: Finding[];
}
```

Classification is:

- deterministic
- local
- LLM-free
- best-effort
- inspectable

Native facts remain authoritative even when semantic classification is imperfect.

A future optional LLM enrichment mode may exist, but LLM access is not required for normal operation.

---

## 22. Findings

Findings provide descriptive interpretation without judging harness quality.

Initial rule candidates:

```text
shadowed-element
conflicting-scope
opaque-runtime-layer
broad-tool-access
conditional-heavy
memory-enabled
subtree-specific-instruction
```

Findings do not say:

```text
good
bad
better
worse
recommended
ROI-positive
```

---

## 23. CLI

```bash
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

Default snapshot for read commands is `latest`.

---

## 24. First-Run Consent UX

```text
$ pfl inspect --runtime claude-code

Inventory needs read-only access to the following locations:

  Project
    ./CLAUDE.md
    ./.claude/**

  User
    ~/.claude/settings.json
    ~/.claude/skills/**
    ~/.claude/agents/**
    ~/.claude/projects/**/memory/**

  Installation and version metadata
    ~/.local/share/claude/versions/**

  External references
    Plugin directories referenced by Claude Code config
    MCP configuration metadata

Inventory will:
  ✓ Read files needed to resolve the effective harness
  ✓ Check the installed runtime version
  ✓ Process content locally
  ✓ Store only digests and allowlisted metadata
  ✗ Store file contents
  ✗ Store environment values or credentials
  ✗ Execute Claude Code or any discovered tool
  ✗ Follow symlinks

Allow this runtime scope? [y/N]
```

---

## 25. Inspect Output

```text
$ pfl inspect --runtime claude-code

Inspecting Claude Code harness...

Observed       31 elements
Effective      24
Conditional     5
Shadowed        2
Opaque layers   2

Snapshot
  observed   obs_abc123
  resolved   res_def456

⚠ Claude Code 1.8.0 is newer than the verified adapter range.
  Resolution results are best-effort.

Run:
  pfl report
  pfl graph
  pfl diff
```

---

## 26. Report Output

```text
Harness Report
Claude Code · shimpeiws/yuurei

Effective elements       24
Shadowed                  2
Conditional               5
Opaque runtime layers     2

Semantic facets
  Instructions            8
  Knowledge               3
  Memory                  1
  Actions                 6
  Delegation              2
  Controls                7

Notable
  Project permissions override user-level defaults
  5 skills are available on demand
  Auto-memory is enabled
  2 runtime-provided instruction layers are opaque
```

The report interprets structure, but does not evaluate whether the harness is good or bad.

---

## 27. Graph Output

The initial graph answers:

```text
Where did this come from?
↓
How was it resolved?
↓
What is effective now?
```

Example:

```text
user
├─ ~/.claude/CLAUDE.md
│    └─ accumulates →
│
├─ ~/.claude/settings.json
│    └─ permissionMode = default
│
project
├─ ./CLAUDE.md
│    └─ accumulates →
│
└─ ./.claude/settings.local.json
     └─ permissionMode = plan
          └─ overrides →
             user permissionMode

effective
├─ instructions
│    ├─ ~/.claude/CLAUDE.md
│    └─ ./CLAUDE.md
│
└─ permissionMode = plan
```

Advanced semantic dependency graphs are deferred.

---

## 28. Diff

Diff is descriptive, not evaluative.

It has three levels:

```text
Structural change
↓
Effective-state change
↓
Semantic facet change
```

Example:

```text
Harness Diff
Snapshot A → B

Changes
  + 3 added
  - 1 removed
  ~ 4 changed

Effective changes
  + 2 newly effective
  - 1 no longer effective
  ~ 1 activation changed

Semantic impact
  Instructions  +2
  Knowledge      0
  Memory         0
  Actions       -1
  Delegation     0
  Controls      +2
```

`pfl` does not say whether the change improved or harmed outcomes.

---

## 29. Storage

`pfl` stores data under the user's home directory rather than modifying the inspected repository.

```text
~/.pfl/
  permissions.json
  projects/
    <project-id>/
      observations/
      snapshots/
      interpretations/
      latest
```

No project-local `.inventory/` directory is required in v0.1.

---

## 30. Implementation Milestones

### M1 — Discovery

- runtime detection
- project identity
- user/project discovery
- consent
- safe metadata
- diagnostics
- immutable ObservedSnapshot

### M2 — Resolution

- precedence
- accumulation
- applicability
- activation
- effective / shadowed / conditional
- runtime-version confidence
- ResolvedSnapshot

### M3 — Semantic Inventory

- initial six semantic facets
- deterministic classifier
- report
- stats
- findings

### M4a — Explicit Graph

Add statically provable relations such as:

```text
contains
requires
imports
references
allows
overrides
shadows
```

### M4b — Inferred Graph

Deferred.

May include:

```text
uses
depends-on
conflicts-with
duplicates
related-to
```

This phase may require semantic analysis or optional LLM enrichment.

### M5 — Analysis Integration

Connect Inventory snapshots and diffs to the future Analyzer, which compares:

```text
Harness changes
against
Outcome
Process
Cost
Reliability
```

---

## 31. Initial Discovery Scope

### 30.1 Claude Code

v0.1 should inspect, where statically discoverable:

- `CLAUDE.md`
- rules
- skills
- legacy commands if present
- subagents
- hooks
- permissions
- approval policies
- MCP configuration
- output-style related configuration
- persistent memory
- plugin-provided harness elements
- known runtime-provided opaque instruction layers

### 30.2 Codex

v0.1 should inspect, where statically discoverable:

- `AGENTS.md`
- `AGENTS.override.md`
- fallback instruction files
- skills
- skill dependencies
- custom agents
- multi-agent configuration
- MCP configuration
- hooks
- permissions
- approval/sandbox configuration
- memory-related configuration
- compaction/context controls that affect agent trajectory
- known runtime-provided opaque instruction layers

The exact file paths and resolution rules remain runtime-adapter implementation details and may vary by runtime version.

---

## 32. Acceptance Criteria for v0.1

v0.1 is usable when all of the following are true:

1. `pfl inspect --runtime claude-code` produces a snapshot without executing Claude Code.
2. `pfl inspect --runtime codex` produces a snapshot without executing Codex.
3. The tool distinguishes Observed Facts, Resolved Facts, and Derived Interpretation.
4. Raw harness file contents are not persisted.
5. Secrets and environment values are not persisted.
6. Symlinks are not followed.
7. User/global scope access requires explicit consent.
8. Unreadable and unsupported elements are reported, not silently ignored.
9. Reports show element counts, effective/shadowed/conditional state, semantic facet counts, and descriptive findings.
10. Graphs show provenance and resolution.
11. Diffs show structural changes, effective changes, and semantic facet changes.
12. Newer-than-verified runtime versions produce a warning but do not block inspection.
13. Snapshots are immutable.

---

## 33. Open Questions / Deferred Decisions

- ~~exact snapshot serialization format~~ — decided in [ADR 0001](adr/0001-snapshot-serialization-and-ids.md)
- ~~exact schema versioning policy~~ — decided in [ADR 0001](adr/0001-snapshot-serialization-and-ids.md)
- exact snapshot retention / garbage collection
- exact terminal graph renderer
- exact export format policy
- optional project aliases
- optional future LLM enrichment
- additional runtimes
- advanced semantic graph analysis
- automatic comparison with yuurei traces

---

## 34. Relationship to yuurei and the Future Analyzer

```text
pfl
  What can affect the agent before execution?
  └─ ObservedSnapshot
  └─ ResolvedSnapshot
  └─ Diff

yuurei
  What happened during execution?
  └─ Trace
  └─ Artifacts
  └─ Usage

Analyzer
  What changed and what did it cause?
  └─ Outcome
  └─ Process
  └─ Cost
  └─ Reliability
```

`pfl` deliberately stops before causal evaluation.

Its job is to make harness state inspectable, measurable, and comparable before execution.

---

## 35. Summary of Design Decisions

- Support Claude Code and Codex first
- Inspect one runtime at a time
- Never execute the runtime during inspection
- Follow all relevant known runtime resolution paths
- Require consent before reading outside the project
- Never follow symlinks
- Preserve unknown elements inside known runtime search areas
- Use immutable snapshots
- Separate Observed Facts, Resolved Facts, and Derived Interpretation
- Keep raw content out of persisted snapshots
- Use digest + safe metadata instead
- Classify into extensible semantic facets
- Start with Instructions / Knowledge / Memory / Actions / Delegation / Controls
- Make classification deterministic and LLM-free in v0.1
- Make graph support incremental
- Focus the initial graph on provenance and resolution
- Keep findings descriptive, not evaluative
- Keep diff descriptive, not evaluative
- Warn on unverified runtime versions without stopping
- Keep runtime-provided opaque layers visible
- Store state under `~/.pfl/`, not inside the inspected project
