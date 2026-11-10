import { CoinbaseWalletSDK } from "@coinbase/wallet-sdk";
import { createWalletClient, createPublicClient, custom, http, parseUnits } from "viem";
import { base } from "viem/chains";

const sdk = new CoinbaseWalletSDK({
  appName: "RICO",
  appChainIds: [8453],
});

export const provider = sdk.makeWeb3Provider();

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const PLATFORM_WALLET = (import.meta.env.VITE_PLATFORM_WALLET || "") as `0x${string}`;

const ERC20_ABI = [
  {
    name: "transfer",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

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

async function ensureBaseChain() {
  const chainId = await provider.request({ method: "eth_chainId" }) as string;
  if (parseInt(chainId, 16) !== 8453) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
    } catch (e: any) {
      if (e.code === 4902) {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x2105",
            chainName: "Base",
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"],
          }],
        });
      } else {
        throw e;
      }
    }
  }
}

export async function connectWallet(): Promise<string> {
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
  const addr = accounts[0];
  getWalletClient(addr as `0x${string}`);
  await ensureBaseChain();
  return addr;
}

export async function disconnectWallet(): Promise<void> {
  await provider.disconnect();
  _walletClient = null;
}

export async function switchWallet(): Promise<string> {
  await disconnectWallet();
  return connectWallet();
}

/** Ask the wallet to sign a plain message (used to sign in; costs nothing). */
export async function signMessage(address: string, message: string): Promise<string> {
  const account = address as `0x${string}`;
  return await getWalletClient(account).signMessage({ account, message });
}

/** Send USDC from the connected wallet to the RICO deposit address. */
export async function payUSDC(amountUSDC: number, depositAddress?: string | null): Promise<string> {
  const to = (depositAddress || PLATFORM_WALLET) as `0x${string}`;
  if (!to) throw new Error("Deposit address not configured");
  await ensureBaseChain();
  if (!_walletClient?.account) {
    const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
    getWalletClient(accounts[0] as `0x${string}`);
  }

  const amount = parseUnits(amountUSDC.toFixed(6), 6);

  const { request } = await createPublicClient({ chain: base, transport: http() }).simulateContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amount],
    account: _walletClient!.account!,
  });

  const hash = await _walletClient!.writeContract(request);

  const publicClient = createPublicClient({ chain: base, transport: http() });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") throw new Error("USDC transfer failed on-chain");

  return hash;
}
