#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const JETBRAINS_CACHE_DIR = path.join(os.homedir(), ".cache", "JetBrains");

// USD per 1M tokens. Update here if your account uses a different tier.
// Source checked 2026-06-18: https://developers.openai.com/api/docs/pricing
const PRICES = {
  "gpt-5.5": { input: 5.0, cachedInput: 0.5, output: 30.0 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14.0 },

  // Older local session names may no longer appear on the current pricing page.
  // Keep these explicit so the estimate remains useful and easy to override.
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14.0 },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10.0 },
};

function usage(exitCode = 0) {
  console.log(`Usage: node codex-usage.js [--months N] [sessions-dir ...]

Reads Codex JSONL session history and prints monthly token/cost totals.
Defaults to the latest 3 months.
Default session dirs:
  ${DEFAULT_SESSIONS_DIR}
  ${path.join(JETBRAINS_CACHE_DIR, "*", "aia", "codex", "sessions")}
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  if (argv.includes("-h") || argv.includes("--help")) usage(0);

  let months = 3;
  let sessionsDirs = [];
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--months" || arg === "-m") {
      const value = argv[++i];
      months = parsePositiveInteger(value, "--months");
      continue;
    }

    if (arg.startsWith("--months=")) {
      months = parsePositiveInteger(arg.slice("--months=".length), "--months");
      continue;
    }

    if (arg.startsWith("-")) usage(1);
    positional.push(arg);
  }

  sessionsDirs = positional.length ? positional.map(expandHome) : discoverDefaultSessionDirs();
  return { sessionsDirs, months };
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function main() {
  const { sessionsDirs, months: maxMonths } = parseArgs(process.argv.slice(2));
  for (const sessionsDir of sessionsDirs) {
    if (!fs.existsSync(sessionsDir)) {
      throw new Error(`Session directory not found: ${sessionsDir}`);
    }
  }

  const files = listJsonlFiles(sessionsDirs);
  const byModelMonth = new Map();
  const months = new Set();
  const unpricedModels = new Set();

  for (const file of files) {
    await readSessionFile(file, (entry) => {
      const { model, month, usage } = entry;
      months.add(month);
      const bucket = getBucket(byModelMonth, model, month);
      bucket.input += usage.input_tokens;
      bucket.cachedInput += usage.cached_input_tokens;
      bucket.output += usage.output_tokens;

      const price = PRICES[model];
      if (price) {
        bucket.cost += calculateCost(usage, price);
      } else {
        unpricedModels.add(model);
      }
    });
  }

  printReport(byModelMonth, [...months].sort().slice(-maxMonths), unpricedModels);
}

function discoverDefaultSessionDirs() {
  const dirs = [];
  if (fs.existsSync(DEFAULT_SESSIONS_DIR)) dirs.push(DEFAULT_SESSIONS_DIR);

  if (fs.existsSync(JETBRAINS_CACHE_DIR)) {
    for (const entry of fs.readdirSync(JETBRAINS_CACHE_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionsDir = path.join(JETBRAINS_CACHE_DIR, entry.name, "aia", "codex", "sessions");
      if (fs.existsSync(sessionsDir)) dirs.push(sessionsDir);
    }
  }

  return dedupePaths(dirs);
}

function dedupePaths(paths) {
  const seen = new Set();
  const result = [];

  for (const candidate of paths) {
    const key = fs.existsSync(candidate) ? fs.realpathSync(candidate) : path.resolve(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }

  return result;
}

function listJsonlFiles(roots) {
  const files = [];
  const stack = [...roots];

  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  }

  return files.sort();
}

async function readSessionFile(file, onUsage) {
  let currentModel = "unknown";
  let previousTotal = null;
  const monthFromPath = inferMonthFromPath(file);

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = record.payload || {};
    if (record.type === "turn_context" && payload.model) {
      currentModel = payload.model;
      continue;
    }

    if (record.type !== "event_msg" || payload.type !== "token_count") continue;
    const total = normalizeUsage(payload.info && payload.info.total_token_usage);
    if (!total) continue;

    const delta = previousTotal ? usageDelta(previousTotal, total) : total;
    previousTotal = total;
    if (isZeroUsage(delta)) continue;

    onUsage({
      model: currentModel,
      month: monthFromTimestamp(record.timestamp) || monthFromPath || "unknown",
      usage: delta,
    });
  }
}

function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: numberOrZero(usage.input_tokens),
    cached_input_tokens: numberOrZero(usage.cached_input_tokens),
    output_tokens: numberOrZero(usage.output_tokens),
  };
}

function usageDelta(previous, current) {
  return {
    input_tokens: Math.max(0, current.input_tokens - previous.input_tokens),
    cached_input_tokens: Math.max(0, current.cached_input_tokens - previous.cached_input_tokens),
    output_tokens: Math.max(0, current.output_tokens - previous.output_tokens),
  };
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function isZeroUsage(usage) {
  return usage.input_tokens === 0 && usage.cached_input_tokens === 0 && usage.output_tokens === 0;
}

function monthFromTimestamp(timestamp) {
  if (typeof timestamp !== "string" || timestamp.length < 7) return null;
  const match = timestamp.match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function inferMonthFromPath(file) {
  const parts = file.split(path.sep);
  for (let i = 0; i < parts.length - 1; i++) {
    if (/^\d{4}$/.test(parts[i]) && /^\d{2}$/.test(parts[i + 1])) {
      return `${parts[i]}-${parts[i + 1]}`;
    }
  }
  return null;
}

function getBucket(map, model, month) {
  const key = `${model}\0${month}`;
  if (!map.has(key)) {
    map.set(key, { model, month, input: 0, cachedInput: 0, output: 0, cost: 0 });
  }
  return map.get(key);
}

function calculateCost(usage, price) {
  const cached = Math.min(usage.cached_input_tokens, usage.input_tokens);
  const uncached = usage.input_tokens - cached;
  return (
    (uncached * price.input + cached * price.cachedInput + usage.output_tokens * price.output) /
    1_000_000
  );
}

function printReport(byModelMonth, months, unpricedModels) {
  if (!months.length) {
    console.log("No token usage found.");
    return;
  }

  const models = [...new Set([...byModelMonth.values()].map((bucket) => bucket.model))].sort();
  const rows = months.map((month) => makeMonthCostRow(byModelMonth, models, month));
  rows.push(makeGrandTotalCostRow(byModelMonth, models, months));

  if (unpricedModels.size) {
    console.log(`Unpriced models counted as $0 cost: ${[...unpricedModels].sort().join(", ")}`);
    console.log("");
  }
  printTable(rows);
}

function makeMonthCostRow(byModelMonth, models, month) {
  let totalCost = 0;
  const modelCosts = [];

  for (const model of models) {
    const bucket = byModelMonth.get(`${model}\0${month}`) || {};
    const cost = bucket.cost || 0;
    if (cost === 0) continue;

    totalCost += cost;
    modelCosts.push(`${model} -> ${formatMoney(cost)}`);
  }

  return [month, modelCosts.join("\n") || "-", formatMoney(totalCost)];
}

function makeGrandTotalCostRow(byModelMonth, models, months) {
  let grandCost = 0;
  const modelCosts = [];
  const monthSet = new Set(months);

  for (const model of models) {
    let cost = 0;
    for (const bucket of byModelMonth.values()) {
      if (bucket.model !== model) continue;
      if (!monthSet.has(bucket.month)) continue;
      cost += bucket.cost;
    }
    if (cost === 0) continue;

    grandCost += cost;
    modelCosts.push(`${model} -> ${formatMoney(cost)}`);
  }

  return ["TOTAL", modelCosts.join("\n") || "-", formatMoney(grandCost)];
}

function printTable(rows) {
  const widths = [0, 1, 2].map((index) => {
    return Math.max(
      ...rows.flatMap((row) => String(row[index] == null ? "" : row[index]).split("\n").map((line) => line.length)),
    );
  });

  const divider = widths.map((width) => "-".repeat(width + 2)).join("+");
  rows.forEach((row, index) => {
    if (index > 0) console.log(divider);
    for (const line of expandMultilineRow(row)) {
      console.log(formatTableRow(line, widths));
    }
  });
}

function expandMultilineRow(row) {
  const columns = row.map((cell) => String(cell == null ? "" : cell).split("\n"));
  const height = Math.max(...columns.map((column) => column.length));
  const lines = [];

  for (let i = 0; i < height; i++) {
    lines.push(columns.map((column) => column[i] || ""));
  }

  return lines;
}

function formatTableRow(row, widths) {
  return row
    .map((cell, index) => {
      const value = String(cell == null ? "" : cell);
      const padded = index === 0 ? value.padEnd(widths[index]) : value.padStart(widths[index]);
      return ` ${padded} `;
    })
    .join("|");
}

function formatTokens(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatMoney(value) {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
