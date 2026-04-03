#!/usr/bin/env node

import { createWalletClient, http, parseUnits } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

// ── Config ──
const CONFIG_DIR = join(homedir(), ".rico");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const API_URL = process.env.RICO_URL || "https://cool-rooster-544.convex.site";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

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

async function apiCall(path, body, privateKey) {
  const url = `${API_URL}${path}`;

  // First call — may get 402
  const res1 = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res1.status !== 402) {
    return { status: res1.status, data: await res1.json() };
  }

  // 402 — need to pay
  if (!privateKey) {
    const data = await res1.json();
    const amount = data.accepts?.[0]?.maxAmountRequired;
    const usdc = amount ? (parseInt(amount) / 1e6).toFixed(2) : "?";
    console.log(red(`\n  Payment required: $${usdc} USDC`));
    console.log(dim("  Run: rico config --key 0x... to set your wallet\n"));
    process.exit(1);
  }

  const paymentInfo = await res1.json();
  const requirements = paymentInfo.accepts?.[0];
  if (!requirements) {
    console.log(red("  No payment requirements in 402 response"));
    process.exit(1);
  }

  console.log(yellow(`  Paying $${(parseInt(requirements.maxAmountRequired) / 1e6).toFixed(2)} USDC...`));

  // Sign x402 payment
  const paymentHeader = await signX402Payment(requirements, privateKey);

  // Retry with payment
  const res2 = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment": paymentHeader,
    },
    body: JSON.stringify(body),
  });

  return { status: res2.status, data: await res2.json() };
}

async function signX402Payment(requirements, privateKey) {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  const amount = BigInt(requirements.maxAmountRequired);
  const payTo = requirements.payTo;
  const nonce = BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, "0")).join(""));
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + (requirements.maxTimeoutSeconds || 300));

  const domain = {
    name: requirements.extra?.name || "USD Coin",
    version: requirements.extra?.version || "2",
    chainId: 8453n,
    verifyingContract: USDC_ADDRESS,
  };

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const message = {
    from: account.address,
    to: payTo,
    value: amount,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await client.signTypedData({ domain, types, primaryType: "TransferWithAuthorization", message });

  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: payTo,
        value: amount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce: nonce.toString(),
      },
    },
  };

  return btoa(JSON.stringify(payload));
}

async function convexQuery(functionName, args) {
  const url = `${API_URL.replace(".site", ".cloud")}/api/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: functionName, args }),
  });
  return await res.json();
}

// ── Commands ──

async function cmdConfig(args) {
  const config = loadConfig();

  if (args.includes("--key")) {
    const idx = args.indexOf("--key");
    const key = args[idx + 1];
    if (!key || !key.startsWith("0x")) {
      console.log(red("  Usage: rico config --key 0x..."));
      return;
    }
    config.privateKey = key;
    const account = privateKeyToAccount(key);
    config.wallet = account.address;
    saveConfig(config);
    console.log(green("  Wallet configured: ") + dim(account.address));
    return;
  }

  if (args.includes("--poster")) {
    const idx = args.indexOf("--poster");
    const id = args[idx + 1];
    if (!id) {
      console.log(red("  Usage: rico config --poster <convex-user-id>"));
      return;
    }
    config.posterId = id;
    saveConfig(config);
    console.log(green("  Poster ID set: ") + dim(id));
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
  console.log(`  Wallet:    ${config.wallet || dim("not set")}`);
  console.log(`  Poster ID: ${config.posterId || dim("not set")}`);
  console.log(`  API URL:   ${config.url || dim(API_URL)}`);
  console.log();
}

async function cmdPost(args) {
  const config = loadConfig();
  if (!config.privateKey) {
    console.log(red("\n  No wallet configured."));
    console.log(dim("  Run: rico config --key 0x...\n"));
    return;
  }
  if (!config.posterId) {
    console.log(red("\n  No poster ID configured."));
    console.log(dim("  Run: rico config --poster <your-convex-user-id>\n"));
    return;
  }

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
    posterId: config.posterId,
  };

  if (steps.length > 0) {
    body.steps = steps.map((s, idx) => ({ ...s, order: idx + 1, status: "pending" }));
    body.details = steps.map((s, idx) => `${idx + 1}. ${s.action}`).join(" → ");
  }

  console.log(dim(`\n  Posting "${title}" ($${fee} USDC)...`));
  const result = await apiCall("/task", body, config.privateKey);

  if (result.data?.taskId) {
    console.log(green("\n  Task posted! ") + dim(`ID: ${result.data.taskId}\n`));
  } else {
    console.log(red("\n  Failed: ") + JSON.stringify(result.data) + "\n");
  }
}

async function cmdList() {
  console.log(dim("\n  Fetching open tasks...\n"));
  const result = await convexQuery("tasks:listOpen", {});
  const tasks = result.value || [];

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

  const result = await convexQuery("tasks:getTask", { taskId });
  const task = result.value;

  if (!task) {
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
  if (!taskId || !config.posterId) {
    console.log(red("  Usage: rico confirm <task-id>"));
    if (!config.posterId) console.log(dim("  Run: rico config --poster <id>"));
    console.log();
    return;
  }

  const rating = parseInt(await ask(cyan("  Rating (1-5): ")) || "5");
  const comment = await ask(dim("  Comment (optional): "));

  const body = { taskId, posterId: config.posterId };
  if (rating) body.ratingScore = rating;
  if (comment) body.ratingComment = comment;

  console.log(dim("  Confirming delivery..."));
  const result = await apiCall("/confirm-delivery", body, config.privateKey);

  if (result.data?.ok) {
    console.log(green(`\n  Confirmed! Payout: $${result.data.payout} USDC`));
    if (result.data.txHash) console.log(dim(`  TX: ${result.data.txHash}`));
    console.log();
  } else {
    console.log(red("\n  Failed: ") + JSON.stringify(result.data) + "\n");
  }
}

async function cmdCancel(args) {
  const config = loadConfig();
  const taskId = args[0];
  if (!taskId || !config.posterId) {
    console.log(red("  Usage: rico cancel <task-id>"));
    if (!config.posterId) console.log(dim("  Run: rico config --poster <id>"));
    console.log();
    return;
  }

  const body = { taskId, posterId: config.posterId };
  console.log(dim("  Cancelling task..."));
  const result = await apiCall("/cancel-task", body, config.privateKey);

  if (result.data?.ok || result.status === 200) {
    console.log(green("\n  Task cancelled. USDC refunded.\n"));
  } else {
    console.log(red("\n  Failed: ") + JSON.stringify(result.data) + "\n");
  }
}

async function cmdHealth() {
  try {
    const res = await fetch(`${API_URL}/health`);
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
  ${cyan("cancel")} <id>       Cancel task + refund
  ${cyan("health")}            Check server status
  ${cyan("config")}            Show/set configuration

${bold("Config:")}
  rico config --key 0x...       Set wallet private key
  rico config --poster <id>     Set your Convex user ID
  rico config --url <url>       Set API URL

${bold("Examples:")}
  ${dim("$ rico config --key 0xabc123...")}
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
  case "health":  await cmdHealth(); break;
  case "config":  await cmdConfig(args); break;
  case "help":    console.log(HELP); break;
  case "--help":  console.log(HELP); break;
  case "-h":      console.log(HELP); break;
  default:        console.log(HELP); break;
}
