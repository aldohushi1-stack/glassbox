# Security policy

Glassbox reads the most sensitive files on a developer's machine: Claude Code transcripts. If you find a way it could leak them, run something it shouldn't, or be tampered with, please tell me privately first.

## Reporting a vulnerability

- **Preferred:** GitHub's private reporting on this repository: **Security → Report a vulnerability**.
- **Or email:** hi@aldo.ltd, with "Glassbox security" in the subject.

Please **don't** open a public issue, pull request or discussion for a security problem, and don't include real secrets or real transcripts. A minimal, made-up reproduction is best.

What to include: the version (`glassbox --version`), your OS and Node version, the command or page involved, and what an attacker could do.

What happens next:

- I aim to acknowledge a report within **3 business days** (Adelaide, Australia time).
- I'll confirm whether it's a vulnerability, agree a fix date with you, and credit you in the CHANGELOG unless you'd rather not be named.
- Fixes ship as a new npm release through the published workflow (below). Please give me a reasonable window, normally up to 90 days, before disclosing publicly.

Glassbox is maintained by one person, Aldo Hushi (BlueprintAU, Adelaide). There is no bug bounty.

## Supported versions

Only the **latest release** on npm (`glassbox-trace`) gets security fixes. Pin a version for stability, then move to the fixed release when one is announced.

## In scope

- Any way a report made for sharing (`check --redact`, `--legend`, `collect`, `fence`, the viewer's **Export redacted**) carries transcript text, a file path, a secret value, or anything that lets a reader recover one.
- Any network request made by the CLI, the hooks or `dist/glassbox.html`. There should be none.
- The hooks (`Stop`, `SessionStart`, the `PreToolUse` guard): anything that makes them approve a tool call, change its input, run a command, or block when they shouldn't.
- `fence --shred` corrupting or losing a file beyond the values it replaces.
- Path handling, file writes outside the locations listed in [docs/IT.md](docs/IT.md) §4, or anything a crafted transcript can make Glassbox do.
- The release pipeline: a way to publish a package that didn't come from this repository's workflow.

## Out of scope

- Secrets Claude Code itself writes to disk (report those to Anthropic). `glassbox fence` exists to find them.
- Findings that need an attacker who already runs code as the same user.
- Detection gaps in `fence` (a format it doesn't know) are welcome as ordinary issues, not security reports, as long as the issue contains no real secret.

## Verifying what you run

- **No runtime dependencies.** `package.json` has no `dependencies`; nothing else is installed with Glassbox.
- **Provenance.** Every release is built and published by [`.github/workflows/publish.yml`](.github/workflows/publish.yml) with `npm publish --provenance`. npm shows the commit and workflow for each version, and `npm audit signatures` checks it after install.
- **Pin it.** `npx glassbox-trace@<version>` or `npm i -g glassbox-trace@<version>`. Or review the source once and host that copy internally.
- **No network.** Open `dist/glassbox.html` with the browser's network panel open: one entry, the file. The test suite fails any build that references anything outside itself.

What Glassbox reads, writes, runs and sends is listed in [docs/IT.md](docs/IT.md).
