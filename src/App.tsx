import { type ReactNode, startTransition, useEffect, useState } from "react";
import { AptosWalletAdapterProvider, useWallet } from "@aptos-labs/wallet-adapter-react";
import type { InputTransactionData } from "@aptos-labs/wallet-adapter-core";
import type { UserTransactionResponse } from "@aptos-labs/ts-sdk";
import { Network } from "@aptos-labs/ts-sdk";
import { aptos } from "./aptos";
import {
  APT_METADATA_ADDRESS,
  BALANCE_VIEW,
  CONFIG_MODULE,
  DECIMALS,
  FINALIZE_EVENT_TYPE,
  FUNGIBLE_ASSET_METADATA_TYPE,
  GATEWAY_MODULE,
  KAPT_METADATA_ADDRESS,
  NETWORK_LABEL,
  REQUEST_EVENT_TYPE,
  STKAPT_METADATA_ADDRESS,
  WITHDRAWAL_MANAGER_MODULE,
} from "./constants";

type Balances = {
  apt: string;
  kapt: string;
  stkapt: string;
};

type PendingTicket = {
  ticketId: string;
  user: string;
  kaptAmount: string;
  aptAmount: string;
  unlockTimestamp: string;
  withdrawFees: string;
};

type ClaimedTicket = {
  withdrawalId: string;
  aptAmount: string;
  timestampMicros: string;
  txHash: string;
};

type RequestRecord = {
  withdrawalId: string;
  aptAmount: string;
  kaptAmount: string;
  unlockTimestamp: string;
  timestampMicros: string;
  txHash: string;
};

type ActionState = {
  title: string;
  kind: "idle" | "loading" | "success" | "error";
  message: string;
};

const EMPTY_BALANCES: Balances = {
  apt: "0",
  kapt: "0",
  stkapt: "0",
};
const QUICK_PERCENTAGES = [25, 50, 100] as const;

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTokenAmount(raw: string, decimals = DECIMALS) {
  const value = BigInt(raw || "0");
  const base = BigInt(10) ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

function addThousandsSeparators(value: string) {
  const [wholePart, fractionPart] = value.split(".");
  const formattedWhole = wholePart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fractionPart ? `${formattedWhole}.${fractionPart}` : formattedWhole;
}

function formatDisplayAmount(raw: string, decimals = DECIMALS, visibleFractionDigits = 4) {
  const exact = formatTokenAmount(raw, decimals);
  const [wholePart, fractionPart = ""] = exact.split(".");

  if (!fractionPart) return addThousandsSeparators(wholePart);

  const visibleFraction = fractionPart.slice(0, visibleFractionDigits).replace(/0+$/, "");
  if (visibleFraction) return `${addThousandsSeparators(wholePart)}.${visibleFraction}`;

  return BigInt(raw || "0") === 0n ? "0" : `<0.${"0".repeat(Math.max(visibleFractionDigits - 1, 0))}1`;
}

function formatBalanceDetail(raw: string, decimals = DECIMALS) {
  return `${addThousandsSeparators(formatTokenAmount(raw, decimals))} exact`;
}

function getPercentageAmount(raw: string, percentage: number) {
  const scaled = (BigInt(raw || "0") * BigInt(percentage)) / 100n;
  return formatTokenAmount(scaled.toString());
}

function parseTokenInput(input: string, decimals = DECIMALS) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [wholePart, decimalPart = ""] = trimmed.split(".");
  if (decimalPart.length > decimals) return null;
  const paddedDecimals = decimalPart.padEnd(decimals, "0");
  return `${BigInt(wholePart || "0") * 10n ** BigInt(decimals) + BigInt(paddedDecimals || "0")}`;
}

function formatCountdown(unlockTimestamp: string, nowMs: number) {
  const remainingMs = Number(unlockTimestamp) * 1000 - nowMs;
  if (remainingMs <= 0) return "Ready now";

  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

function formatDateFromSeconds(seconds: string) {
  return new Date(Number(seconds) * 1000).toLocaleString();
}

function formatDateFromMicros(micros: string) {
  return new Date(Math.floor(Number(micros) / 1000)).toLocaleString();
}

async function fetchFaBalance(address: string, metadataAddress: string) {
  const [balance] = await aptos.viewJson<[string]>({
    payload: {
      function: BALANCE_VIEW,
      typeArguments: [FUNGIBLE_ASSET_METADATA_TYPE],
      functionArguments: [address, metadataAddress],
    },
  });
  return balance ?? "0";
}

async function fetchPendingTickets(address: string) {
  const [tickets] = await aptos.viewJson<[PendingTicket[]]>({
    payload: {
      function: `${WITHDRAWAL_MANAGER_MODULE}::get_user_tickets`,
      typeArguments: [],
      functionArguments: [address],
    },
  });
  return tickets ?? [];
}

async function fetchWithdrawalPeriod() {
  const [seconds] = await aptos.viewJson<[string]>({
    payload: {
      function: `${CONFIG_MODULE}::get_withdrawal_period`,
      typeArguments: [],
      functionArguments: [],
    },
  });
  return seconds ?? "0";
}

async function fetchRecentTicketHistory(address: string) {
  const transactions = await aptos.getAccountTransactions({
    accountAddress: address,
    options: { limit: 50 },
  });

  const requests = new Map<string, RequestRecord>();
  const finalized: ClaimedTicket[] = [];

  for (const transaction of transactions) {
    if (!("events" in transaction) || !Array.isArray(transaction.events)) continue;
    const tx = transaction as UserTransactionResponse;
    const timestampMicros = tx.timestamp ?? "0";
    const txHash = tx.hash;

    for (const event of tx.events) {
      if (event.type === REQUEST_EVENT_TYPE) {
        const data = event.data as Record<string, string>;
        requests.set(data.withdrawal_id, {
          withdrawalId: data.withdrawal_id,
          aptAmount: data.apt_amount,
          kaptAmount: data.kapt_amount,
          unlockTimestamp: data.unlock_timestamp,
          timestampMicros,
          txHash,
        });
      }
      if (event.type === FINALIZE_EVENT_TYPE) {
        const data = event.data as Record<string, string>;
        finalized.push({
          withdrawalId: data.withdrawal_id,
          aptAmount: data.apt_amount,
          timestampMicros,
          txHash,
        });
      }
    }
  }

  return {
    requests,
    finalized: finalized.sort((a, b) => Number(b.timestampMicros) - Number(a.timestampMicros)),
  };
}

function WalletShell() {
  const {
    account,
    connect,
    connected,
    disconnect,
    isLoading,
    network,
    notDetectedWallets,
    signAndSubmitTransaction,
    wallet,
    wallets,
  } = useWallet();

  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [balances, setBalances] = useState<Balances>(EMPTY_BALANCES);
  const [pendingTickets, setPendingTickets] = useState<PendingTicket[]>([]);
  const [claimedTickets, setClaimedTickets] = useState<ClaimedTicket[]>([]);
  const [withdrawalPeriod, setWithdrawalPeriod] = useState("0");
  const [stakeAmount, setStakeAmount] = useState("");
  const [unstakeAmount, setUnstakeAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [actionState, setActionState] = useState<ActionState>({
    title: "No action yet",
    kind: "idle",
    message: "Connect an Aptos wallet to read balances and submit Kofi transactions.",
  });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const address = account?.address.toString() ?? "";

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!connected || !address) {
      startTransition(() => {
        setBalances(EMPTY_BALANCES);
        setPendingTickets([]);
        setClaimedTickets([]);
      });
      return;
    }

    let cancelled = false;
    setRefreshing(true);

    const load = async () => {
      try {
        const [apt, kapt, stkapt, tickets, history, period] = await Promise.all([
          fetchFaBalance(address, APT_METADATA_ADDRESS),
          fetchFaBalance(address, KAPT_METADATA_ADDRESS),
          fetchFaBalance(address, STKAPT_METADATA_ADDRESS),
          fetchPendingTickets(address),
          fetchRecentTicketHistory(address),
          fetchWithdrawalPeriod(),
        ]);

        if (cancelled) return;

        const pendingIds = new Set(tickets.map((ticket) => ticket.ticketId));
        const claimed = history.finalized.filter((ticket) => !pendingIds.has(ticket.withdrawalId));

        startTransition(() => {
          setBalances({ apt, kapt, stkapt });
          setPendingTickets(tickets.sort((a, b) => Number(a.unlockTimestamp) - Number(b.unlockTimestamp)));
          setClaimedTickets(claimed);
          setWithdrawalPeriod(period);
        });
      } catch (error) {
        if (cancelled) return;
        setActionState({
          title: "Refresh failed",
          kind: "error",
          message: error instanceof Error ? error.message : "Unable to refresh on-chain state.",
        });
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [address, connected, refreshNonce]);

  async function submitKofiAction(title: string, transaction: InputTransactionData) {
    if (!connected) {
      setActionState({
        title,
        kind: "error",
        message: "Connect a wallet before sending a transaction.",
      });
      return;
    }

    try {
      setActionState({
        title,
        kind: "loading",
        message: "Waiting for wallet approval...",
      });

      const response = await signAndSubmitTransaction(transaction);

      setActionState({
        title,
        kind: "loading",
        message: `Submitted ${response.hash}. Waiting for execution...`,
      });

      await aptos.waitForTransaction({ transactionHash: response.hash });

      setActionState({
        title,
        kind: "success",
        message: `Confirmed on-chain: ${response.hash}`,
      });

      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setActionState({
        title,
        kind: "error",
        message: error instanceof Error ? error.message : "Transaction rejected.",
      });
    }
  }

  function submitStake() {
    const amount = parseTokenInput(stakeAmount);
    if (!amount || BigInt(amount) <= 0n) {
      setActionState({
        title: "Convert kAPT to stkAPT",
        kind: "error",
        message: "Enter a valid kAPT amount with up to 8 decimals.",
      });
      return;
    }

    void submitKofiAction("Convert kAPT to stkAPT", {
      data: {
        function: `${GATEWAY_MODULE}::stake_entry`,
        typeArguments: [],
        functionArguments: [amount],
      },
    });
  }

  function submitUnstake() {
    const amount = parseTokenInput(unstakeAmount);
    if (!amount || BigInt(amount) <= 0n) {
      setActionState({
        title: "Convert stkAPT to kAPT",
        kind: "error",
        message: "Enter a valid stkAPT amount with up to 8 decimals.",
      });
      return;
    }

    void submitKofiAction("Convert stkAPT to kAPT", {
      data: {
        function: `${GATEWAY_MODULE}::unstake_entry`,
        typeArguments: [],
        functionArguments: [amount],
      },
    });
  }

  function submitWithdrawal() {
    const amount = parseTokenInput(withdrawAmount);
    if (!amount || BigInt(amount) <= 0n) {
      setActionState({
        title: "Request kAPT withdrawal",
        kind: "error",
        message: "Enter a valid kAPT withdrawal amount with up to 8 decimals.",
      });
      return;
    }

    void submitKofiAction("Request kAPT withdrawal", {
      data: {
        function: `${GATEWAY_MODULE}::request_withdrawal_entry`,
        typeArguments: [],
        functionArguments: [amount],
      },
    });
  }

  function claimTicket(ticketId: string) {
    void submitKofiAction(`Claim ticket #${ticketId}`, {
      data: {
        function: `${GATEWAY_MODULE}::finalize_withdrawals_entry`,
        typeArguments: [],
        functionArguments: [[ticketId]],
      },
    });
  }

  const walletChoices = wallets.filter((item) => item.readyState !== "NotDetected");

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero__copy">
          <span className="eyebrow">Kofi Aptos Console</span>
          <h1>Manage kAPT exits, stkAPT conversions, and withdrawal tickets from one wallet page.</h1>
          <p>
            This page talks directly to Aptos mainnet. No backend, no proxy, no server state. Wallet actions go
            straight to Kofi&apos;s gateway contract.
          </p>
          <div className="hero__meta">
            <span>{NETWORK_LABEL}</span>
            <span>{`Exit queue: ${Number(withdrawalPeriod || "0") / 86400 || 14} days`}</span>
            <span>{refreshing ? "Refreshing on-chain state..." : "On-chain state is live"}</span>
          </div>
        </div>

        <div className="hero__panel">
          <div className="wallet-card">
            <div>
              <p className="wallet-card__label">Wallet</p>
              <strong>{connected && address ? shortAddress(address) : "Not connected"}</strong>
              <p className="wallet-card__subtle">{wallet?.name ?? "Pick any detected Aptos wallet"}</p>
            </div>
            <div className="wallet-card__actions">
              {connected ? (
                <button className="button button--ghost" onClick={disconnect}>
                  Disconnect
                </button>
              ) : (
                <button className="button" onClick={() => setWalletMenuOpen(true)} disabled={isLoading}>
                  {isLoading ? "Loading..." : "Connect wallet"}
                </button>
              )}
            </div>
          </div>

          <div className="wallet-stats">
            <Metric label="APT" rawValue={balances.apt} />
            <Metric label="kAPT" rawValue={balances.kapt} />
            <Metric label="stkAPT" rawValue={balances.stkapt} />
          </div>
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <SectionHeading
            title="Convert between kAPT and stkAPT"
            text="Stake kAPT into stkAPT or unstake stkAPT back into kAPT using Kofi gateway entry functions."
          />

          <div className="split">
            <ActionForm
              title="kAPT → stkAPT"
              inputLabel="kAPT amount"
              value={stakeAmount}
              onChange={setStakeAmount}
              onSubmit={submitStake}
              buttonLabel="Convert to stkAPT"
              balanceLabel="Available kAPT"
              balanceRawValue={balances.kapt}
            />
            <ActionForm
              title="stkAPT → kAPT"
              inputLabel="stkAPT amount"
              value={unstakeAmount}
              onChange={setUnstakeAmount}
              onSubmit={submitUnstake}
              buttonLabel="Convert to kAPT"
              balanceLabel="Available stkAPT"
              balanceRawValue={balances.stkapt}
            />
          </div>
        </section>

        <section className="card">
          <SectionHeading
            title="Request native APT withdrawal"
            text="This uses Kofi's native withdrawal path. It creates a ticket now and unlocks APT after the protocol queue period."
          />

          <ActionForm
            title="kAPT → APT"
            inputLabel="kAPT withdrawal amount"
            value={withdrawAmount}
            onChange={setWithdrawAmount}
            onSubmit={submitWithdrawal}
            buttonLabel="Request withdrawal"
            balanceLabel="Available kAPT"
            balanceRawValue={balances.kapt}
          />

          <div className="note">
            <strong>What happens next</strong>
            <p>
              The request burns your kAPT, creates a withdrawal ticket, and unlocks claimable APT after the current
              queue. When the countdown reaches zero, use the claim button in the ticket list below.
            </p>
          </div>
        </section>

        <section className="card card--wide">
          <SectionHeading
            title="Current withdrawal tickets"
            text="Pending tickets come from the live Kofi view function. Claimed tickets come from your recent account transaction history."
          />

          <div className="ticket-layout">
            <div>
              <h3>Unclaimed / pending</h3>
              {pendingTickets.length === 0 ? (
                <EmptyState text="No live tickets for this wallet." />
              ) : (
                <div className="ticket-stack">
                  {pendingTickets.map((ticket) => {
                    const ready = Number(ticket.unlockTimestamp) * 1000 <= nowMs;
                    return (
                      <article className="ticket" key={ticket.ticketId}>
                        <div className="ticket__head">
                          <span>{`Ticket #${ticket.ticketId}`}</span>
                          <span className={ready ? "badge badge--ready" : "badge"}>{ready ? "Claimable" : "Queued"}</span>
                        </div>
                        <dl className="ticket__facts">
                          <Fact label="kAPT burned" value={formatTokenAmount(ticket.kaptAmount)} />
                          <Fact label="APT claimable" value={formatTokenAmount(ticket.aptAmount)} />
                          <Fact label="Unlock time" value={formatDateFromSeconds(ticket.unlockTimestamp)} />
                          <Fact label="Countdown" value={formatCountdown(ticket.unlockTimestamp, nowMs)} />
                        </dl>
                        <button className="button" disabled={!ready} onClick={() => claimTicket(ticket.ticketId)}>
                          {ready ? "Claim APT" : "Waiting for unlock"}
                        </button>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <h3>Claimed / recent</h3>
              {claimedTickets.length === 0 ? (
                <EmptyState text="No claimed Kofi withdrawal tickets found in recent wallet transactions." />
              ) : (
                <div className="ticket-stack">
                  {claimedTickets.map((ticket) => (
                    <article className="ticket ticket--claimed" key={`${ticket.withdrawalId}-${ticket.txHash}`}>
                      <div className="ticket__head">
                        <span>{`Ticket #${ticket.withdrawalId}`}</span>
                        <span className="badge badge--claimed">Claimed</span>
                      </div>
                      <dl className="ticket__facts">
                        <Fact label="APT received" value={formatTokenAmount(ticket.aptAmount)} />
                        <Fact label="Claimed at" value={formatDateFromMicros(ticket.timestampMicros)} />
                        <Fact
                          label="Transaction"
                          value={
                            <a
                              href={`https://explorer.aptoslabs.com/txn/${ticket.txHash}?network=mainnet`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {shortAddress(ticket.txHash)}
                            </a>
                          }
                        />
                      </dl>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="card card--wide">
          <SectionHeading title="Transaction feedback" text="Every wallet submission is echoed here so you can see whether the chain accepted it." />
          <div className={`status status--${actionState.kind}`}>
            <strong>{actionState.title}</strong>
            <p>{actionState.message}</p>
            {network?.name && <span>{`Wallet network: ${network.name}`}</span>}
          </div>
        </section>
      </main>

      {walletMenuOpen && (
        <div className="modal-backdrop" onClick={() => setWalletMenuOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal__head">
              <div>
                <p className="eyebrow">Connect wallet</p>
                <h2>Pick a detected Aptos wallet</h2>
              </div>
              <button className="button button--ghost" onClick={() => setWalletMenuOpen(false)}>
                Close
              </button>
            </div>

            <div className="wallet-list">
              {walletChoices.length === 0 ? (
                <EmptyState text="No AIP-62 Aptos wallets were detected in this browser. Install Petra, Martian, Pontem, or another Aptos wallet and reload." />
              ) : (
                walletChoices.map((item) => (
                  <button
                    key={item.name}
                    className="wallet-option"
                    onClick={() => {
                      connect(item.name);
                      setWalletMenuOpen(false);
                    }}
                  >
                    <span>{item.name}</span>
                    <small>{item.url}</small>
                  </button>
                ))
              )}
            </div>

            {notDetectedWallets.length > 0 && (
              <div className="wallet-install">
                <p className="wallet-install__title">Not detected on this device</p>
                <div className="wallet-install__list">
                  {notDetectedWallets.map((item) => (
                    <a key={item.name} href={item.url} target="_blank" rel="noreferrer">
                      {item.name}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, rawValue }: { label: string; rawValue: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{formatDisplayAmount(rawValue)}</strong>
      <small>{formatBalanceDetail(rawValue)}</small>
    </div>
  );
}

function SectionHeading({ title, text }: { title: string; text: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function ActionForm({
  buttonLabel,
  inputLabel,
  onChange,
  onSubmit,
  title,
  value,
  balanceLabel,
  balanceRawValue,
}: {
  title: string;
  inputLabel: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  buttonLabel: string;
  balanceLabel: string;
  balanceRawValue: string;
}) {
  const exactBalance = formatTokenAmount(balanceRawValue);
  const hasBalance = BigInt(balanceRawValue || "0") > 0n;

  return (
    <div className="action-form">
      <h3>{title}</h3>
      <label>
        <span>{inputLabel}</span>
        <input
          inputMode="decimal"
          placeholder="0.0"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <div className="action-form__meta">
        <span>{`${balanceLabel}: ${formatDisplayAmount(balanceRawValue)}`}</span>
        <small>{formatBalanceDetail(balanceRawValue)}</small>
      </div>
      <div className="quick-select">
        {QUICK_PERCENTAGES.map((percentage) => (
          <button
            key={percentage}
            type="button"
            className="quick-select__button"
            disabled={!hasBalance}
            onClick={() => onChange(getPercentageAmount(balanceRawValue, percentage))}
          >
            {percentage}%
          </button>
        ))}
        <button type="button" className="quick-select__button quick-select__button--ghost" onClick={() => onChange(exactBalance)}>
          Max
        </button>
      </div>
      <button className="button" onClick={onSubmit}>
        {buttonLabel}
      </button>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export default function App() {
  return (
    <AptosWalletAdapterProvider
      autoConnect
      dappConfig={{ network: Network.MAINNET }}
      disableTelemetry
      onError={(error) => {
        console.error("wallet-adapter", error);
      }}
    >
      <WalletShell />
    </AptosWalletAdapterProvider>
  );
}
