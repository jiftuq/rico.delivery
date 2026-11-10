import { internalMutation, internalQuery, mutation, query, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { requireUser, userForToken } from "./lib/auth";
import { MIN_WITHDRAWAL_MICRO, credit, debit, fmt, fromMicro, toMicro } from "./lib/money";

// Prepaid balances. Money comes in only through a verified on-chain deposit
// (payments.claimDeposit) and leaves only through the withdrawal queue below,
// always to the wallet the account belongs to. Everything in between is a
// balance change inside one transaction, so what can be paid out never
// exceeds what was paid in.

export const summary = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await userForToken(ctx, token);
    if (!user) return null;
    const ledger = await ctx.db.query("ledger").withIndex("by_user", (q) => q.eq("userId", user._id)).order("desc").take(20);
    const withdrawals = await ctx.db.query("withdrawals").withIndex("by_user", (q) => q.eq("userId", user._id)).order("desc").take(10);
    return {
      userId: user._id,
      walletAddress: user.walletAddress,
      balance: fromMicro(user.balanceMicro ?? 0),
      depositAddress: process.env.RECEIVING_WALLET ?? null,
      minWithdrawal: fromMicro(MIN_WITHDRAWAL_MICRO),
      ledger: ledger.map((l) => ({ kind: l.kind, amount: fromMicro(l.amountMicro), balanceAfter: fromMicro(l.balanceAfter), taskId: l.taskId, ref: l.ref, createdAt: l.createdAt })),
      withdrawals: withdrawals.map((w) => ({ _id: w._id, amount: fromMicro(w.amountMicro), status: w.status, txHash: w.txHash, reason: w.reason, createdAt: w.createdAt })),
    };
  },
});

/** Take funds out of a balance and queue them to be sent on-chain. */
export async function enqueueWithdrawal(ctx: MutationCtx, userId: Id<"users">, amountMicro: number, reason: "user" | "payout") {
  const user = await ctx.db.get(userId);
  if (!user) throw new ConvexError("User not found");
  await debit(ctx, userId, amountMicro, "withdrawal");
  const now = Date.now();
  const id = await ctx.db.insert("withdrawals", {
    userId, to: user.walletAddress, amountMicro, reason, status: "pending", createdAt: now, updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.payments.processWithdrawals, {});
  return id;
}

export const requestWithdrawal = mutation({
  args: { token: v.string(), amount: v.number() },
  handler: async (ctx, { token, amount }) => {
    const user = await requireUser(ctx, token);
    const amountMicro = toMicro(amount, "Withdrawal");
    if (amountMicro < MIN_WITHDRAWAL_MICRO) throw new ConvexError(`Minimum withdrawal is ${fmt(MIN_WITHDRAWAL_MICRO)} USDC`);
    const id = await enqueueWithdrawal(ctx, user._id, amountMicro, "user");
    return { withdrawalId: id, amount: fromMicro(amountMicro), to: user.walletAddress };
  },
});

// ── Internal: used by the payment actions ──

export const sessionUser = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => userForToken(ctx, token),
});

export const creditDeposit = internalMutation({
  args: { userId: v.id("users"), txHash: v.string(), amountMicro: v.number(), blockNumber: v.number() },
  handler: async (ctx, { userId, txHash, amountMicro, blockNumber }) => {
    if (!Number.isInteger(amountMicro) || amountMicro <= 0) throw new ConvexError("Invalid deposit amount");
    // A transaction can fund a balance exactly once.
    const prior = await ctx.db.query("deposits").withIndex("by_tx", (q) => q.eq("txHash", txHash)).unique();
    if (prior) {
      if (prior.userId !== userId) throw new ConvexError("This transaction was already credited to another account");
      const user = await ctx.db.get(userId);
      return { credited: 0, alreadyCredited: true, balance: fromMicro(user?.balanceMicro ?? 0) };
    }
    // Payments made before prepaid balances were attached to a task directly.
    // They were already spent on that task and must not be claimed again.
    for (const candidate of new Set([txHash, txHash.toLowerCase()])) {
      const legacy = await ctx.db.query("tasks").withIndex("by_paymentTx", (q) => q.eq("paymentTx", candidate)).first();
      if (legacy) throw new ConvexError("This transaction already paid for a task and cannot be deposited");
    }
    await ctx.db.insert("deposits", { userId, txHash, amountMicro, blockNumber, createdAt: Date.now() });
    await credit(ctx, userId, amountMicro, "deposit", { ref: txHash });
    const user = await ctx.db.get(userId);
    return { credited: fromMicro(amountMicro), alreadyCredited: false, balance: fromMicro(user?.balanceMicro ?? 0) };
  },
});

/**
 * Hand the payment action its next job. Only one withdrawal is ever "sending",
 * which keeps the platform wallet's transaction nonces in order.
 */
export const nextWithdrawal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const sending = await ctx.db.query("withdrawals").withIndex("by_status", (q) => q.eq("status", "sending")).first();
    if (sending) return { job: "check" as const, withdrawal: sending };
    const pending = await ctx.db.query("withdrawals").withIndex("by_status", (q) => q.eq("status", "pending")).first();
    if (!pending) return null;
    await ctx.db.patch(pending._id, { status: "sending", updatedAt: Date.now() });
    return { job: "send" as const, withdrawal: { ...pending, status: "sending" } };
  },
});

export const recordWithdrawalTx = internalMutation({
  args: { id: v.id("withdrawals"), txHash: v.string() },
  handler: async (ctx, { id, txHash }) => { await ctx.db.patch(id, { txHash, updatedAt: Date.now() }); },
});

export const finishWithdrawal = internalMutation({
  args: {
    id: v.id("withdrawals"),
    // sent: confirmed on-chain. failed: definitely not sent, refund the balance.
    // review: unknown whether it was sent, so do not refund; a human decides.
    outcome: v.union(v.literal("sent"), v.literal("failed"), v.literal("review")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, outcome, error }) => {
    const w = await ctx.db.get(id);
    if (!w || w.status !== "sending") return;
    await ctx.db.patch(id, { status: outcome, error, updatedAt: Date.now() });
    if (outcome === "failed") await credit(ctx, w.userId, w.amountMicro, "withdrawal_refund", { ref: id });
  },
});

/**
 * Admin (run from the Convex dashboard): settle a withdrawal left in "review"
 * after checking the platform wallet's transactions on a block explorer.
 */
export const resolveWithdrawal = internalMutation({
  args: { id: v.id("withdrawals"), outcome: v.union(v.literal("sent"), v.literal("refund")), txHash: v.optional(v.string()) },
  handler: async (ctx, { id, outcome, txHash }) => {
    const w = await ctx.db.get(id);
    if (!w || w.status !== "review") throw new ConvexError("Withdrawal is not awaiting review");
    if (outcome === "sent") {
      await ctx.db.patch(id, { status: "sent", txHash: txHash ?? w.txHash, updatedAt: Date.now() });
    } else {
      await ctx.db.patch(id, { status: "failed", updatedAt: Date.now() });
      await credit(ctx, w.userId, w.amountMicro, "withdrawal_refund", { ref: id });
    }
  },
});
