# Security Policy

## Reporting a vulnerability

Report security issues privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on the [repository](https://github.com/shimpeiws/pfl/security/advisories/new).
Do not open a public issue for a security report.

Include what you can: the affected version, the command or code path, a
reproduction, and the impact you believe it has.

## Response

- Acknowledgement within **3 days**.
- An initial assessment and, where the report is valid, a remediation plan.
- Credit in the release notes if you want it.

## Scope

`pfl` statically inspects coding-agent harness configuration. Because it reads
untrusted harness files from cloned repositories, the trust boundaries that
matter most are:

- reading outside the project without consent (design doc §19),
- following a symlink or hardlink out of a walked tree,
- persisting or displaying content, secrets, or paths that should be redacted
  or allowlisted,
- resource exhaustion on a hostile repository.

The design invariants are listed in [`CLAUDE.md`](CLAUDE.md). The read paths are
enumerated in [`docs/security/read-paths.md`](docs/security/read-paths.md), and
accepted risks are recorded in
[`docs/security/accepted-risks.md`](docs/security/accepted-risks.md).
