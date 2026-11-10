#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

// ── Config ──
const CONFIG_DIR = join(homedir(), ".rico");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const API_URL = process.env.RICO_URL || "https://cool-rooster-544.convex.site";

// ── Helpers ──

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(prompt) {
  const r = rl();
  return new Promise(resolve => r.question(prompt, ans => { r.close(); resolve(ans.trim()); }));
}

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const bold = t => color("1", t);
const green = t => color("32", t);
const cyan = t => color("36", t);
const yellow = t => color("33", t);
const red = t => color("31", t);
const dim = t => color("2", t);

/**
 * Call the RICO HTTP API. Anything that acts for you sends your API key;
 * tasks are paid for from your prepaid RICO balance.
 */
async function api(method, path, body, apiKey) {
  const base = loadConfig().url || API_URL;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = { error: `Unexpected response (HTTP ${res.status})` }; }
  return { ok: res.ok, status: res.status, data };
}

function needKey(config) {
  if (config.apiKey) return true;
  console.log(red("\n  No API key set."));
  console.log(dim("  Create one at https://rico.delivery under Wallet, then run: rico config --key rico_...\n"));
  return false;
}

// ── Commands ──

async function cmdConfig(args) {
  const config = loadConfig();

  if (args.includes("--key")) {
    const idx = args.indexOf("--key");
    const key = args[idx + 1];
    if (!key || !key.startsWith("rico_")) {
      console.log(red("  Usage: rico config --key rico_..."));
      console.log(dim("  Create a key at https://rico.delivery under Wallet."));
      return;
    }
    // Earlier versions stored a wallet private key here. It is no longer used.
    delete config.privateKey; delete config.wallet; delete config.posterId;
    config.apiKey = key;
    saveConfig(config);
    console.log(green("  API key saved: ") + dim("rico_…" + key.slice(-4)));
    return;
  }

  if (args.includes("--url")) {
    const idx = args.indexOf("--url");
    const url = args[idx + 1];
    if (!url) {
      console.log(red("  Usage: rico config --url https://..."));
      return;
    }
    config.url = url;
    saveConfig(config);
    console.log(green("  API URL set: ") + dim(url));
    return;
  }

  // Show current config
  console.log(bold("\n  RICO Config") + dim(` (${CONFIG_FILE})\n`));
  console.log(`  API key:   ${config.apiKey ? "rico_…" + config.apiKey.slice(-4) : dim("not set")}`);
  console.log(`  API URL:   ${config.url || dim(API_URL)}`);
  console.log();
}

async function cmdPost(args) {
  const config = loadConfig();
  if (!needKey(config)) return;

  console.log(bold("\n  Post a Task\n"));

  const title = await ask(cyan("  Title: "));
  if (!title) return;

  const types = ["delivery", "go-somewhere", "gather-info", "interact", "physical-action", "verification"];
  console.log(dim(`  Types: ${types.join(", ")}`));
  const taskType = await ask(cyan("  Type: ")) || "delivery";

  const fee = parseFloat(await ask(cyan("  Fee (USDC): ")) || "5");

  console.log(dim("\n  Add workflow steps (empty action to finish):"));
  const steps = [];
  let i = 1;
  while (true) {
    const action = await ask(cyan(`  Step ${i} action: `));
    if (!action) break;
    const proofType = await ask(dim(`    Proof (photo/video/text/gps/none): `)) || "photo";
    const location = await ask(dim(`    Location (optional): `));
    const step = { action, proofType };
    if (location) step.locationAddr = location;
    steps.push(step);
    i++;
  }

  const body = {
    title,
    taskType,
    suggestedFee: fee,
  };

  if (steps.length > 0) {
    body.steps = steps.map((s, idx) => ({ ...s, order: idx + 1, status: "pending" }));
    body.details = steps.map((s, idx) => `${idx + 1}. ${s.action}`).join(" → ");
  }

  console.log(dim(`\n  Posting "${title}" ($${fee} USDC)...`));
  const result = await api("POST", "/task", body, config.apiKey);

  if (result.ok) {
    console.log(green("\n  Task posted! ") + dim(`ID: ${result.data.taskId}\n`));
  } else {
    console.log(red("\n  Failed: ") + (result.data.error || JSON.stringify(result.data)));
    if (result.status === 402) console.log(dim("  Top up your balance at https://rico.delivery under Wallet."));
    console.log();
  }
}

async function cmdList() {
  console.log(dim("\n  Fetching open tasks...\n"));
  const result = await api("GET", "/tasks");
  const tasks = result.data.tasks || [];

  if (tasks.length === 0) {
    console.log(dim("  No open tasks.\n"));
    return;
  }

  for (const t of tasks) {
    const runners = t.maxRunners > 1 ? dim(` (${t.acceptedCount || 0}/${t.maxRunners} runners)`) : "";
    console.log(`  ${bold(t.title)}`);
    console.log(`  ${dim(t.taskType)} · ${green("$" + t.suggestedFee + " USDC")}${runners}`);
    if (t.steps) {
      for (const s of t.steps) {
        const icon = s.status === "completed" ? "✓" : "○";
        console.log(dim(`    ${icon} ${s.action}`));
      }
    }
    console.log(dim(`  ID: ${t._id}`));
    console.log();
  }
}

async function cmdGet(args) {
  const taskId = args[0];
  if (!taskId) {
    console.log(red("  Usage: rico get <task-id>\n"));
    return;
  }

  const result = await api("GET", `/task?id=${encodeURIComponent(taskId)}`);
  const task = result.data;

  if (!result.ok) {
    console.log(red("  Task not found.\n"));
    return;
  }

  console.log(bold(`\n  ${task.title}`));
  console.log(`  ${dim(task.taskType)} · ${green("$" + task.suggestedFee + " USDC")} · ${dim(task.status)}`);
  if (task.details) console.log(dim(`  ${task.details}`));

  if (task.steps) {
    console.log(bold("\n  Steps:"));
    for (const s of task.steps) {
      const icon = s.status === "completed" ? green("✓") : s.status === "in_progress" ? yellow("●") : dim("○");
      console.log(`  ${icon} ${s.action} ${dim(`[${s.proofType || "none"}]`)}`);
    }
  }

  console.log(dim(`\n  ID: ${task._id}`));
  console.log(dim(`  Posted: ${new Date(task.createdAt).toLocaleString()}`));
  console.log();
}

async function cmdConfirm(args) {
  const config = loadConfig();
  const taskId = args[0];
  if (!taskId) {
    console.log(red("  Usage: rico confirm <task-id>\n"));
    return;
  }
  if (!needKey(config)) return;

  const rating = parseInt(await ask(cyan("  Rating (1-5): ")) || "5");
  const comment = await ask(dim("  Comment (optional): "));

  const body = { taskId };
  if (rating) body.ratingScore = rating;
  if (comment) body.ratingComment = comment;

  console.log(dim("  Confirming delivery..."));
  const result = await api("POST", "/confirm-delivery", body, config.apiKey);

  if (result.data?.ok) {
    console.log(green(`\n  Confirmed! Payout: $${result.data.payout} USDC\n`));
  } else {
    console.log(red("\n  Failed: ") + (result.data.error || JSON.stringify(result.data)) + "\n");
  }
}

async function cmdCancel(args) {
  const config = loadConfig();
  const taskId = args[0];
  if (!taskId) {
    console.log(red("  Usage: rico cancel <task-id>\n"));
    return;
  }
  if (!needKey(config)) return;

  console.log(dim("  Cancelling task..."));
  const result = await api("POST", "/cancel-task", { taskId }, config.apiKey);

  if (result.ok) {
    console.log(green(`\n  Task cancelled. $${result.data.refund} USDC returned to your RICO balance.\n`));
  } else {
    console.log(red("\n  Failed: ") + (result.data.error || JSON.stringify(result.data)) + "\n");
  }
}

async function cmdBalance() {
  const config = loadConfig();
  if (!needKey(config)) return;
  const result = await api("GET", "/me", null, config.apiKey);
  if (!result.ok) {
    console.log(red("\n  Failed: ") + (result.data.error || JSON.stringify(result.data)) + "\n");
    return;
  }
  console.log(bold("\n  RICO balance: ") + green(`$${result.data.balance.toFixed(2)} USDC`));
  console.log(dim(`  Wallet:  ${result.data.walletAddress}`));
  console.log(dim("  Top up at https://rico.delivery under Wallet.\n"));
}

async function cmdHealth() {
  try {
    const res = await fetch(`${loadConfig().url || API_URL}/health`);
    const data = await res.json();
    console.log(green("\n  RICO is online ") + dim(JSON.stringify(data)) + "\n");
  } catch (e) {
    console.log(red("\n  RICO is unreachable: ") + e.message + "\n");
  }
}

// ── Main ──

const HELP = `
${bold("RICO")} ${dim("— Agent workflows for the real world")}

${bold("Usage:")} rico <command> [options]

${bold("Commands:")}
  ${cyan("post")}              Post a new task (interactive)
  ${cyan("list")}              List open tasks
  ${cyan("get")} <id>          Get task details
  ${cyan("confirm")} <id>      Confirm delivery + release USDC
  ${cyan("cancel")} <id>       Cancel task + refund to your balance
  ${cyan("balance")}           Show your prepaid USDC balance
  ${cyan("health")}            Check server status
  ${cyan("config")}            Show/set configuration

${bold("Config:")}
  rico config --key rico_...    Set your API key (create one at rico.delivery under Wallet)
  rico config --url <url>       Set API URL

${bold("Examples:")}
  ${dim("$ rico config --key rico_abc123...")}
  ${dim("$ rico post")}
  ${dim("$ rico list")}
  ${dim("$ rico confirm abc123")}

${dim("https://rico.delivery")}
`;

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case "post":    await cmdPost(args); break;
  case "list":    await cmdList(); break;
  case "ls":      await cmdList(); break;
  case "get":     await cmdGet(args); break;
  case "confirm": await cmdConfirm(args); break;
  case "cancel":  await cmdCancel(args); break;
  case "balance": await cmdBalance(); break;
  case "health":  await cmdHealth(); break;
  case "config":  await cmdConfig(args); break;
  case "help":    console.log(HELP); break;
  case "--help":  console.log(HELP); break;
  case "-h":      console.log(HELP); break;
  default:        console.log(HELP); break;
}
