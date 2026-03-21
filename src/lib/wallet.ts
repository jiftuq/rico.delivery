import { CoinbaseWalletSDK } from "@coinbase/wallet-sdk";
import { createWalletClient, custom } from "viem";
import { base } from "viem/chains";
import { createPaymentHeader } from "x402/client";

const sdk = new CoinbaseWalletSDK({
  appName: "GIGS.MOM",
  appChainIds: [8453], // Base Mainnet chain ID
});

export const provider = sdk.makeWeb3Provider();

let _walletClient: ReturnType<typeof createWalletClient> | null = null;

function getWalletClient(account: `0x${string}`) {
  if (!_walletClient || (_walletClient.account?.address !== account)) {
    _walletClient = createWalletClient({
      account,
      chain: base,
      transport: custom(provider as any),
    });
  }
  return _walletClient;
}

export async function connectWallet(): Promise<string> {
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
  const addr = accounts[0];
  getWalletClient(addr as `0x${string}`);
  return addr;
}

// Derive the HTTP actions URL from the Convex deployment URL
// e.g. https://abc-123.convex.cloud → https://abc-123.convex.site
const convexUrl = import.meta.env.VITE_CONVEX_URL ?? "";
export const SERVER_URL = convexUrl.replace(/\.cloud$/, ".site");

// Fetch wrapper that auto-handles 402 responses by paying with the wallet
export async function payFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 402) return res;

  const header = res.headers.get("X-Payment-Required");
  if (!header) return res;

  if (!_walletClient?.account) {
    const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
    getWalletClient(accounts[0] as `0x${string}`);
  }

  const { accepts } = JSON.parse(header);
  const paymentRequirements = accepts[0];
  const x402Version = 1;

  const paymentHeader = await createPaymentHeader(_walletClient!, x402Version, paymentRequirements);

  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      "X-Payment": paymentHeader,
    },
  });
}
