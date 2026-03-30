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

// ── EIP-712 helpers for TransferWithAuthorization ──

const EIP712_DOMAIN_TYPEHASH = keccak_256(
  new TextEncoder().encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
);

const TRANSFER_AUTH_TYPEHASH = keccak_256(
  new TextEncoder().encode("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
);

function encodePacked256(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, "0");
  return hexToU8(hex);
}

function encodeAddress(addr: string): Uint8Array {
  return hexToU8(addr.replace(/^0x/, "").padStart(64, "0"));
}

function keccakStr(s: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(s));
}

function computeEIP712Hash(
  auth: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string },
  asset: string,
  domainName: string,
  domainVersion: string,
): Uint8Array {
  // Domain separator
  const domainSep = keccak_256(u8Concat(
    EIP712_DOMAIN_TYPEHASH,
    keccakStr(domainName),
    keccakStr(domainVersion),
    encodePacked256(BigInt(CHAIN_ID)),
    encodeAddress(asset),
  ));

  // Struct hash
  const structHash = keccak_256(u8Concat(
    TRANSFER_AUTH_TYPEHASH,
    encodeAddress(auth.from),
    encodeAddress(auth.to),
    encodePacked256(BigInt(auth.value)),
    encodePacked256(BigInt(auth.validAfter)),
    encodePacked256(BigInt(auth.validBefore)),
    hexToU8(auth.nonce.replace(/^0x/, "").padStart(64, "0")),
  ));

  // EIP-712: keccak256("\x19\x01" || domainSep || structHash)
  return keccak_256(u8Concat(
    new Uint8Array([0x19, 0x01]),
    domainSep,
    structHash,
  ));
}

function recoverAddress(msgHash: Uint8Array, signature: string): string {
  const sigHex = signature.replace(/^0x/, "");
  // Standard 65-byte signature: r(32) + s(32) + v(1)
  if (sigHex.length === 130) {
    const r = BigInt("0x" + sigHex.slice(0, 64));
    const s = BigInt("0x" + sigHex.slice(64, 128));
    const vByte = parseInt(sigHex.slice(128, 130), 16);
    const recovery = vByte >= 27 ? vByte - 27 : vByte;
    const sig = new secp256k1.Signature(r, s).addRecoveryBit(recovery);
    const pubKey = sig.recoverPublicKey(msgHash).toBytes(false);
    const addrHash = keccak_256(pubKey.slice(1));
    return "0x" + bytesToHex(addrHash.slice(12));
  }
  // Smart wallet / ERC-6492 signatures are longer — skip recovery, verify on-chain
  return "";
}

// Get ERC20 balance via eth_call
async function getUSDCBalance(addr: string): Promise<bigint> {
  const selector = "70a08231"; // balanceOf(address)
  const data = "0x" + selector + pad32(addr);
  const result = await rpc("eth_call", [{ to: USDC_ADDRESS, data }, "latest"]);
  return BigInt(result);
}

// Encode transferWithAuthorization call data
function encodeTransferWithAuth(
  auth: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string },
  v: number, r: string, s: string
): string {
  // transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
  const selector = "e3ee160e";
  return "0x" + selector +
    pad32(auth.from) +
    pad32(auth.to) +
    pad32("0x" + BigInt(auth.value).toString(16)) +
    pad32("0x" + BigInt(auth.validAfter).toString(16)) +
    pad32("0x" + BigInt(auth.validBefore).toString(16)) +
    auth.nonce.replace(/^0x/, "").padStart(64, "0") +
    pad32("0x" + v.toString(16)) +
    r.replace(/^0x/, "").padStart(64, "0") +
    s.replace(/^0x/, "").padStart(64, "0");
}

// ── Self-hosted x402 facilitator: verify + settle ──
export const verifyX402 = internalAction({
  args: { paymentBase64: v.string(), requirements: v.any() },
  handler: async (_ctx, { paymentBase64, requirements }) => {
    const privateKey = process.env.PLATFORM_PRIVATE_KEY;
    if (!privateKey) throw new Error("PLATFORM_PRIVATE_KEY not set");

    const paymentPayload = JSON.parse(Buffer.from(paymentBase64, "base64").toString("utf8"));
    const auth = paymentPayload.payload?.authorization;
    const signature = paymentPayload.payload?.signature;

    if (!auth || !signature) {
      return { ok: false, reason: "Missing authorization or signature in payment" };
    }

    const sigHex = signature.replace(/^0x/, "");
    const isSmartWallet = sigHex.length > 130;
    console.log("x402 verify: from=" + auth.from + " to=" + auth.to + " value=" + auth.value + " sigLen=" + sigHex.length + " isSmartWallet=" + isSmartWallet);
    console.log("x402 requirements: payTo=" + requirements.payTo + " maxAmount=" + requirements.maxAmountRequired + " asset=" + requirements.asset);
    console.log("x402 auth details: validAfter=" + auth.validAfter + " validBefore=" + auth.validBefore + " nonce=" + auth.nonce);

    // 1. Check recipient matches
    if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
      console.log("FAIL: recipient mismatch auth.to=" + auth.to + " payTo=" + requirements.payTo);
      return { ok: false, reason: "Recipient mismatch" };
    }
    console.log("PASS: recipient check");

    // 2. Check amount
    if (BigInt(auth.value) < BigInt(requirements.maxAmountRequired)) {
      console.log("FAIL: amount auth.value=" + auth.value + " required=" + requirements.maxAmountRequired);
      return { ok: false, reason: "Insufficient payment amount" };
    }
    console.log("PASS: amount check");

    // 3. Check timing
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(auth.validBefore) < BigInt(now + 6)) {
      console.log("FAIL: expired validBefore=" + auth.validBefore + " now+6=" + (now + 6));
      return { ok: false, reason: "Payment expired" };
    }
    if (BigInt(auth.validAfter) > BigInt(now)) {
      console.log("FAIL: not yet valid validAfter=" + auth.validAfter + " now=" + now);
      return { ok: false, reason: "Payment not yet valid" };
    }
    console.log("PASS: timing check");

    // 4. Verify signature (for EOA / standard 65-byte sigs)
    const domainName = requirements.extra?.name || "USD Coin";
    const domainVersion = requirements.extra?.version || "2";
    const msgHash = computeEIP712Hash(auth, requirements.asset, domainName, domainVersion);
    const recovered = recoverAddress(msgHash, signature);

    if (!isSmartWallet && recovered.toLowerCase() !== auth.from.toLowerCase()) {
      console.log("FAIL: signature mismatch recovered=" + recovered + " expected=" + auth.from);
      return { ok: false, reason: "Invalid signature" };
    }
    console.log("PASS: signature check (smart=" + isSmartWallet + " recovered=" + recovered + ")");

    // 5. Check balance
    const balance = await getUSDCBalance(auth.from);
    if (balance < BigInt(requirements.maxAmountRequired)) {
      console.log("FAIL: insufficient balance=" + balance.toString() + " required=" + requirements.maxAmountRequired);
      return { ok: false, reason: "Insufficient USDC balance" };
    }
    console.log("PASS: balance check (" + balance.toString() + ")");

    // 6. Settle: call transferWithAuthorization on USDC from platform wallet
    const vByte = parseInt(sigHex.slice(128, 130), 16);
    const v = vByte >= 27 ? vByte : vByte + 27;
    const r = "0x" + sigHex.slice(0, 64);
    const s = "0x" + sigHex.slice(64, 128);

    let callData: string;
    if (isSmartWallet) {
      // For smart wallets, use the full signature as-is with receiveWithAuthorization or transferWithAuthorization
      // Smart wallet signatures include ERC-6492 wrapper — submit via transferWithAuthorization
      // The contract handles signature verification internally
      const twaSel = "e3ee160e";
      callData = "0x" + twaSel +
        pad32(auth.from) + pad32(auth.to) +
        pad32("0x" + BigInt(auth.value).toString(16)) +
        pad32("0x" + BigInt(auth.validAfter).toString(16)) +
        pad32("0x" + BigInt(auth.validBefore).toString(16)) +
        auth.nonce.replace(/^0x/, "").padStart(64, "0") +
        // For smart wallet, v/r/s extraction is different - use the signature bytes directly
        // Encode as v=0, r=0, s=0 and rely on ERC-1271 isValidSignature check
        // Actually, we need to use a different approach for smart wallets
        pad32("0x1b") + // v=27
        sigHex.slice(0, 64).padStart(64, "0") +
        sigHex.slice(64, 128).padStart(64, "0");
    } else {
      callData = encodeTransferWithAuth(auth, v, r, s);
    }

    const from = privateKeyToAddress(privateKey);
    const [nonceHex, gasPriceHex] = await Promise.all([
      rpc("eth_getTransactionCount", [from, "latest"]),
      rpc("eth_gasPrice"),
    ]);

    const nonce = parseInt(nonceHex, 16);
    const gasPrice = BigInt(gasPriceHex);

    const tx = {
      to: USDC_ADDRESS,
      data: callData,
      value: 0n,
      nonce,
      maxFeePerGas: gasPrice * 2n,
      maxPriorityFeePerGas: gasPrice / 10n,
      gasLimit: 150000n,
    };

    try {
      const rawTx = signTransaction(privateKey, tx);
      const txHash = await rpc("eth_sendRawTransaction", [rawTx]);
      console.log("x402 settlement tx:", txHash);

      // Wait for receipt
      let receipt = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        receipt = await rpc("eth_getTransactionReceipt", [txHash]);
        if (receipt) break;
      }

      if (!receipt || receipt.status === "0x0") {
        console.error("Settlement tx failed:", JSON.stringify(receipt));
        return { ok: false, reason: "Settlement transaction failed on-chain" };
      }

      console.log("x402 settled successfully:", txHash);
      return { ok: true };
    } catch (e: any) {
      console.error("Settlement error:", e.message);
      return { ok: false, reason: "Settlement failed: " + e.message };
    }
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
