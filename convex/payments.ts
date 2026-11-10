"use node";
import { action, internalAction } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = 8453;

// ── Minimal Ethereum helpers ──

function pad32(hex: string): string {
  return hex.replace(/^0x/, "").padStart(64, "0");
}

function toHex(n: bigint): string {
  const h = n.toString(16);
  return "0x" + (h.length % 2 ? "0" + h : h);
}

function encodeTransferData(to: string, amount: bigint): string {
  const selector = "a9059cbb"; // transfer(address,uint256)
  return "0x" + selector + pad32(to) + pad32("0x" + amount.toString(16));
}

function parseUnits(value: string, decimals: number): bigint {
  const [int, frac = ""] = value.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(int + padded);
}

async function rpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new RpcRejected(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

/** The node answered and said no. Unlike a network failure, nothing was sent. */
class RpcRejected extends Error {}

// ── Uint8Array helpers ──

function hexToU8(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  if (h.length === 0) return new Uint8Array(0);
  const padded = h.length % 2 ? "0" + h : h;
  return hexToBytes(padded);
}

function u8Concat(...arrays: Uint8Array[]): Uint8Array {
  const len = arrays.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function stripZeros(buf: Uint8Array): Uint8Array {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return i === 0 ? buf : buf.slice(i);
}

// ── RLP encoding ──

function rlpEncode(input: Uint8Array | any[]): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0] < 0x80) return input;
    return u8Concat(encodeLength(input.length, 0x80), input);
  }
  if (Array.isArray(input)) {
    const encoded = input.map(rlpEncode);
    const output = u8Concat(...encoded);
    return u8Concat(encodeLength(output.length, 0xc0), output);
  }
  throw new ConvexError("Invalid RLP input");
}

function encodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) return new Uint8Array([len + offset]);
  const hexLen = len.toString(16);
  const byteLen = Math.ceil(hexLen.length / 2);
  const firstByte = offset + 55 + byteLen;
  const lenBytes = hexToU8(hexLen);
  return u8Concat(new Uint8Array([firstByte]), lenBytes);
}

// ── Derive Ethereum address from private key ──

function privateKeyToAddress(privKeyHex: string): string {
  const privBytes = hexToU8(privKeyHex);
  const pubUncompressed = secp256k1.getPublicKey(privBytes, false);
  const hash = keccak_256(pubUncompressed.slice(1));
  return "0x" + bytesToHex(hash.slice(12));
}

// ── Sign EIP-1559 transaction ──

function signTransaction(
  privateKey: string,
  tx: {
    to: string; data: string; value: bigint;
    nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
    gasLimit: bigint;
  }
): string {
  const fields: (Uint8Array | any[])[] = [
    hexToU8(toHex(BigInt(CHAIN_ID))),
    tx.nonce === 0 ? new Uint8Array(0) : stripZeros(hexToU8(toHex(BigInt(tx.nonce)))),
    stripZeros(hexToU8(toHex(tx.maxPriorityFeePerGas))),
    stripZeros(hexToU8(toHex(tx.maxFeePerGas))),
    stripZeros(hexToU8(toHex(tx.gasLimit))),
    hexToU8(tx.to),
    tx.value > 0n ? stripZeros(hexToU8(toHex(tx.value))) : new Uint8Array(0),
    hexToU8(tx.data),
    [], // accessList
  ];

  const unsigned = u8Concat(new Uint8Array([0x02]), rlpEncode(fields));
  const msgHash = keccak_256(unsigned);

  const privBytes = hexToU8(privateKey);
  const sig = secp256k1.sign(msgHash, privBytes) as any;

  const rBytes = stripZeros(hexToU8((sig.r as bigint).toString(16).padStart(64, "0")));
  const sBytes = stripZeros(hexToU8((sig.s as bigint).toString(16).padStart(64, "0")));
  const v: number = sig.recovery;

  const signedFields: (Uint8Array | any[])[] = [
    ...fields,
    v === 0 ? new Uint8Array(0) : new Uint8Array([v]),
    rBytes,
    sBytes,
  ];

  return "0x02" + bytesToHex(rlpEncode(signedFields));
}

// Money leaves the platform wallet in exactly one place: processWithdrawals.
// It only ever pays out amounts already taken from a prepaid balance.

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEPOSIT_CONFIRMATIONS = 2;
const RECEIPT_WAIT_MS = 45_000;
const STALE_SENDING_MS = 10 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const topicToAddress = (topic: string) => "0x" + topic.slice(-40).toLowerCase();

// ── Deposits: credit a balance from a verified on-chain USDC transfer ──
export const claimDeposit = action({
  args: { token: v.string(), txHash: v.string() },
  handler: async (ctx, { token, txHash }): Promise<{ credited: number; alreadyCredited: boolean; balance: number }> => {
    const user = await ctx.runQuery(internal.wallet.sessionUser, { token });
    if (!user) throw new ConvexError("Not signed in: missing, invalid or expired token");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new ConvexError("Invalid transaction hash");
    const treasury = process.env.RECEIVING_WALLET?.toLowerCase();
    if (!treasury) throw new ConvexError("Deposits are not configured (RECEIVING_WALLET is not set)");
    const hash = txHash.toLowerCase();

    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (!receipt) throw new ConvexError("Transaction not found yet. Wait a few seconds and try again.");
    if (receipt.status !== "0x1") throw new ConvexError("Transaction failed on-chain");
    const blockNumber = parseInt(receipt.blockNumber, 16);
    const latest = parseInt(await rpc("eth_blockNumber"), 16);
    if (latest - blockNumber < DEPOSIT_CONFIRMATIONS) {
      throw new ConvexError("Transaction not confirmed yet. Wait a few seconds and try again.");
    }

    // Count only USDC that moved from this account's own wallet to the platform wallet.
    const wallet = user.walletAddress.toLowerCase();
    let amount = 0n;
    for (const log of receipt.logs as any[]) {
      if (log.address?.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
      if (log.topics?.length !== 3 || log.topics[0] !== TRANSFER_TOPIC) continue;
      if (topicToAddress(log.topics[1]) !== wallet || topicToAddress(log.topics[2]) !== treasury) continue;
      amount += BigInt(log.data);
    }
    if (amount <= 0n) {
      throw new ConvexError("No USDC transfer from your wallet to the RICO deposit address in this transaction");
    }
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConvexError("Deposit too large");

    return await ctx.runMutation(internal.wallet.creditDeposit, {
      userId: user._id, txHash: hash, amountMicro: Number(amount), blockNumber,
    });
  },
});

// ── Withdrawals ──

async function sendUsdc(privateKey: string, to: string, amountMicro: number): Promise<string> {
  const from = privateKeyToAddress(privateKey);
  const [nonceHex, gasPriceHex] = await Promise.all([
    rpc("eth_getTransactionCount", [from, "pending"]),
    rpc("eth_gasPrice"),
  ]);
  const gasPrice = BigInt(gasPriceHex);
  const rawTx = signTransaction(privateKey, {
    to: USDC_ADDRESS,
    data: encodeTransferData(to, BigInt(amountMicro)),
    value: 0n,
    nonce: parseInt(nonceHex, 16),
    maxFeePerGas: gasPrice * 2n,
    maxPriorityFeePerGas: gasPrice / 10n,
    gasLimit: 100000n,
  });
  return await rpc("eth_sendRawTransaction", [rawTx]);
}

/** Poll for a receipt. Returns "sent", "reverted", or null if still unknown. */
async function waitForReceipt(txHash: string, maxMs: number): Promise<"sent" | "reverted" | null> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    try {
      const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
      if (receipt) return receipt.status === "0x1" ? "sent" : "reverted";
    } catch { /* transient RPC trouble: keep polling */ }
    if (Date.now() >= deadline) return null;
    await sleep(2000);
  }
}

/**
 * Work through the withdrawal queue, one transfer at a time.
 *
 * The rule throughout: refund a balance only when the transfer provably did
 * not happen. If that is uncertain, park the withdrawal in "review" for a
 * human, because refunding a transfer that did land would pay it twice.
 */
export const processWithdrawals = internalAction({
  args: {},
  handler: async (ctx) => {
    for (let i = 0; i < 10; i++) {
      const next = await ctx.runMutation(internal.wallet.nextWithdrawal, {});
      if (!next) return;
      const w = next.withdrawal;
      const finish = (outcome: "sent" | "failed" | "review", error?: string) =>
        ctx.runMutation(internal.wallet.finishWithdrawal, { id: w._id, outcome, error });

      if (next.job === "check") {
        // Left over from an earlier run that was still waiting, or that crashed.
        const stale = Date.now() - w.updatedAt > STALE_SENDING_MS;
        if (!w.txHash) {
          if (!stale) return; // another run may be mid-send
          await finish("review", "Interrupted before a transaction hash was recorded");
          continue;
        }
        const result = await waitForReceipt(w.txHash, 0);
        if (result === "sent") await finish("sent");
        else if (result === "reverted") await finish("failed", "Transfer reverted on-chain");
        else if (stale) await finish("review", "No receipt after 10 minutes");
        else return; // still pending: the cron will look again
        continue;
      }

      const privateKey = process.env.PLATFORM_PRIVATE_KEY;
      if (!privateKey) { await finish("failed", "PLATFORM_PRIVATE_KEY not set"); continue; }

      let txHash: string;
      try {
        txHash = await sendUsdc(privateKey, w.to, w.amountMicro);
      } catch (e: any) {
        // A rejection from the node means nothing was broadcast. Anything else
        // (timeout, dropped connection) leaves it unknown.
        if (e instanceof RpcRejected) await finish("failed", e.message);
        else await finish("review", `Send outcome unknown: ${e.message}`);
        console.error(`Withdrawal ${w._id} not sent:`, e.message);
        continue;
      }
      await ctx.runMutation(internal.wallet.recordWithdrawalTx, { id: w._id, txHash });
      console.log(`USDC sent: ${w.amountMicro / 1e6} -> ${w.to.slice(0, 10)}… tx=${txHash}`);

      const result = await waitForReceipt(txHash, RECEIPT_WAIT_MS);
      if (result === "sent") await finish("sent");
      else if (result === "reverted") await finish("failed", "Transfer reverted on-chain");
      else return; // stays "sending"; checked again on the next run
    }
  },
});
