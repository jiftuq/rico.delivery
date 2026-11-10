// End-to-end security and money-flow checks for the Convex backend.
//
// Runs against a throwaway local backend, never production:
//   1. CONVEX_AGENT_MODE=anonymous npx convex dev      (leave running)
//   2. node scripts/e2e-backend.mjs
//
// It signs in with freshly generated wallets, funds them through the internal
// creditDeposit function (as a verified deposit would), and then checks that
// nobody can act as someone else and that balances and escrow always add up.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(ROOT + "package.json");
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");
const { ConvexError } = require("convex/values");
const { privateKeyToAccount, generatePrivateKey } = require("viem/accounts");
const api = anyApi;
const URL_ = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const SITE = process.env.CONVEX_SITE_URL || "http://127.0.0.1:3211";
if (!/127\.0\.0\.1|localhost/.test(URL_)) throw new Error("Refusing to run against a non-local backend");
const c = new ConvexHttpClient(URL_);
let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "  -> " + extra : "")); };
const msg = (e) => (e instanceof ConvexError ? String(e.data) : e.message);
const rejects = async (p, name, re) => { try { await p; ok(false, name, "was allowed"); } catch (e) { ok(!re || re.test(msg(e)), name, msg(e).slice(0, 90)); } };
const run = (fn, args) => JSON.parse(execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)], { cwd: ROOT, env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) || "null");
const bal = async (u) => (await c.query(api.auth.me, { token: u.token })).balance;
const near = (a, b) => Math.abs(a - b) < 1e-9;

async function signIn() {
  const acct = privateKeyToAccount(generatePrivateKey());
  const { nonce, message } = await c.action(api.auth.startSignIn, { walletAddress: acct.address, origin: "http://localhost:5173" });
  const signature = await acct.signMessage({ message });
  const s = await c.action(api.auth.finishSignIn, { nonce, signature });
  return { ...s, acct, nonce, signature, message };
}
const fund = (u, usdc) => run("wallet:creditDeposit", { userId: u.userId, txHash: "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join(""), amountMicro: usdc * 1e6, blockNumber: 1 });
const task = (u, over = {}) => c.mutation(api.tasks.create, { token: u.token, title: "Test", category: "info", details: "d", taskType: "gather-info", locationAddr: "Somewhere 1", locationLat: 50.85, locationLng: 4.35, suggestedFee: 5, ...over });
const bid = (u, taskId, fee) => c.mutation(api.tasks.placeBid, { token: u.token, taskId, fee, comment: "", lat: 50, lng: 4, tripKm: 1 });

console.log("Sign-in");
const poster = await signIn(), runner = await signIn(), runner2 = await signIn(), mallory = await signIn();
ok(poster.token.length === 64 && poster.message.includes("localhost:5173 wants you to sign in"), "wallet signature gives a session");
ok((await c.query(api.auth.me, { token: poster.token })).walletAddress === poster.acct.address, "me returns the signed-in wallet");
ok((await c.query(api.auth.me, { token: "f".repeat(64) })) === null, "unknown token is nobody");
await rejects(c.action(api.auth.finishSignIn, { nonce: poster.nonce, signature: poster.signature }), "signature cannot be replayed", /expired|already used/);
{ const a = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
  const { nonce, message } = await c.action(api.auth.startSignIn, { walletAddress: a.address });
  ok(message.startsWith("rico.delivery wants you"), "unlisted origin falls back to rico.delivery");
  await rejects(c.action(api.auth.finishSignIn, { nonce, signature: await other.signMessage({ message }) }), "another wallet's signature is refused", /does not match/); }

console.log("Posting needs money");
await rejects(task(poster), "post with empty balance is refused", /Insufficient balance/);
ok((await c.query(api.tasks.listOpen, {})).every(t => t.posterId !== poster.userId), "refused post leaves no task behind");
await rejects(task(poster, { suggestedFee: 0 }), "zero-fee task is refused", /above zero/);
await rejects(task(poster, { suggestedFee: -5 }), "negative fee is refused", /negative/);
await fund(poster, 100);
ok(near(await bal(poster), 100), "deposit credits balance");
const t1 = await task(poster);
ok(near(await bal(poster), 95), "posting takes escrow from balance");

console.log("Nobody can act as someone else");
await rejects(c.mutation(api.tasks.cancel, { token: mallory.token, taskId: t1 }), "stranger cannot cancel", /Cannot cancel/);
await rejects(c.mutation(api.tasks.create, { posterId: poster.userId, title: "x", category: "info", details: "d", suggestedFee: 1 }), "user ID instead of token is refused");
await rejects(bid(poster, t1, 5), "poster cannot bid on own task", /Own task/);
const b1 = await bid(runner, t1, 6);
await rejects(c.mutation(api.tasks.acceptBid, { token: mallory.token, taskId: t1, bidId: b1 }), "stranger cannot accept a bid", /Cannot accept/);
await rejects(c.mutation(api.tasks.acceptBid, { token: runner.token, taskId: t1, bidId: b1 }), "runner cannot accept own bid", /Cannot accept/);
const acc = await c.mutation(api.tasks.acceptBid, { token: poster.token, taskId: t1, bidId: b1 });
ok(near(acc.charged, 1) && near(await bal(poster), 94), "higher bid charges the difference", JSON.stringify(acc));
await rejects(c.mutation(api.tasks.markDelivered, { token: mallory.token, taskId: t1 }), "stranger cannot mark delivered", /Cannot mark/);
await rejects(c.mutation(api.tasks.confirmDelivery, { token: runner.token, taskId: t1 }), "runner cannot confirm own work", /Unauthorized/);
await rejects(c.mutation(api.chat.send, { token: mallory.token, taskId: t1, text: "hi" }), "stranger cannot chat", /Unauthorized/);
await c.mutation(api.chat.send, { token: runner.token, taskId: t1, text: "on my way" });
ok((await c.query(api.chat.list, { token: mallory.token, taskId: t1 })).length === 0, "stranger cannot read chat");
ok((await c.query(api.chat.list, { token: poster.token, taskId: t1 })).length >= 2, "poster reads chat");
await rejects(c.mutation(api.tasks.cancel, { token: poster.token, taskId: t1 }), "cannot cancel once in progress", /Cannot cancel/);
for (const fn of ["tasks:resolveDispute", "tasks:autoRelease", "tasks:refundStuck", "wallet:creditDeposit", "wallet:finishWithdrawal", "payments:processWithdrawals"]) {
  const [m, f] = fn.split(":");
  const call = fn.startsWith("payments") ? c.action(api[m][f], {}) : c.mutation(api[m][f], { taskId: t1, resolution: "courier", userId: mallory.userId, txHash: "0x1", amountMicro: 1e9, blockNumber: 1 });
  await rejects(call, `${fn} is not callable from outside`);
}

console.log("Payout");
await c.mutation(api.tasks.markDelivered, { token: runner.token, taskId: t1, proofData: "done" });
const conf = await c.mutation(api.tasks.confirmDelivery, { token: poster.token, taskId: t1, ratingScore: 5 });
ok(near(conf.payout, 5.58) && near(conf.burn, 0.42), "runner gets fee minus 7%", JSON.stringify(conf));
await rejects(c.mutation(api.tasks.confirmDelivery, { token: poster.token, taskId: t1 }), "cannot confirm twice", /Cannot confirm/);
await new Promise(r => setTimeout(r, 4000));
const rs = await c.query(api.wallet.summary, { token: runner.token });
ok(rs.withdrawals[0]?.status === "failed" && near(rs.balance, 5.58), "payout with no platform key fails safe back to balance", `${rs.withdrawals[0]?.status}, balance ${rs.balance}`);
ok(near((await c.query(api.tasks.getTask, { taskId: t1 })).escrowMicro, 0), "task escrow is empty after payout");

console.log("Cancel and refund");
const t2 = await task(poster, { suggestedFee: 10 });
ok(near(await bal(poster), 84), "second task escrowed");
const can = await c.mutation(api.tasks.cancel, { token: poster.token, taskId: t2 });
ok(near(can.refund, 10) && near(await bal(poster), 94), "cancel refunds to balance");
await rejects(c.mutation(api.tasks.cancel, { token: poster.token, taskId: t2 }), "cannot cancel twice", /Cannot cancel/);

console.log("Multi-runner");
const t3 = await task(poster, { suggestedFee: 3, maxRunners: 2 });
ok(near(await bal(poster), 88), "multi-runner escrow = fee x runners");
const m1 = await bid(runner, t3, 2), m2 = await bid(runner2, t3, 4);
await c.mutation(api.tasks.acceptBid, { token: poster.token, taskId: t3, bidId: m1 });
ok(near(await bal(poster), 89), "lower bid refunds the difference");
await rejects(c.mutation(api.tasks.cancel, { token: poster.token, taskId: t3 }), "cannot cancel after accepting a runner", /already been accepted/);
await c.mutation(api.tasks.acceptBid, { token: poster.token, taskId: t3, bidId: m2 });
ok(near(await bal(poster), 88), "higher bid charges the difference");
await c.mutation(api.tasks.markDelivered, { token: runner.token, taskId: t3 });
await c.mutation(api.tasks.markDelivered, { token: runner2.token, taskId: t3 });
await rejects(c.mutation(api.tasks.confirmDelivery, { token: poster.token, taskId: t3, runnerId: mallory.userId }), "cannot pay someone not on the task", /not delivered/);
await c.mutation(api.tasks.confirmDelivery, { token: poster.token, taskId: t3, runnerId: runner.userId });
await rejects(c.mutation(api.tasks.confirmDelivery, { token: poster.token, taskId: t3, runnerId: runner.userId }), "cannot pay the same runner twice", /not delivered/);
await c.mutation(api.tasks.confirmDelivery, { token: poster.token, taskId: t3, runnerId: runner2.userId });
const t3d = await c.query(api.tasks.getTask, { taskId: t3 });
ok(t3d.status === "completed" && t3d.escrowMicro === 0 && near(await bal(poster), 88), "multi-runner task settles to zero", `${t3d.status}, escrow ${t3d.escrowMicro}`);

console.log("Insufficient balance on accept");
const poor = await signIn(); await fund(poor, 5);
const t4 = await task(poor); const b4 = await bid(runner, t4, 50);
await rejects(c.mutation(api.tasks.acceptBid, { token: poor.token, taskId: t4, bidId: b4 }), "cannot accept a bid the balance cannot cover", /Insufficient balance/);
ok((await c.query(api.tasks.getTask, { taskId: t4 })).status === "open", "refused accept leaves the task open");

console.log("Withdrawals");
await rejects(c.mutation(api.wallet.requestWithdrawal, { token: poster.token, amount: 1000 }), "cannot withdraw more than balance", /Insufficient balance/);
await rejects(c.mutation(api.wallet.requestWithdrawal, { token: poster.token, amount: 0.01 }), "below minimum is refused", /Minimum/);
await rejects(c.mutation(api.wallet.requestWithdrawal, { token: poster.token, amount: -5 }), "negative withdrawal is refused", /negative/);
const w = await c.mutation(api.wallet.requestWithdrawal, { token: poster.token, amount: 8 });
ok(w.to === poster.acct.address, "withdrawal goes to the account's own wallet");
await new Promise(r => setTimeout(r, 4000));
const ps = await c.query(api.wallet.summary, { token: poster.token });
ok(ps.withdrawals[0].status === "failed" && near(ps.balance, 88), "failed send is refunded exactly once", `${ps.withdrawals[0].status}, balance ${ps.balance}`);

console.log("Deposits");
await rejects(c.action(api.payments.claimDeposit, { token: poster.token, txHash: "0x1234" }), "malformed hash is refused", /Invalid transaction hash/);
await rejects(c.action(api.payments.claimDeposit, { token: "x".repeat(64), txHash: "0x" + "ab".repeat(32) }), "deposit needs sign-in", /Not signed in/);
const dup = "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
run("wallet:creditDeposit", { userId: mallory.userId, txHash: dup, amountMicro: 1e6, blockNumber: 1 });
const again = run("wallet:creditDeposit", { userId: mallory.userId, txHash: dup, amountMicro: 1e6, blockNumber: 1 });
ok(again.alreadyCredited && near(await bal(mallory), 1), "same transaction credits only once");
try { run("wallet:creditDeposit", { userId: poster.userId, txHash: dup, amountMicro: 1e6, blockNumber: 1 }); ok(false, "tx cannot be claimed by a second account"); } catch { ok(true, "tx cannot be claimed by a second account"); }

console.log("API keys and HTTP API");
const { key } = await c.action(api.auth.createApiKey, { token: poster.token, label: "test" });
ok(key.startsWith("rico_"), "API key created");
await rejects(c.action(api.auth.createApiKey, { token: key }), "an API key cannot mint more keys", /Sign in with your wallet/);
const http = async (method, path, body, k) => { const r = await fetch(SITE + path, { method, headers: { "Content-Type": "application/json", ...(k ? { Authorization: "Bearer " + k } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const post = { title: "HTTP task", category: "info", details: "d", taskType: "gather-info", locationAddr: "X", suggestedFee: 2 };
ok((await http("POST", "/task", { ...post, posterId: poster.userId })).status === 401, "HTTP: no key -> 401 even with a posterId");
ok((await http("POST", "/task", post, "rico_" + "0".repeat(48))).status === 401, "HTTP: wrong key -> 401");
const meR = await http("GET", "/me", null, key);
ok(meR.status === 200 && near(meR.body.balance, 88), "HTTP: /me shows balance", JSON.stringify(meR.body).slice(0, 80));
const ht = await http("POST", "/task", { ...post, posterId: mallory.userId }, key);
ok(ht.status === 200 && (await c.query(api.tasks.getTask, { taskId: ht.body.taskId })).posterId === poster.userId, "HTTP: task belongs to the key's owner, not the posterId sent");
ok((await http("POST", "/task", { ...post, suggestedFee: 5000 }, key)).status === 402, "HTTP: too little balance -> 402");
ok((await http("GET", "/tasks")).body.tasks.length > 0 && (await http("GET", "/task?id=" + ht.body.taskId)).body.title === "HTTP task", "HTTP: public reads work");
const hb = await http("POST", "/bid", { taskId: ht.body.taskId, fee: 2 }, (await c.action(api.auth.createApiKey, { token: runner.token })).key);
ok(hb.status === 200 && hb.body.bidId, "HTTP: runner bids with own key");
const hc = await http("POST", "/cancel-task", { taskId: ht.body.taskId }, key);
ok(hc.status === 200 && near(hc.body.refund, 2), "HTTP: cancel refunds", JSON.stringify(hc.body));
const keys = await c.query(api.auth.listApiKeys, { token: poster.token });
await c.mutation(api.auth.revokeApiKey, { token: poster.token, keyId: keys[0]._id });
ok((await http("GET", "/me", null, key)).status === 401, "HTTP: revoked key stops working");
await c.mutation(api.auth.signOut, { token: mallory.token });
ok((await c.query(api.auth.me, { token: mallory.token })) === null, "sign-out ends the session");

console.log("Public profile hides balance");
const pub = await c.query(api.users.get, { userId: poster.userId });
ok(pub.balanceMicro === undefined && pub.balance === undefined, "users.get has no balance");

console.log("Ledger adds up");
for (const [n, u] of [["poster", poster], ["runner", runner], ["runner2", runner2]]) {
  const s = await c.query(api.wallet.summary, { token: u.token });
  ok(near(s.ledger[0]?.balanceAfter ?? 0, s.balance), `${n}: last ledger entry matches balance ${s.balance}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
