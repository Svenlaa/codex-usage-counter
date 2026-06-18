# Codex Usage Counter

This is an AI-built utility repo created with Codex.

Small Node.js script that reads local Codex session history from `~/.codex/sessions`,
groups usage by month, and estimates API cost per model.

## Usage

```bash
./codex-usage.js
```

Show more history:

```bash
./codex-usage.js --months 6
```

Read from a custom sessions directory:

```bash
./codex-usage.js --months 12 ~/.codex/sessions
```

The script defaults to the latest 3 months and prints monthly model cost totals in
a compact terminal table.
