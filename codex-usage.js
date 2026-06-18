#!/usr/bin/env node

import fs from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const HOME = os.homedir();
const DEFAULT_MONTHS = 3;
const DEFAULT_SESSIONS_DIR = path.join(HOME, ".codex", "sessions");
const JETBRAINS_CACHE_DIR = path.join(HOME, ".cache", "JetBrains");

// USD per 1M tokens. Update here if your account uses a different tier.
// Source checked 2026-06-18: https://developers.openai.com/api/docs/pricing
const PRICES = Object.freeze({
  "gpt-5.5": { input: 5.0, cachedInput: 0.5, output: 30.0 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15.0 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14.0 },

  // Older local session names may no longer appear on the current pricing page.
  // Keep these explicit so the estimate remains useful and easy to override.
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14.0 },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10.0 },
});

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionDirs = options.sessionDirs.length ? options.sessionDirs : await discoverDefaultSessionDirs();
  await validateSessionDirs(sessionDirs, options.sessionDirs.length > 0);

  const files = await listJsonlFiles(sessionDirs);
  const report = await buildUsageReport(files);
  const months = [...report.months].sort().slice(-options.months);

  printReport(report, months);
}

function parseArgs(args) {
  if (args.includes("-h") || args.includes("--help")) printUsageAndExit(0);

  const options = {
    months: DEFAULT_MONTHS,
    sessionDirs: [],
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--") continue;

    if (arg === "--months" || arg === "-m") {
      options.months = parsePositiveInteger(args[++index], "--months");
      continue;
    }

    if (arg.startsWith("--months=")) {
      options.months = parsePositiveInteger(arg.slice("--months=".length), "--months");
      continue;
    }

    if (arg.startsWith("-")) printUsageAndExit(1);
    options.sessionDirs.push(expandHome(arg));
  }

  return options;
}

function printUsageAndExit(exitCode) {
  console.log(`Usage: node codex-usage.js [--months N] [sessions-dir ...]

Reads Codex JSONL session history and prints monthly token/cost totals.
Defaults to the latest ${DEFAULT_MONTHS} months.
Default session dirs:
  ${DEFAULT_SESSIONS_DIR}
  ${path.join(JETBRAINS_CACHE_DIR, "*", "aia", "codex", "sessions")}
`);
  process.exit(exitCode);
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function expandHome(value) {
  if (value === "~") return HOME;
  if (value.startsWith("~/")) return path.join(HOME, value.slice(2));
  return value;
}

async function discoverDefaultSessionDirs() {
  const candidates = [DEFAULT_SESSIONS_DIR];

  if (await pathExists(JETBRAINS_CACHE_DIR)) {
    const products = await readdir(JETBRAINS_CACHE_DIR, { withFileTypes: true });
    candidates.push(
      ...products
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(JETBRAINS_CACHE_DIR, entry.name, "aia", "codex", "sessions")),
    );
  }

  return dedupePaths(await filterExistingPaths(candidates));
}

async function filterExistingPaths(paths) {
  const existing = await Promise.all(
    paths.map(async (candidate) => ((await pathExists(candidate)) ? candidate : null)),
  );
  return existing.filter(Boolean);
}

async function validateSessionDirs(sessionDirs, throwOnMissing) {
  const missing = [];

  for (const sessionDir of sessionDirs) {
    if (!(await pathExists(sessionDir))) missing.push(sessionDir);
  }

  if (missing.length && throwOnMissing) {
    throw new Error(`Session directory not found: ${missing.join(", ")}`);
  }
}

async function pathExists(candidate) {
  try {
    await fs.promises.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function dedupePaths(paths) {
  const seen = new Set();
  return paths.filter((candidate) => {
    const key = fs.realpathSync(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function listJsonlFiles(roots) {
  const files = [];
  const stack = [...roots];

  while (stack.length) {
    const dir = stack.pop();
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  }

  return files.sort();
}

async function buildUsageReport(files) {
  const report = {
    byModelMonth: new Map(),
    months: new Set(),
    unpricedModels: new Set(),
  };

  for (const file of files) {
    for await (const entry of readSessionUsage(file)) {
      addUsage(report, entry);
    }
  }

  return report;
}

async function* readSessionUsage(file) {
  let currentModel = "unknown";
  let previousTotal = null;
  const fallbackMonth = inferMonthFromPath(file);

  const lines = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    const record = parseJsonLine(line);
    if (!record) continue;

    const payload = record.payload ?? {};
    if (record.type === "turn_context" && payload.model) {
      currentModel = normalizeModelName(payload.model);
      continue;
    }

    if (record.type !== "event_msg" || payload.type !== "token_count") continue;

    const total = normalizeUsage(payload.info?.total_token_usage);
    if (!total) continue;

    const usage = previousTotal ? usageDelta(previousTotal, total) : total;
    previousTotal = total;
    if (isZeroUsage(usage)) continue;

    yield {
      model: currentModel,
      month: monthFromTimestamp(record.timestamp) ?? fallbackMonth ?? "unknown",
      usage,
    };
  }
}

function parseJsonLine(line) {
  if (!line.trim()) return null;

  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeModelName(model) {
  return String(model).replace(/\[(?:low|medium|high|xhigh)\]$/, "");
}

function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    inputTokens: numberOrZero(usage.input_tokens),
    cachedInputTokens: numberOrZero(usage.cached_input_tokens),
    outputTokens: numberOrZero(usage.output_tokens),
  };
}

function usageDelta(previous, current) {
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
  };
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function isZeroUsage(usage) {
  return usage.inputTokens === 0 && usage.cachedInputTokens === 0 && usage.outputTokens === 0;
}

function monthFromTimestamp(timestamp) {
  return typeof timestamp === "string" ? timestamp.match(/^(\d{4})-(\d{2})/)?.slice(1, 3).join("-") : null;
}

function inferMonthFromPath(file) {
  const parts = file.split(path.sep);
  const yearIndex = parts.findIndex((part, index) => /^\d{4}$/.test(part) && /^\d{2}$/.test(parts[index + 1] ?? ""));
  return yearIndex === -1 ? null : `${parts[yearIndex]}-${parts[yearIndex + 1]}`;
}

function addUsage(report, { model, month, usage }) {
  report.months.add(month);
  const bucket = getBucket(report.byModelMonth, model, month);

  bucket.inputTokens += usage.inputTokens;
  bucket.cachedInputTokens += usage.cachedInputTokens;
  bucket.outputTokens += usage.outputTokens;

  const price = PRICES[model];
  if (price) {
    bucket.cost += calculateCost(usage, price);
  } else {
    report.unpricedModels.add(model);
  }
}

function getBucket(map, model, month) {
  const key = bucketKey(model, month);
  if (!map.has(key)) {
    map.set(key, { model, month, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 });
  }
  return map.get(key);
}

function bucketKey(model, month) {
  return `${model}\0${month}`;
}

function calculateCost(usage, price) {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  return (uncached * price.input + cached * price.cachedInput + usage.outputTokens * price.output) / 1_000_000;
}

function printReport(report, months) {
  if (!months.length) {
    console.log("No token usage found.");
    return;
  }

  if (report.unpricedModels.size) {
    console.log(`Unpriced models counted as $0 cost: ${[...report.unpricedModels].sort().join(", ")}`);
    console.log("");
  }

  const models = uniqueModels(report.byModelMonth);
  const rows = months.map((month) => makeMonthCostRow(report.byModelMonth, models, month));
  rows.push(makeTotalCostRow(report.byModelMonth, models, months));
  printTable(rows);
}

function uniqueModels(byModelMonth) {
  return [...new Set([...byModelMonth.values()].map(({ model }) => model))].sort();
}

function makeMonthCostRow(byModelMonth, models, month) {
  const costs = models
    .map((model) => [model, byModelMonth.get(bucketKey(model, month))?.cost ?? 0])
    .filter(([, cost]) => cost > 0);

  return [month, formatModelCosts(costs), formatMoney(sumCosts(costs))];
}

function makeTotalCostRow(byModelMonth, models, months) {
  const monthSet = new Set(months);
  const costs = models
    .map((model) => [
      model,
      [...byModelMonth.values()]
        .filter((bucket) => bucket.model === model && monthSet.has(bucket.month))
        .reduce((sum, bucket) => sum + bucket.cost, 0),
    ])
    .filter(([, cost]) => cost > 0);

  return ["TOTAL", formatModelCosts(costs), formatMoney(sumCosts(costs))];
}

function formatModelCosts(costs) {
  return costs.length ? costs.map(([model, cost]) => `${model}  ${formatMoney(cost)}`).join("\n") : "-";
}

function sumCosts(costs) {
  return costs.reduce((sum, [, cost]) => sum + cost, 0);
}

function printTable(rows) {
  const widths = columnWidths(rows);
  const divider = widths.map((width) => "-".repeat(width + 2)).join("+");

  rows.forEach((row, index) => {
    if (index > 0) console.log(divider);
    expandMultilineRow(row).forEach((line) => console.log(formatTableRow(line, widths)));
  });
}

function columnWidths(rows) {
  return [0, 1, 2].map((index) =>
    Math.max(...rows.flatMap((row) => splitCell(row[index]).map((line) => line.length))),
  );
}

function expandMultilineRow(row) {
  const columns = row.map(splitCell);
  const height = Math.max(...columns.map((column) => column.length));

  return Array.from({ length: height }, (_, rowIndex) => columns.map((column) => column[rowIndex] ?? ""));
}

function splitCell(cell) {
  return String(cell ?? "").split("\n");
}

function formatTableRow(row, widths) {
  return row
    .map((cell, index) => {
      const value = String(cell ?? "");
      const padded = index === 0 ? value.padEnd(widths[index]) : value.padStart(widths[index]);
      return ` ${padded} `;
    })
    .join("|");
}

function formatMoney(value) {
  return moneyFormatter.format(value);
}
