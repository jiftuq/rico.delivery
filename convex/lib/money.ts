import { ConvexError } from "convex/values";
import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

// All money that matters is held as integer micro-USDC (USDC has 6 decimals),
// so balances never pick up floating-point drift.
export const MICRO = 1_000_000;
export const MAX_AMOUNT_USDC = 100_000;
export const FEE_PERCENT = 7;
/** Payouts below this stay in the balance instead of going on-chain. */
export const MIN_WITHDRAWAL_MICRO = 100_000; // 0.10 USDC

/** Convert a USDC amount from a client into micro-USDC, rejecting junk. */
export function toMicro(usdc: number, what = "Amount"): number {
  if (typeof usdc !== "number" || !Number.isFinite(usdc)) throw new ConvexError(`${what} must be a number`);
  if (usdc < 0) throw new ConvexError(`${what} cannot be negative`);
  if (usdc > MAX_AMOUNT_USDC) throw new ConvexError(`${what} is above the ${MAX_AMOUNT_USDC} USDC limit`);
  return Math.round(usdc * MICRO);
}

export const fromMicro = (micro: number) => micro / MICRO;
export const fmt = (micro: number) => fromMicro(micro).toFixed(2);

/** Platform fee on a gross payout. */
export const feeOn = (grossMicro: number) => Math.round((grossMicro * FEE_PERCENT) / 100);

type Extra = { taskId?: Id<"tasks">; ref?: string };

async function move(ctx: MutationCtx, userId: Id<"users">, deltaMicro: number, kind: string, extra: Extra) {
  if (!Number.isInteger(deltaMicro)) throw new ConvexError("Internal error: non-integer amount");
  if (deltaMicro === 0) return;
  const user = await ctx.db.get(userId);
  if (!user) throw new ConvexError("User not found");
  const before = user.balanceMicro ?? 0;
  const after = before + deltaMicro;
  if (after < 0) {
    throw new ConvexError(
      `Insufficient balance: need ${fmt(-deltaMicro)} USDC, have ${fmt(before)} USDC. Top up your RICO balance first.`,
    );
  }
  await ctx.db.patch(userId, { balanceMicro: after });
  await ctx.db.insert("ledger", {
    userId, amountMicro: deltaMicro, kind, taskId: extra.taskId, ref: extra.ref,
    balanceAfter: after, createdAt: Date.now(),
  });
}

/** Add to a user's balance. */
export function credit(ctx: MutationCtx, userId: Id<"users">, amountMicro: number, kind: string, extra: Extra = {}) {
  if (amountMicro < 0) throw new ConvexError("Internal error: negative credit");
  return move(ctx, userId, amountMicro, kind, extra);
}

/** Take from a user's balance. Throws, changing nothing, if they cannot cover it. */
export function debit(ctx: MutationCtx, userId: Id<"users">, amountMicro: number, kind: string, extra: Extra = {}) {
  if (amountMicro < 0) throw new ConvexError("Internal error: negative debit");
  return move(ctx, userId, -amountMicro, kind, extra);
}
