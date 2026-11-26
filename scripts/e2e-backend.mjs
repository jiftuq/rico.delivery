// End-to-end security and money-flow checks for the Convex backend.
//
// Runs against a throwaway local backend, never production:
//   1. CONVEX_AGENT_MODE=anonymous npx convex dev      (leave running)
//   2. node scripts/e2e-backend.mjs
//
// It signs in with freshly generated wallets, funds them through the internal
// creditDeposit function (as a verified deposit would), and then checks that
// nobody can act as someone else, that balances and escrow always add up,
// and what each kind of caller (stranger, poster, runner, API key, connected
// app) can see and do.
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
const accept = (u, taskId, bidId) => c.mutation(api.tasks.acceptBid, { token: u.token, taskId, bidId });
const deliver = (u, taskId, proofData) => c.mutation(api.tasks.markDelivered, { token: u.token, taskId, proofData });
const getT = (u, taskId) => c.query(api.tasks.getTask, { taskId, token: u.token });
/** Upload a file as a runner and attach it to the task as proof. */
async function attach(u, taskId, contentType = "image/png", claimed = contentType) {
  const url = await c.mutation(api.proofs.generateUploadUrl, { token: u.token, taskId });
  const { storageId } = await (await fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) })).json();
  return c.mutation(api.proofs.saveProofFile, { token: u.token, taskId, storageId, fileType: claimed, fileName: "proof" });
}
const H = 3600e3;

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
await rejects(task(poster, { suggestedFee: 0 }), "zero-fee task is refused", /at least 0.50/);
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
for (const fn of ["tasks:resolveDispute", "tasks:autoRelease", "tasks:refundStuck", "tasks:closeStaleSlots", "wallet:creditDeposit", "wallet:finishWithdrawal", "payments:processWithdrawals"]) {
  const [m, f] = fn.split(":");
  const call = fn.startsWith("payments") ? c.action(api[m][f], {}) : c.mutation(api[m][f], { taskId: t1, resolution: "courier", userId: mallory.userId, txHash: "0x1", amountMicro: 1e9, blockNumber: 1 });
  await rejects(call, `${fn} is not callable from outside`);
}

console.log("Payout");
await rejects(deliver(runner, t1, "done"), "a photo task can't be marked done with only a note", /needs proof.*a photo/);
await rejects(c.mutation(api.proofs.generateUploadUrl, { token: mallory.token, taskId: t1 }), "a stranger can't upload proof to it", /Only a runner/);
await attach(runner, t1);
const md = await deliver(runner, t1, "done");
ok(Math.abs(md.autoReleaseAt - Date.now() - 24 * H) < 60e3, "with a photo it's marked done, and pays out on its own in 24 hours");
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
await rejects(deliver(runner, t3), "each runner needs their own proof", /needs proof/);
await attach(runner, t3); await attach(runner2, t3);
await deliver(runner, t3);
await deliver(runner2, t3);
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

console.log("Public profile hides balance and position");
const pub = await c.query(api.users.get, { userId: poster.userId });
ok(pub.balanceMicro === undefined && pub.balance === undefined, "users.get has no balance");
const bidderProfile = await c.query(api.users.get, { userId: runner.userId });
ok(bidderProfile.lastLat === undefined && bidderProfile.lastLng === undefined, "users.get has no last position");

// ── H1: no task can be big or free enough to take the site down ──
console.log("Size limits, minimum fee, stats counters");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = "x".repeat(10_000);
const sizer = await signIn(); await fund(sizer, 50);
await rejects(task(sizer, { title: big }), "oversized title is refused", /Title is too long/);
await rejects(task(sizer, { items: [{ name: "x".repeat(950_000), cost: 0 }] }), "a ~1 MB item is refused", /Item name is too long/);
await rejects(task(sizer, { items: Array.from({ length: 51 }, () => ({ name: "a", cost: 0 })) }), "more than 50 items is refused", /at most 50 items/);
await rejects(task(sizer, { steps: [{ order: 1, action: big }] }), "an oversized step is refused", /Step 1 is too long/);
await rejects(task(sizer, { steps: Array.from({ length: 31 }, (_, i) => ({ order: i + 1, action: "go" })) }), "more than 30 steps is refused", /at most 30 steps/);
await rejects(task(sizer, { locationAddr: big }), "an oversized address is refused", /Location is too long/);
await rejects(task(sizer, { category: big }), "an oversized category is refused", /Category is too long/);
await rejects(task(sizer, { suggestedFee: 0.49 }), "a fee under 0.50 is refused", /at least 0.50/);
await rejects(task(sizer, { suggestedFee: 0.000001 }), "a 1-micro fee is refused", /at least 0.50/);
await rejects(task(sizer, { locationLat: 91, locationLng: 4 }), "an impossible position is refused", /not a valid/);
const pre = await task(sizer, { suggestedFee: 0.5, steps: [{ order: 7, action: "Go", status: "completed", proofData: "fake proof" }] });
const preT = await c.query(api.tasks.getTask, { taskId: pre, token: sizer.token });
ok(preT.steps[0].status === "pending" && preT.steps[0].proofData === undefined && preT.steps[0].order === 1, "a poster can't pre-fill step progress or proof");
run("tasks:rebuildStats", {}); await sleep(2000);
const s0 = await c.query(api.tasks.getStats, {});
const sa = await task(sizer, { suggestedFee: 1 });
const sb = await task(sizer, { suggestedFee: 1 });
await c.mutation(api.tasks.cancel, { token: sizer.token, taskId: sb });
const sRunner = await signIn();
await c.mutation(api.tasks.acceptBid, { token: sizer.token, taskId: sa, bidId: await bid(sRunner, sa, 1) });
await c.mutation(api.tasks.confirmDelivery, { token: sizer.token, taskId: sa });
const s1 = await c.query(api.tasks.getStats, {});
ok(s1.total === s0.total + 2 && s1.open === s0.open && s1.completed === s0.completed + 1 && near(s1.burned, Math.round((s0.burned + 0.07) * 100) / 100),
  "stats follow posts, cancels and payouts", `${JSON.stringify(s0)} -> ${JSON.stringify(s1)}`);
run("tasks:rebuildStats", {}); await sleep(2000);
const s2 = await c.query(api.tasks.getStats, {});
ok(JSON.stringify(s1) === JSON.stringify(s2), "running stats match a full recount", JSON.stringify(s2));
ok(Array.isArray(await c.query(api.tasks.listOpen, {})), "the open-task list still loads");

// ── H2: strangers see the area, the people on the task see everything ──
console.log("Who sees what");
const hav = (a, b) => { const R = 6371000, r = (x) => x * Math.PI / 180; const dLa = r(b[0] - a[0]), dLo = r(b[1] - a[1]); return 2 * R * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLo / 2) ** 2)); };
const hp = await signIn(), hr = await signIn(), nosy = await signIn(); await fund(hp, 50);
const exact = [50.8752569, 4.3225193];
const pt = await task(hp, {
  title: "Check the name on the mailbox", taskType: "verification", privacyZone: 300, targetPerson: "Jean Dupont",
  locationAddr: "59, Rue Léon Dopéré, Miroir, Jette, 1090, Belgium", locationLat: exact[0], locationLng: exact[1],
  steps: [{ order: 1, action: "Go to the house", locationAddr: "Rue Haute 35, 1000 Brussels", locationLat: 50.8411, locationLng: 4.3478 }],
});
const pubT = (await c.query(api.tasks.listOpen, {})).find((t) => t._id === pt);
ok(pubT.locationAddr === "Rue Léon Dopéré, Miroir, Jette, 1090, Belgium", "public list: address without the house number", pubT.locationAddr);
const off = hav(exact, [pubT.locationLat, pubT.locationLng]);
ok(off > 0 && off < 450, "public list: position snapped to the 300 m zone", `${Math.round(off)} m away`);
ok(pubT.targetPerson === undefined && pubT.viewer === "public", "public list: the person to check is hidden");
ok(pubT.steps[0].locationAddr === "Rue Haute, 1000 Brussels" && pubT.steps[0].locationLat !== 50.8411, "public list: step addresses and positions too", pubT.steps[0].locationAddr);
const nosyT = await c.query(api.tasks.getTask, { taskId: pt, token: nosy.token });
ok(nosyT.viewer === "public" && nosyT.targetPerson === undefined, "a signed-in stranger gets the public view too");
const ownT = await c.query(api.tasks.getTask, { taskId: pt, token: hp.token });
ok(ownT.viewer === "poster" && ownT.locationLat === exact[0] && ownT.targetPerson === "Jean Dupont" && ownT.locationAddr.startsWith("59,"), "the poster sees everything");
const ownList = (await c.query(api.tasks.listOpen, { token: hp.token })).find((t) => t._id === pt);
ok(ownList.viewer === "poster" && ownList.locationLat === exact[0], "the poster's own task is exact in the list");
const bidAt = [50.8512345, 4.3456789];
const hb2 = await c.mutation(api.tasks.placeBid, { token: hr.token, taskId: pt, fee: 5, comment: "", lat: bidAt[0], lng: bidAt[1], tripKm: 2 });
const pubBid = (await c.query(api.tasks.getBids, { taskId: pt }))[0];
ok(pubBid.lat === undefined && pubBid.lng === undefined && pubBid.tripKm === 2, "strangers don't see where a bid came from");
const posterBid = (await c.query(api.tasks.getBids, { taskId: pt, token: hp.token }))[0];
const bidOff = hav(bidAt, [posterBid.lat, posterBid.lng]);
ok(bidOff > 0 && bidOff < 760, "the poster sees it to within about a kilometre", `${Math.round(bidOff)} m away`);
const ownBid = (await c.query(api.tasks.getBids, { taskId: pt, token: hr.token }))[0];
ok(ownBid.lat === bidAt[0], "a bidder sees their own bid exactly");
ok((await c.query(api.tasks.getBid, { bidId: hb2 })).lat === undefined, "getBid hides the position too");
await c.mutation(api.tasks.acceptBid, { token: hp.token, taskId: pt, bidId: hb2 });
await c.mutation(api.tasks.updateCourierLoc, { token: hr.token, taskId: pt, lat: 50.86, lng: 4.33 });
const liveStranger = await c.query(api.tasks.getTask, { taskId: pt });
ok(liveStranger.courierLat === undefined && liveStranger.courierLng === undefined, "strangers can't see the runner's live position");
const livePoster = await c.query(api.tasks.getTask, { taskId: pt, token: hp.token });
ok(livePoster.courierLat === 50.86, "the poster can");
const asRunner = await c.query(api.tasks.getTask, { taskId: pt, token: hr.token });
ok(asRunner.viewer === "runner" && asRunner.targetPerson === "Jean Dupont" && asRunner.locationLat === exact[0], "the accepted runner sees everything");
ok((await c.query(api.users.get, { userId: hr.userId })).lastLat === undefined, "the runner's last position stays private");
ok((await c.query(api.tasks.getActive, {})).length === 0, "active tasks need sign-in");
ok((await c.query(api.tasks.getActive, { userId: hr.userId })).length === 0, "an old-style user ID is ignored, not trusted");
ok((await c.query(api.tasks.getActive, { token: nosy.token })).every((t) => t._id !== pt), "a stranger doesn't get someone else's active tasks");
ok((await c.query(api.tasks.getActive, { token: hr.token })).some((t) => t._id === pt), "the runner gets their own");
ok((await c.query(api.tasks.getPosterHistory, { posterId: poster.userId })).length === 0, "someone else's posting history: nothing");
ok((await c.query(api.tasks.getCourierHistory, { courierId: runner.userId })).length === 0, "someone else's runner history: nothing");
ok((await c.query(api.tasks.getCourierHistory, { token: runner.token })).length > 0, "your own history still works");
const upUrl = await c.mutation(api.proofs.generateUploadUrl, { token: hr.token });
const { storageId } = await (await fetch(upUrl, { method: "POST", headers: { "Content-Type": "image/png" }, body: new Uint8Array([137, 80, 78, 71]) })).json();
await c.mutation(api.proofs.saveProofFile, { token: hr.token, taskId: pt, storageId, fileType: "image/png", fileName: "proof.png" });
ok((await c.query(api.proofs.getProofFiles, { taskId: pt, token: hp.token })).length === 1, "the poster sees the proof");
ok((await c.query(api.proofs.getProofFiles, { taskId: pt })).length === 0 && (await c.query(api.proofs.getProofFiles, { taskId: pt, token: nosy.token })).length === 0, "strangers don't");
const mtp = await task(hp, { title: "Two people", suggestedFee: 2, maxRunners: 2 });
const mb = await c.mutation(api.tasks.placeBid, { token: hr.token, taskId: mtp, fee: 2, comment: "", lat: bidAt[0], lng: bidAt[1], tripKm: 1 });
await c.mutation(api.tasks.acceptBid, { token: hp.token, taskId: mtp, bidId: mb });
ok((await c.query(api.tasks.getTaskRunners, { taskId: mtp }))[0].lat === undefined, "task runners' positions are hidden from strangers");
ok((await c.query(api.tasks.getTaskRunners, { taskId: mtp, token: hp.token }))[0].lat === bidAt[0], "and visible to the poster");
const httpPub = await (await fetch(`${SITE}/task?id=${pt}`)).json();
const posterKey = (await c.action(api.auth.createApiKey, { token: hp.token })).key;
const httpOwn = await (await fetch(`${SITE}/task?id=${pt}`, { headers: { Authorization: "Bearer " + posterKey } })).json();
ok(httpPub.viewer === "public" && httpPub.courierLat === undefined && httpOwn.viewer === "poster" && httpOwn.courierLat === 50.86, "HTTP /task: public without a key, exact with the poster's key");
const stream = await fetch(`${SITE}/subscribe/bids?taskId=${mtp}`, { signal: AbortSignal.timeout(4000) });
let streamed = "";
try { const reader = stream.body.getReader(); while (!streamed.includes("event: bid")) { const { value, done } = await reader.read(); if (done) break; streamed += new TextDecoder().decode(value); } reader.cancel(); } catch {}
ok(streamed.includes("event: bid") && !streamed.includes('"lat"'), "the live bid stream carries no positions");

// ── M4: keys and connected apps can't withdraw or manage the account ──
console.log("What API keys and connected apps can do");
const m4 = await signIn(); await fund(m4, 20);
const { key: k4 } = await c.action(api.auth.createApiKey, { token: m4.token, label: "agent" });
await rejects(c.mutation(api.wallet.requestWithdrawal, { token: k4, amount: 1 }), "an API key cannot withdraw", /signed in on rico.delivery/);
const hw = await fetch(SITE + "/withdraw", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + k4 }, body: JSON.stringify({ amount: 1 }) });
ok(hw.status === 404, "the API withdraw route is gone", `HTTP ${hw.status}`);
ok((await c.query(api.auth.listApiKeys, { token: k4 })).length === 0, "an API key cannot list the account's keys");
const k4id = (await c.query(api.auth.listApiKeys, { token: m4.token }))[0]._id;
await rejects(c.mutation(api.auth.revokeApiKey, { token: k4, keyId: k4id }), "an API key cannot revoke keys", /signed in on rico.delivery/);
const CB = "https://claude.ai/api/mcp/auth_callback";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const reg4 = await (await fetch(SITE + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB] }) })).json();
const ver = b64u(crypto.getRandomValues(new Uint8Array(32)));
const chal = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ver))));
const { code } = await c.action(api.oauth.approveAuthorization, { token: m4.token, clientId: reg4.client_id, redirectUri: CB, codeChallenge: chal, codeChallengeMethod: "S256" });
const appTok = (await (await fetch(SITE + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: reg4.client_id, redirect_uri: CB, code, code_verifier: ver }) })).json()).access_token;
await rejects(c.mutation(api.wallet.requestWithdrawal, { token: appTok, amount: 1 }), "a connected app cannot withdraw", /signed in on rico.delivery/);
ok((await c.query(api.oauth.listConnections, { token: appTok })).length === 0, "a connected app cannot list apps");
await rejects(c.action(api.oauth.disconnectApp, { token: appTok, clientId: reg4.client_id }), "a connected app cannot disconnect apps", /signed in on rico.delivery/);
await rejects(c.mutation(api.auth.revokeApiKey, { token: appTok, keyId: k4id }), "a connected app cannot revoke keys", /signed in on rico.delivery/);
ok(near((await c.query(api.wallet.summary, { token: appTok })).balance, 20), "a connected app can still read the balance");
const appTask = await task({ token: appTok }, { suggestedFee: 1 });
ok(!!appTask, "and can still post tasks");
ok((await c.query(api.oauth.listConnections, { token: m4.token })).length === 1, "the wallet session sees the connected app");
const w4 = await c.mutation(api.wallet.requestWithdrawal, { token: m4.token, amount: 1 });
ok(w4.to === m4.acct.address, "the wallet session can withdraw, to its own wallet");

// ── M5: the approval page can tell real apps from look-alikes ──
console.log("Approval page: verified apps and look-alikes");
const regC = async (name, uris) => (await (await fetch(SITE + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: uris }) })).json()).client_id;
const dc = (id, uri) => c.query(api.oauth.describeClient, { clientId: id, redirectUri: uri });
const real = await dc(await regC("Claude", [CB]), CB);
ok(real.trust === "verified" && !real.impersonating, "Claude returning to claude.ai is verified");
const localApp = await dc(await regC("Claude Code", ["http://localhost/callback"]), "http://localhost:51234/callback");
ok(localApp.trust === "local" && !localApp.impersonating, "an app returning to this computer is marked local");
const fake = await dc(await regC("Claude", ["https://evil.example/cb"]), "https://evil.example/cb");
ok(fake.trust === "unverified" && fake.impersonating, "'Claude' returning anywhere else is unverified and flagged");
const tricky = await dc(await regC("RICO official", ["https://claude.ai.evil.example/cb"]), "https://claude.ai.evil.example/cb");
ok(tricky.trust === "unverified" && tricky.impersonating, "a look-alike host is not verified");
const plain = await dc(await regC("Acme agent", ["https://acme.example/cb"]), "https://acme.example/cb");
ok(plain.trust === "unverified" && !plain.impersonating, "other apps are unverified but not flagged");

// ── M1: a runner is only paid for work with proof, and the poster gets time to check it ──
// The cron jobs are run with a later `now` to stand in for the hours passing.
console.log("Proof before payout");
const pr = await signIn(), pw = await signIn(), px = await signIn(); await fund(pr, 100);
const textTask = await task(pr, { proofType: "text", suggestedFee: 1 });
await accept(pr, textTask, await bid(pw, textTask, 1));
await rejects(deliver(pw, textTask), "text proof: handing in nothing is refused", /a note or a photo/);
await deliver(pw, textTask, "The shop opens at 9");
ok((await getT(pr, textTask)).status === "delivered", "text proof: a note is enough");
const noneTask = await task(pr, { proofType: "none", suggestedFee: 1, steps: [{ order: 1, action: "Wave at the camera", proofType: "none" }] });
await accept(pr, noneTask, await bid(pw, noneTask, 1));
await deliver(pw, noneTask);
ok((await getT(pr, noneTask)).status === "delivered", "no proof asked for: none needed");
const delTask = await task(pr, { taskType: "delivery", category: "delivery", pickupAddr: "Rue A 1", pickupLat: 50.85, pickupLng: 4.35, dropoffAddr: "Rue B 2", dropoffLat: 50.86, dropoffLng: 4.36, suggestedFee: 1 });
await accept(pr, delTask, await bid(pw, delTask, 1));
await rejects(deliver(pw, delTask), "a delivery with no proof type still needs a note or a photo", /a note or a photo/);
const vidTask = await task(pr, { proofType: "video", suggestedFee: 1, steps: [{ order: 1, action: "Film the queue", proofType: "video" }] });
await accept(pr, vidTask, await bid(pw, vidTask, 1));
await attach(pw, vidTask, "image/jpeg");
await rejects(deliver(pw, vidTask), "video proof: a photo isn't enough", /a video/);
await attach(pw, vidTask, "video/mp4");
await deliver(pw, vidTask);
ok((await getT(pr, vidTask)).status === "delivered", "video proof: accepted with a video");
await rejects(attach(pw, vidTask, "text/html"), "an HTML upload is refused as proof", /must be a photo/);
await rejects(attach(pw, vidTask, "text/html", "image/png"), "calling an HTML file a photo doesn't help", /must be a photo/);
ok((await c.query(api.proofs.getProofFiles, { taskId: vidTask, token: pr.token })).every((f) => /^(image|video)\//.test(f.fileType)), "only photos and videos get attached");
await rejects(c.mutation(api.proofs.generateUploadUrl, { token: px.token }), "no upload link for someone working on nothing", /Only a runner/);
const prKey = (await c.action(api.auth.createApiKey, { token: pr.token })).key;
const withProof = await (await fetch(`${SITE}/task?id=${vidTask}`, { headers: { Authorization: "Bearer " + prKey } })).json();
ok(withProof.proofs?.length === 2 && withProof.proofs.every((f) => f.url && f.runnerId === pw.userId), "HTTP /task: the poster gets the proof, with links");
ok((await (await fetch(`${SITE}/task?id=${vidTask}`)).json()).proofs === undefined, "HTTP /task: strangers get none");
const mine = await http("GET", "/my-tasks", null, prKey);
const waiting = mine.body.tasks?.find((t) => t.taskId === vidTask)?.awaitingConfirmation?.[0];
ok(mine.status === 200 && waiting?.runnerId === pw.userId && waiting.autoReleaseAt > Date.now() + 23 * H, "HTTP /my-tasks: deliveries to check, and when they pay out", JSON.stringify(waiting));
run("tasks:autoRelease", { now: Date.now() + 23 * H });
ok((await getT(pr, textTask)).status === "delivered", "not paid out after 23 hours");
const disp = await http("POST", "/dispute", { taskId: noneTask, reason: "Nobody waved" }, prKey);
ok(disp.status === 200 && (await getT(pr, noneTask)).status === "disputed", "HTTP /dispute: the poster disputes a delivery", JSON.stringify(disp.body));
const prBal = await bal(pr);
run("tasks:autoRelease", { now: Date.now() + 25 * H });
ok((await getT(pr, textTask)).status === "completed", "paid out after 24 hours with no answer from the poster");
ok((await getT(pr, noneTask)).status === "disputed", "a disputed delivery isn't paid out");
run("tasks:resolveDispute", { taskId: noneTask, resolution: "poster" });
ok((await getT(pr, noneTask)).status === "refunded" && near(await bal(pr), prBal + 1), "the admin can settle it for the poster");

// ── M2: money for empty slots on a multi-runner task comes back ──
console.log("Multi-runner slots");
const mp = await signIn(), slotA = await signIn(), slotB = await signIn(), slotC = await signIn(); await fund(mp, 100);
const three = await task(mp, { suggestedFee: 10, maxRunners: 3 });
await accept(mp, three, await bid(slotA, three, 10));
await rejects(c.mutation(api.tasks.cancel, { token: mp.token, taskId: three }), "cancel is refused once a runner is in", /Close the open slots/);
await attach(slotA, three); await deliver(slotA, three);
await c.mutation(api.tasks.confirmDelivery, { token: mp.token, taskId: three, runnerId: slotA.userId });
const mpBal = await bal(mp);
await rejects(c.mutation(api.tasks.closeSlots, { token: slotA.token, taskId: three }), "only the poster can close the slots", /Only the poster/);
const cs = await c.mutation(api.tasks.closeSlots, { token: mp.token, taskId: three });
ok(near(cs.refund, 20) && near(await bal(mp), mpBal + 20), "closing the slots returns the money for the 2 empty ones", JSON.stringify(cs));
const threeT = await getT(mp, three);
ok(threeT.status === "completed" && threeT.escrowMicro === 0, "its only runner paid, the task is complete", `${threeT.status}, escrow ${threeT.escrowMicro}`);
await rejects(bid(slotB, three, 10), "no new bids once closed", /Not open/);
const four = await task(mp, { suggestedFee: 5, maxRunners: 4 });
await accept(mp, four, await bid(slotA, four, 5));
await accept(mp, four, await bid(slotB, four, 5));
await attach(slotB, four); await deliver(slotB, four);
const fourBal = await bal(mp);
run("tasks:closeStaleSlots", { now: Date.now() + 71 * H });
ok((await getT(mp, four)).status === "open", "still taking runners after 71 hours");
run("tasks:closeStaleSlots", { now: Date.now() + 73 * H });
const fourT = await getT(mp, four);
ok(fourT.status === "in_progress" && fourT.slotsClosedAt && near(await bal(mp), fourBal + 10), "after 72 hours the empty slots close and their money comes back", `${fourT.status}, balance +${(await bal(mp)) - fourBal}`);
run("tasks:refundStuck", { now: Date.now() + 78 * H });
ok((await getT(mp, four)).status === "delivered" && near(await bal(mp), fourBal + 15), "a runner who never delivers loses the slot, and its money comes back");
run("tasks:autoRelease", { now: Date.now() + 100 * H });
const fourDone = await getT(mp, four);
ok(fourDone.status === "completed" && fourDone.escrowMicro === 0, "the runner who delivered is paid, and the task settles to zero", `${fourDone.status}, escrow ${fourDone.escrowMicro}`);
const two = await task(mp, { suggestedFee: 4, maxRunners: 2 });
await accept(mp, two, await bid(slotA, two, 4)); await accept(mp, two, await bid(slotC, two, 4));
await attach(slotA, two); await attach(slotC, two); await deliver(slotA, two); await deliver(slotC, two);
ok((await getT(mp, two)).status === "delivered", "both delivered: the task waits for the poster");
await rejects(c.mutation(api.tasks.openDispute, { token: mp.token, taskId: two, reason: "Blurry" }), "a multi-runner dispute names the runner", /Name the runner/);
await c.mutation(api.tasks.openDispute, { token: mp.token, taskId: two, reason: "Blurry photo", runnerId: slotA.userId });
run("tasks:autoRelease", { now: Date.now() + 25 * H });
const twoRunners = await c.query(api.tasks.getTaskRunners, { taskId: two, token: mp.token });
ok(twoRunners.find((r) => r.runnerId === slotA.userId)?.status === "disputed" && twoRunners.find((r) => r.runnerId === slotC.userId)?.status === "completed", "only the disputed runner's payment is held");
ok((await c.query(api.tasks.getTaskRunners, { taskId: two })).every((r) => r.disputeReason === undefined), "strangers don't see the dispute text");
await c.mutation(api.tasks.confirmDelivery, { token: mp.token, taskId: two, runnerId: slotA.userId });
const twoT = await getT(mp, two);
ok(twoT.status === "completed" && twoT.escrowMicro === 0, "the poster can still pay a disputed runner, which settles the task");
const crowd = [];
for (let i = 0; i < 21; i++) crowd.push(await signIn());
const eleven = await task(mp, { suggestedFee: 0.5, maxRunners: 11 });
for (const u of crowd) await bid(u, eleven, 0.5);
ok((await c.query(api.tasks.getBids, { taskId: eleven })).length === 21, "a task for 11 runners takes more than 20 bids");

// ── M3: free accounts can't crowd a task out, and nobody can post or chat without limit ──
console.log("Bid spam and rate limits");
const sp = await signIn(); await fund(sp, 20);
const target = await task(sp, { suggestedFee: 1 });
for (const u of crowd.slice(0, 20)) await bid(u, target, 1);
await rejects(bid(crowd[20], target, 1), "when a task's bids are full, another brand-new account can't push in", /most bids/);
const vet = await bid(runner, target, 1);
const tb = await c.query(api.tasks.getBids, { taskId: target });
ok(tb.length === 20 && tb.some((b) => b._id === vet), "a runner with completed jobs takes the place of a brand-new bid", `${tb.length} bids`);
ok((await c.query(api.tasks.listOpen, {})).find((t) => t._id === target)?.bidCount === 20, "the board's bid count stays right");
const spamBid = tb.find((b) => b.courierId !== runner.userId);
const spammer = crowd.find((u) => u.userId === spamBid.courierId);
await rejects(c.mutation(api.tasks.rejectBid, { token: runner.token, taskId: target, bidId: spamBid._id }), "only the poster can turn a bid down", /Only the poster/);
const rj = await http("POST", "/reject-bid", { taskId: target, bidId: spamBid._id }, (await c.action(api.auth.createApiKey, { token: sp.token })).key);
ok(rj.status === 200 && !(await c.query(api.tasks.getBids, { taskId: target })).some((b) => b._id === spamBid._id), "HTTP /reject-bid: the bid disappears from the list");
ok((await c.query(api.tasks.getBids, { taskId: target, token: spammer.token })).find((b) => b._id === spamBid._id)?.rejected === true, "its bidder sees it was turned down");
await rejects(bid(spammer, target, 1), "and can't bid on that task again", /turned down/);
await rejects(accept(sp, target, spamBid._id), "a turned-down bid can't be accepted", /turned this bid down/);
await bid(crowd[20], target, 1);
ok((await c.query(api.tasks.getBids, { taskId: target })).length === 20, "the freed place takes a new bid");
const rl = await signIn(); await fund(rl, 10);
const rlKey = (await c.action(api.auth.createApiKey, { token: rl.token })).key;
const codes = [];
for (let i = 0; i < 11; i++) codes.push((await http("POST", "/task", { ...post, suggestedFee: 0.5 }, rlKey)).status);
ok(codes.slice(0, 10).every((s) => s === 200) && codes[10] === 429, "the 11th task in an hour is refused (HTTP 429)", codes.join(","));
const chatTask = await task(sp, { suggestedFee: 1 });
await accept(sp, chatTask, await bid(crowd[1], chatTask, 1));
let sent = 0;
try { for (let i = 0; i < 31; i++) { await c.mutation(api.chat.send, { token: crowd[1].token, taskId: chatTask, text: "msg " + i }); sent++; } } catch (e) { ok(/Too many messages/.test(msg(e)) && sent === 30, "chat: 30 messages at once, then a pause", `${sent} sent: ${msg(e)}`); }
if (sent === 31) ok(false, "chat: 30 messages at once, then a pause", "31 went through");

console.log("App registrations and cleanup");
const regApp = async (name, uris) => (await (await fetch(SITE + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: uris }) })).json()).client_id;
const uniq = "Dup app " + crypto.randomUUID().slice(0, 8), DUP = "https://dup.example/cb";
const r1 = await regApp(uniq, [DUP]), r2 = await regApp(uniq, [DUP]), r3 = await regApp(uniq + " two", [DUP]);
ok(r1 === r2 && r3 !== r1, "the same app registering twice gets the same client_id; another app gets its own");
await c.action(api.oauth.approveAuthorization, { token: m4.token, clientId: r1, redirectUri: DUP, codeChallenge: chal, codeChallengeMethod: "S256" });
run("oauth:purgeCodes", { now: Date.now() + 25 * H });
ok((await dc(r1, DUP)).ok === true && (await dc(r3, DUP)).ok === false, "registrations nobody approved go after a day; approved ones stay");
ok((await dc(reg4.client_id, CB)).ok === true, "the connected Claude app is still registered");
const pa = privateKeyToAccount(generatePrivateKey());
const pend = await c.action(api.auth.startSignIn, { walletAddress: pa.address });
run("auth:purgeExpired", { now: Date.now() + 11 * 60e3 });
await rejects(c.action(api.auth.finishSignIn, { nonce: pend.nonce, signature: await pa.signMessage({ message: pend.message }) }), "expired sign-in requests are cleaned up", /expired|already used/);
ok((await c.query(api.wallet.summary, { token: appTok })) !== null, "a live app token survives the cleanup");

console.log("Ledger adds up");
for (const [n, u] of [["poster", poster], ["runner", runner], ["runner2", runner2]]) {
  const s = await c.query(api.wallet.summary, { token: u.token });
  ok(near(s.ledger[0]?.balanceAfter ?? 0, s.balance), `${n}: last ledger entry matches balance ${s.balance}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
