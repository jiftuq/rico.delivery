import { CoinbaseWalletSDK } from "@coinbase/wallet-sdk";
import { createWalletClient, custom } from "viem";
import { base } from "viem/chains";
import { withPaymentInterceptor } from "x402/fetch";

const sdk = new CoinbaseWalletSDK({
  appName: "DROPZONE",
  appChainIds: [8453], // Base Mainnet chain ID
});

export const provider = sdk.makeWeb3Provider();

export const walletClient = createWalletClient({
  chain: base,
  transport: custom(provider as any),
});

export async function connectWallet(): Promise<string> {
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
  return accounts[0];
}

// Derive the HTTP actions URL from the Convex deployment URL
// e.g. https://abc-123.convex.cloud → https://abc-123.convex.site
const convexUrl = import.meta.env.VITE_CONVEX_URL ?? "";
export const SERVER_URL = convexUrl.replace(/\.cloud$/, ".site");

// Fetch wrapper that auto-handles 402 responses by paying with the wallet
export const payFetch = withPaymentInterceptor(fetch, walletClient);
