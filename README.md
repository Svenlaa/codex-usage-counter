# Codex Usage Counter

This is an AI-built utility repo created with Codex.

Small Node.js script that reads local Codex session history, groups usage by
month, and estimates API cost per model.

By default it scans both normal Codex history and JetBrains-managed Codex ACP
history:

```text
~/.codex/sessions
~/.cache/JetBrains/*/aia/codex/sessions
```

## Usage

```bash
./codex-usage.js
```

Or with pnpm:

```bash
pnpm start
```

Show more history:

```bash
./codex-usage.js --months 6
```

Read from one or more custom sessions directories:

```bash
./codex-usage.js --months 12 ~/.codex/sessions ~/.cache/JetBrains/PhpStorm2026.1/aia/codex/sessions
```

The script defaults to the latest 3 months and prints monthly model cost totals in
a compact terminal table.
