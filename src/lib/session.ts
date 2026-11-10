import { useSyncExternalStore } from "react";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api";
import { convex } from "./convex";
import { signMessage } from "./wallet";

// A session is proof that this browser controls a wallet: the wallet signs a
// one-time message and the backend returns a token. The token is sent with
// every action instead of a user ID, and is remembered per wallet so the
// signature is only asked for once a month.

const storageKey = (wallet: string) => "rico_session_" + wallet.toLowerCase();

let token: string | null = null;
const listeners = new Set<() => void>();
const setToken = (next: string | null) => { token = next; listeners.forEach((l) => l()); };

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* private mode */ }
}

/** The current session token, or null when signed out. */
export function useToken(): string | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => token);
}

/** Reuse a remembered session for this wallet, or ask the wallet to sign in. */
export async function ensureSession(wallet: string): Promise<string> {
  const saved = read(storageKey(wallet));
  if (saved && (await convex.query(api.auth.me, { token: saved }))) {
    setToken(saved);
    return saved;
  }
  const { nonce, message } = await convex.action(api.auth.startSignIn, { walletAddress: wallet, origin: window.location.origin });
  const signature = await signMessage(wallet, message);
  const session = await convex.action(api.auth.finishSignIn, { nonce, signature });
  write(storageKey(wallet), session.token);
  setToken(session.token);
  return session.token;
}

export function endSession(wallet: string | null) {
  if (token) convex.mutation(api.auth.signOut, { token }).catch(() => {});
  if (wallet) write(storageKey(wallet), null);
  setToken(null);
}

/** Message to show for a failed backend call. */
export function errMsg(e: any): string {
  if (e instanceof ConvexError) return String(e.data);
  return e?.shortMessage || e?.message || String(e);
}

// ── Deposits that were sent on-chain but not yet credited ──
const PENDING = "rico_pending_deposits";
export const pendingDeposits = (): string[] => { try { return JSON.parse(read(PENDING) || "[]"); } catch { return []; } };
export const addPendingDeposit = (tx: string) => write(PENDING, JSON.stringify([...new Set([...pendingDeposits(), tx])]));
export const removePendingDeposit = (tx: string) => write(PENDING, JSON.stringify(pendingDeposits().filter((t) => t !== tx)));
