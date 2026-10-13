import { useCallback, useEffect, useMemo, useState } from "react";
import { numberToHex, type Address, type EIP1193Provider } from "viem";
import { chain } from "../lib/config";
import {
  forgetWallet,
  getActiveProvider,
  legacyProvider,
  rememberWallet,
  rememberedWallet,
  setActiveProvider,
  subscribeToWallets,
  type WalletOption,
} from "../lib/providers";

export interface WalletState {
  account: Address | null;
  chainId: number | null;
  error: string | null;
  /** Wallets discovered via EIP-6963, for the picker. */
  wallets: WalletOption[];
  connectedWalletName: string | null;
  wrongNetwork: boolean;
  /**
   * Connect with a specific wallet. Omit to use the only/remembered one — or,
   * with several installed and none remembered, to open the picker.
   */
  connect: (option?: WalletOption) => Promise<void>;
  /** The nav's wallet picker. Any Connect button can open it via `connect()`. */
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  disconnect: () => Promise<void>;
  switchNetwork: () => Promise<void>;
}

/**
 * Wallet access is strictly opt-in: nothing here touches a provider until the
 * user clicks Connect. Discovery itself is passive — EIP-6963 announcements are
 * wallets introducing themselves, not us probing them — so no prompt appears
 * and no visitor is fingerprinted by loading the page.
 *
 * There is deliberately no transient "connecting" state: leaving it would need
 * proof the request finished, and neither available signal gives that. The
 * request never settles if a popup is dismissed, and window focus never returns
 * if the popup never took focus. Such a state can only get stuck and make the
 * button look dead, so the wallet's own popup is the feedback instead.
 */
export function useWallet(): WalletState {
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [connected, setConnected] = useState<WalletOption | null>(null);
  /** Set by an explicit disconnect, so a wallet event cannot sign the user back in. */
  const [dismissed, setDismissed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => subscribeToWallets(setWallets), []);

  const provider: EIP1193Provider | null = connected?.provider ?? null;

  const readChain = useCallback(async (p: EIP1193Provider) => {
    try {
      const id = (await p.request({ method: "eth_chainId" })) as string;
      setChainId(Number.parseInt(id, 16));
    } catch {
      /* harmless — chain id only drives the wrong-network hint */
    }
  }, []);

  /**
   * Which wallet to use when the user just clicks Connect: their remembered
   * choice, or the only one installed. With several installed and no previous
   * choice this returns null and the caller shows a picker — guessing would
   * risk asking a wallet the user never meant to use.
   */
  const defaultWallet = useMemo(() => {
    const remembered = rememberedWallet();
    if (remembered) {
      const match = wallets.find((w) => w.info.rdns === remembered);
      if (match) return match;
    }
    return wallets.length === 1 ? wallets[0] : null;
  }, [wallets]);

  const connect = useCallback(
    async (option?: WalletOption) => {
      setDismissed(false);
      setError(null);

      const chosen = option ?? defaultWallet;

      // Nothing announced: fall back to the legacy slot for older wallets.
      if (!chosen) {
        if (wallets.length === 0) {
          const legacy = legacyProvider();
          if (!legacy) {
            setError("No browser wallet detected. Install MetaMask to trade.");
            return;
          }
          setActiveProvider(legacy);
          await request(legacy, null);
          return;
        }
        // Several wallets and no pick yet. This used to return silently on
        // the assumption that the nav's picker was the caller — but Connect
        // buttons in the market panel, Trade and Portfolio call this too, and
        // on a domain with no remembered wallet they did nothing at all.
        setPickerOpen(true);
        return;
      }

      setPickerOpen(false);
      setActiveProvider(chosen.provider);
      rememberWallet(chosen.info.rdns);
      await request(chosen.provider, chosen);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [defaultWallet, wallets],
  );

  async function request(p: EIP1193Provider, option: WalletOption | null) {
    try {
      const accounts = (await p.request({ method: "eth_requestAccounts" })) as Address[];
      if (accounts.length === 0) {
        setError("The wallet returned no accounts. Unlock it and try again.");
        return;
      }
      setAccount(accounts[0]);
      setConnected(option);
      await readChain(p);
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === -32002) {
        setError(
          `${option?.info.name ?? "The wallet"} already has a request open — open the extension and approve it.`,
        );
      } else if (code === 4001) {
        setError("Connection rejected in wallet.");
      } else {
        setError(e instanceof Error ? e.message : "Failed to connect");
      }
    }
  }

  // Account/chain events only matter once connected to a specific wallet.
  useEffect(() => {
    if (!provider) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as Address[];
      setAccount(accounts.length > 0 && !dismissed ? accounts[0] : null);
    };
    const onChain = (...args: unknown[]) => {
      setChainId(Number.parseInt(args[0] as string, 16));
    };
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    return () => {
      provider.removeListener("accountsChanged", onAccounts);
      provider.removeListener("chainChanged", onChain);
    };
  }, [provider, dismissed]);

  /**
   * EIP-1193 has no dapp-side logout: the wallet owns the permission, so the
   * honest scope here is "forget the account in this app". Revoking as well
   * means the next connect prompts rather than silently re-authorising.
   */
  const disconnect = useCallback(async () => {
    const p = getActiveProvider();
    setAccount(null);
    setChainId(null);
    setError(null);
    setConnected(null);
    setDismissed(true);
    forgetWallet();
    setActiveProvider(null);
    try {
      await p?.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      /* older wallets have no such method; the local disconnect still stands */
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!provider) return;
    setError(null);
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: numberToHex(chain.id) }],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to switch network");
    }
  }, [provider]);

  return {
    account,
    chainId,
    error,
    wallets,
    connectedWalletName: connected?.info.name ?? null,
    wrongNetwork: account !== null && chainId !== null && chainId !== chain.id,
    connect,
    pickerOpen,
    setPickerOpen,
    disconnect,
    switchNetwork,
  };
}
