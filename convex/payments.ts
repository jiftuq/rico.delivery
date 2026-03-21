"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal, api } from "./_generated/api";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC = "https://mainnet.base.org";
const CHAIN_ID = 8453;
const FACILITATOR = "https://x402.org/facilitator";

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
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

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
  throw new Error("Invalid RLP input");
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
  // Get uncompressed public key (65 bytes: 04 || x || y)
  const pubUncompressed = secp256k1.getPublicKey(privBytes, false);
  // Ethereum address = last 20 bytes of keccak256(pubkey without 0x04 prefix)
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

  // EIP-1559: hash = keccak256(0x02 || RLP(fields))
  const unsigned = u8Concat(new Uint8Array([0x02]), rlpEncode(fields));
  const msgHash = keccak_256(unsigned);

  // Sign with secp256k1
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

// ── Get receiving wallet (called by http.ts which can't access process.env) ──
export const getReceivingWallet = internalAction({
  args: {},
  handler: async () => {
    const wallet = process.env.RECEIVING_WALLET;
    if (!wallet) throw new Error("RECEIVING_WALLET not set");
    return wallet;
  },
});

// ── Send USDC on-chain from platform wallet ──
export const sendUSDC = internalAction({
  args: { to: v.string(), amountUSDC: v.float64() },
  handler: async (_ctx, { to, amountUSDC }) => {
    if (amountUSDC <= 0) return null;
    const privateKey = process.env.PLATFORM_PRIVATE_KEY;
    if (!privateKey) throw new Error("PLATFORM_PRIVATE_KEY not set");

    const amount = parseUnits(amountUSDC.toFixed(6), 6);
    const data = encodeTransferData(to, amount);
    const from = privateKeyToAddress(privateKey);

    // Get nonce and gas
    const [nonceHex, gasPriceHex] = await Promise.all([
      rpc("eth_getTransactionCount", [from, "latest"]),
      rpc("eth_gasPrice"),
    ]);

    const nonce = parseInt(nonceHex, 16);
    const gasPrice = BigInt(gasPriceHex);
    const maxFeePerGas = gasPrice * 2n;
    const maxPriorityFeePerGas = gasPrice / 10n;

    const tx = {
      to: USDC_ADDRESS,
      data,
      value: 0n,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit: 100000n,
    };

    const rawTx = signTransaction(privateKey, tx);
    const hash = await rpc("eth_sendRawTransaction", [rawTx]);
    console.log(`USDC sent: $${amountUSDC.toFixed(2)} → ${to.slice(0, 10)}… tx=${hash}`);
    return hash;
  },
});

// ── Verify + settle x402 payment via facilitator ──
export const verifyX402 = internalAction({
  args: { paymentBase64: v.string(), requirements: v.any() },
  handler: async (_ctx, { paymentBase64, requirements }) => {
    const payment = JSON.parse(Buffer.from(paymentBase64, "base64").toString("utf8"));

    const vr = await fetch(`${FACILITATOR}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment, paymentRequirements: requirements }),
    });
    const vd = (await vr.json()) as { isValid: boolean; invalidReason?: string };
    if (!vd.isValid) return { ok: false, reason: vd.invalidReason || "Invalid" };

    const sr = await fetch(`${FACILITATOR}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment, paymentRequirements: requirements }),
    });
    if (!sr.ok) return { ok: false, reason: "Settlement failed: " + (await sr.text()) };

    return { ok: true };
  },
});

// ── Auto-release delivered tasks to courier (2h timeout) ──
export const processAutoRelease = internalAction({
  args: {},
  handler: async (ctx) => {
    const expired: any[] = await ctx.runQuery(api.tasks.getDeliveredExpired, {});
    for (const task of expired) {
      console.log(`Auto-releasing task ${task._id} to courier ($${task.totalEscrowed})`);
      try {
        const result: any = await ctx.runMutation(api.tasks.autoReleaseToCourier, { taskId: task._id });
        if (result && result.courierId) {
          const courier: any = await ctx.runQuery(api.users.get, { userId: result.courierId });
          if (courier?.walletAddress && result.payout > 0) {
            await ctx.runAction(internal.payments.sendUSDC, {
              to: courier.walletAddress,
              amountUSDC: result.payout,
            });
          }
        }
      } catch (e: any) {
        console.error(`Auto-release failed for ${task._id}:`, e.message);
      }
    }
  },
});

// ── Auto-refund stuck in_progress tasks (4h timeout) ──
export const processRefunds = internalAction({
  args: {},
  handler: async (ctx) => {
    const stuck: any[] = await ctx.runQuery(api.tasks.getStuckTasks, {});
    for (const task of stuck) {
      console.log(`Auto-refunding task ${task._id} ($${task.totalEscrowed})`);
      try {
        await ctx.runMutation(api.tasks.refundTask, { taskId: task._id });
        const poster: any = await ctx.runQuery(api.users.get, { userId: task.posterId });
        if (poster?.walletAddress && task.totalEscrowed > 0) {
          await ctx.runAction(internal.payments.sendUSDC, {
            to: poster.walletAddress,
            amountUSDC: task.totalEscrowed,
          });
        }
      } catch (e: any) {
        console.error(`Refund failed for ${task._id}:`, e.message);
      }
    }
  },
});
