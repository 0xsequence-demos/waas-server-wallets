import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Balances, WalletSnapshot } from '@polygonlabs/oms-server-wallet-sdk';
import type { SwapView, SwapPhase, RecoveryView } from '@polygonlabs/oms-server-wallet-sdk/trails';
import { api } from './api';
import { walletBalances } from './balances';
import { formatAmount, toUnits } from './amount';
import { Link, navigate, walletPath, swapPath } from './navigation';

type Chain = { id: number; name: string; symbol: string; explorer: string };
type Asset = { chainId: number; asset: string; decimals: number; symbol: string; name: string };
type SwapConfig = {
  enabled: boolean;
  ready: boolean;
  reason?: string;
  chains: Chain[];
  assets: Asset[];
  slippageBps: number[];
  feePolicy: string;
};
type Wallet = { name: string; identifier: string; snapshot: WalletSnapshot };
const labels: Record<SwapPhase, string> = {
  quoted: 'Ready to review',
  preparing: 'Preparing sponsored funding',
  activating: 'Preparing route',
  funding: 'Funding in progress',
  settling: 'Swapping / bridging',
  succeeded: 'Completed',
  expired: 'Quote expired',
  failed: 'Could not start',
  attention: 'Needs attention',
  recovering: 'Recovering funds',
  refunded: 'Funds returned',
};
const amount = (raw: string, asset?: { decimals: number; symbol?: string }) =>
  `${formatAmount(raw, asset?.decimals)} ${asset?.symbol ?? ''}`;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Request failed. Try again.';
const assetKey = (chain: number, asset: string) => `${chain}:${asset.toLowerCase()}`;
const active = (swap: SwapView) => swap.nextAt !== null;
function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div role="alert" className="error">
      {error}
    </div>
  ) : null;
}
function Status({ phase }: { phase: SwapPhase }) {
  return <span className={`status ${phase}`}>{labels[phase]}</span>;
}
function TxLink({
  hash,
  chainId,
  chains,
  label,
}: {
  hash?: string;
  chainId: number;
  chains: Chain[];
  label: string;
}) {
  const chain = chains.find((c) => c.id === chainId);
  return hash && chain ? (
    <a href={`${chain.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
      {label} on {chain.name} ↗
    </a>
  ) : null;
}

export function SwapPage({
  walletId,
  swapId,
  chains,
}: {
  walletId: string;
  swapId?: string;
  chains: Chain[];
}) {
  const [wallet, setWallet] = useState<Wallet>();
  const [config, setConfig] = useState<SwapConfig>();
  const [balances, setBalances] = useState<Balances>();
  const [swap, setSwap] = useState<SwapView>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let alive = true;
    void api<Wallet>(`/wallets/${walletId}`)
      .then((w) => {
        if (alive) setWallet(w);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    void api<SwapConfig>('/swaps/config')
      .then((c) => {
        if (alive) setConfig(c);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    void walletBalances(walletId)
      .then((b) => {
        if (alive) setBalances(b);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [walletId]);
  useEffect(() => {
    if (!swapId) return;
    let alive = true,
      loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api<{ swap: SwapView }>(`/wallets/${walletId}/swaps/${swapId}`);
        if (alive)
          setSwap((previous) =>
            !previous || result.swap.version >= previous.version ? result.swap : previous,
          );
      } catch (e) {
        if (alive) setError(errorText(e));
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [walletId, swapId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function mutate(path: string, body: unknown) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ swap: SwapView }>(
        `/wallets/${walletId}/swaps/${swapId}${path}`,
        body,
      );
      setSwap(result.swap);
    } catch (e) {
      setError(errorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const disabled = !!wallet?.snapshot.disabled;
  const inputAsset =
    swap?.assetMetadata?.origin ??
    config?.assets.find(
      (a) =>
        swap &&
        assetKey(a.chainId, a.asset) ===
          assetKey(swap.request.originChainId, swap.request.originAsset),
    );
  const outputAsset =
    swap?.assetMetadata?.destination ??
    config?.assets.find(
      (a) =>
        swap &&
        assetKey(a.chainId, a.asset) ===
          assetKey(swap.request.destinationChainId, swap.request.destinationAsset),
    );
  const expired = swap && Date.parse(swap.quote.expiresAt) <= now + 30_000;
  return (
    <>
      <Link className="back" href={walletPath(walletId)}>
        ← {wallet?.name ?? 'Wallet details'}
      </Link>
      <section className="page-title">
        <div>
          <p className="eyebrow">SWAPS & BRIDGES</p>
          <h1>{swapId ? 'Swap details' : 'Swap assets'}</h1>
          <p className="subtle">
            {wallet?.name} · Receive funds in this wallet on any supported network.
          </p>
        </div>
        {swap && <Status phase={swap.phase} />}
      </section>
      <ErrorBox error={error} />
      {disabled && (
        <div className="notice">
          This wallet is disabled. Submitted transactions can still complete. Re-enable it from
          wallet details before authorizing new work.
        </div>
      )}
      {!swapId ? (
        config && wallet ? (
          <SwapForm
            walletId={walletId}
            config={config}
            balances={balances}
            disabled={disabled || !wallet.snapshot.wallet}
          />
        ) : (
          <p>Loading swap options…</p>
        )
      ) : !swap ? (
        <p>Loading swap activity…</p>
      ) : (
        <>
          <section className="panel swap-review" aria-label="Swap review">
            <div className="swap-route">
              <div>
                <small>
                  You spend · {chains.find((c) => c.id === swap.request.originChainId)?.name}
                </small>
                <strong>{amount(swap.quote.inputAmount, inputAsset)}</strong>
              </div>
              <span aria-hidden="true">→</span>
              <div>
                <small>
                  Expected receipt ·{' '}
                  {chains.find((c) => c.id === swap.request.destinationChainId)?.name}
                </small>
                <strong>{amount(swap.quote.expectedOutput, outputAsset)}</strong>
              </div>
            </div>
            <dl className="swap-facts">
              <div>
                <dt>Minimum received</dt>
                <dd>{amount(swap.quote.minimumOutput, outputAsset)}</dd>
              </div>
              <div>
                <dt>Slippage</dt>
                <dd>{(swap.request.slippageBps ?? 50) / 100}%</dd>
              </div>
              <div>
                <dt>Route</dt>
                <dd>{swap.quote.providers.join(' → ') || 'Trails'}</dd>
              </div>
              <div>
                <dt>Price impact</dt>
                <dd>{swap.quote.priceImpact.toFixed(2)}%</dd>
              </div>
              <div>
                <dt>Route fees (total)</dt>
                <dd>${swap.quote.fees.totalUsd.toFixed(4)}</dd>
              </div>
              <div>
                <dt>Fee breakdown</dt>
                <dd>
                  Execution ${swap.quote.fees.gasUsd.toFixed(4)} · Trails $
                  {swap.quote.fees.trailsUsd.toFixed(4)} · Providers $
                  {swap.quote.fees.providerUsd.toFixed(4)}
                </dd>
              </div>
              <div>
                <dt>Wallet transaction gas</dt>
                <dd>Sponsored</dd>
              </div>
              <div>
                <dt>Recipient</dt>
                <dd className="mono">{swap.owner}</dd>
              </div>
              {!!swap.quote.estimatedDuration && (
                <div>
                  <dt>Estimated route time</dt>
                  <dd>{swap.quote.estimatedDuration} seconds</dd>
                </div>
              )}
            </dl>
            <p className="subtle">
              Route fees are included in the quote and paid from swap funds. Estimated destination
              funds are not included in your wallet balance.
            </p>
            {swap.phase === 'quoted' && (
              <div className="actions">
                <span>
                  {expired
                    ? 'Quote expired — request a new one.'
                    : `Review expires in ${Math.max(0, Math.floor((Date.parse(swap.quote.expiresAt) - now - 30_000) / 1000))}s`}
                </span>
                <button
                  className="primary"
                  disabled={busy || expired || disabled || !config?.enabled}
                  onClick={() => {
                    void mutate('/confirm', { revision: swap.quote.revision });
                  }}
                >
                  {busy ? 'Confirming…' : 'Confirm swap'}
                </button>
              </div>
            )}
            {!config?.enabled && swap.phase === 'quoted' && (
              <p className="notice">{config?.reason ?? 'Checking swap availability…'}</p>
            )}
            {['expired', 'failed'].includes(swap.phase) && (
              <Link className="primary button-link" href={swapPath(walletId)}>
                Get a new quote
              </Link>
            )}
          </section>
          {swap.confirmedAt && (
            <section className="panel swap-progress" aria-label="Swap progress">
              <h2>{labels[swap.phase]}</h2>
              <ol className="swap-steps">
                {['Preparing', 'Funding', 'Swapping / bridging', 'Completed'].map((label, i) => (
                  <li
                    key={label}
                    className={
                      i <=
                      (swap.phase === 'succeeded'
                        ? 3
                        : swap.phase === 'settling' || swap.funding?.status === 'executed'
                          ? 2
                          : swap.phase === 'funding'
                            ? 1
                            : 0)
                        ? 'reached'
                        : ''
                    }
                  >
                    {label}
                  </li>
                ))}
              </ol>
              <p>
                Processing continues when you leave this page. Last checked{' '}
                {new Date(swap.updatedAt).toLocaleTimeString()}.
              </p>
              {swap.error && (
                <p className="notice">
                  {swap.error === 'FUNDING_PENDING'
                    ? 'Funding is awaiting confirmation. No additional deposit will be sent.'
                    : `This swap needs another status check (${swap.error.replaceAll('_', ' ').toLowerCase()}).`}
                </p>
              )}
              <div className="transaction-links">
                <TxLink
                  hash={swap.funding?.hash}
                  chainId={swap.request.originChainId}
                  chains={chains}
                  label="Wallet funding"
                />
                {swap.transactions
                  .filter((t) => t.type !== 'DEPOSIT')
                  .map((t, i) => (
                    <TxLink
                      key={`${t.type}:${i}`}
                      hash={t.hash}
                      chainId={t.chainId}
                      chains={chains}
                      label={t.type.toLowerCase()}
                    />
                  ))}
              </div>
              <p className="subtle mono">Intent {swap.quote.intentId}</p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  void mutate('/reconcile', {});
                }}
              >
                {busy ? 'Checking…' : 'Check status'}
              </button>
              {swap.phase === 'succeeded' && (
                <p>
                  Received {amount(swap.outputAmount ?? swap.quote.expectedOutput, outputAsset)}.
                  Indexed balances may take a moment to update.
                </p>
              )}
              {swap.refund && (
                <p>
                  Provider refund: {formatAmount(swap.refund.amount)} of{' '}
                  <span className="mono">{swap.refund.asset}</span> on{' '}
                  {chains.find((c) => c.id === swap.refund!.chainId)?.name}. Status:{' '}
                  {swap.refund.status.toLowerCase()}.
                </p>
              )}
            </section>
          )}
          {(swap.canRecover || swap.recoveries.length > 0) && (
            <section className="panel swap-recovery" aria-label="Recover funds">
              <h2>Recovery</h2>
              <p className="subtle">
                Check for remaining funds after a failed or stalled route. Returned assets and
                network can differ from the original input.
              </p>
              {swap.canRecover && (
                <div className="actions">
                  <button
                    className="secondary"
                    disabled={busy || disabled}
                    onClick={() => {
                      void mutate('/recoveries', { id: crypto.randomUUID(), source: 'origin' });
                    }}
                  >
                    Check source funds
                  </button>
                  {swap.request.originChainId !== swap.request.destinationChainId && (
                    <button
                      className="secondary"
                      disabled={busy || disabled}
                      onClick={() => {
                        void mutate('/recoveries', {
                          id: crypto.randomUUID(),
                          source: 'destination',
                        });
                      }}
                    >
                      Check destination funds
                    </button>
                  )}
                </div>
              )}
              {swap.recoveries
                .slice()
                .reverse()
                .map((recovery) => (
                  <RecoveryReview
                    key={recovery.id}
                    recovery={recovery}
                    chains={chains}
                    now={now}
                    disabled={busy || disabled}
                    confirm={() => {
                      void mutate(`/recoveries/${recovery.id}/confirm`, {
                        revision: recovery.revision,
                      });
                    }}
                  />
                ))}
            </section>
          )}
        </>
      )}
    </>
  );
}

function SwapForm({
  walletId,
  config,
  balances,
  disabled,
}: {
  walletId: string;
  config: SwapConfig;
  balances?: Balances;
  disabled: boolean;
}) {
  const [origin, setOrigin] = useState(137),
    [destination, setDestination] = useState(8453);
  const [sourceAsset, setSourceAsset] = useState('native'),
    [targetAsset, setTargetAsset] = useState(
      config.assets.find((a) => a.chainId === 8453 && a.symbol === 'USDC')?.asset ?? 'native',
    );
  const [value, setValue] = useState(''),
    [slippage, setSlippage] = useState(50);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const request = useRef<{ json: string; id: string } | undefined>(undefined);
  const submitting = useRef(false);
  const input = config.assets.find((a) => a.chainId === origin && a.asset === sourceAsset);
  const holding = balances?.items.find(
    (b) => assetKey(b.chainId, b.asset) === assetKey(origin, sourceAsset),
  );
  function changeChain(side: 'origin' | 'destination', chain: number) {
    const asset = config.assets.find((a) => a.chainId === chain)?.asset ?? 'native';
    if (side === 'origin') {
      setOrigin(chain);
      setSourceAsset(asset);
    } else {
      setDestination(chain);
      setTargetAsset(asset);
    }
  }
  async function quote(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      if (!input) throw new Error('Select a supported source asset.');
      const body = {
        originChainId: origin,
        originAsset: sourceAsset,
        destinationChainId: destination,
        destinationAsset: targetAsset,
        amount: toUnits(value, input.decimals),
        slippageBps: slippage,
      };
      const json = JSON.stringify(body);
      if (request.current?.json !== json) request.current = { json, id: crypto.randomUUID() };
      const result = await api<{ swap: SwapView }>(`/wallets/${walletId}/swaps`, {
        id: request.current.id,
        ...body,
      });
      navigate(swapPath(walletId, result.swap.id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="panel swap-form"
      onSubmit={(event) => {
        void quote(event);
      }}
    >
      {!config.enabled && <div className="notice">{config.reason}</div>}
      <div className="swap-fields">
        <div>
          <h2>From</h2>
          <label>
            Source network
            <select value={origin} onChange={(e) => changeChain('origin', Number(e.target.value))}>
              {config.chains.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Source asset
            <select value={sourceAsset} onChange={(e) => setSourceAsset(e.target.value)}>
              {config.assets
                .filter((a) => a.chainId === origin)
                .map((a) => (
                  <option key={a.asset} value={a.asset}>
                    {a.name} ({a.symbol})
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div>
          <h2>To</h2>
          <label>
            Destination network
            <select
              value={destination}
              onChange={(e) => changeChain('destination', Number(e.target.value))}
            >
              {config.chains.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Destination asset
            <select value={targetAsset} onChange={(e) => setTargetAsset(e.target.value)}>
              {config.assets
                .filter((a) => a.chainId === destination)
                .map((a) => (
                  <option key={a.asset} value={a.asset}>
                    {a.name} ({a.symbol})
                  </option>
                ))}
            </select>
          </label>
        </div>
      </div>
      <label>
        Amount to spend
        <input
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <small>
          Indexed balance:{' '}
          {holding
            ? amount(holding.balance, input)
            : balances
              ? 'No holding reported'
              : 'Unavailable'}
          . Current on-chain funds are checked before sending.
        </small>
      </label>
      {balances?.errors.length || balances?.nextPage !== undefined ? (
        <p className="notice">Some indexed balances are unavailable. Values may be incomplete.</p>
      ) : null}
      <label>
        Maximum slippage
        <select value={slippage} onChange={(e) => setSlippage(Number(e.target.value))}>
          {config.slippageBps.map((bps) => (
            <option key={bps} value={bps}>
              {bps / 100}%
            </option>
          ))}
        </select>
      </label>
      <p className="subtle">
        Funds stay with this wallet. Wallet transaction gas is sponsored; route fees are shown in
        your quote.
      </p>
      <ErrorBox error={error} />
      <div className="actions">
        <button
          className="primary"
          disabled={
            busy ||
            disabled ||
            !config.enabled ||
            !input ||
            (origin === destination && sourceAsset === targetAsset)
          }
        >
          {busy ? 'Finding a route…' : 'Review quote'}
        </button>
      </div>
    </form>
  );
}
function RecoveryReview({
  recovery: r,
  chains,
  now,
  disabled,
  confirm,
}: {
  recovery: RecoveryView;
  chains: Chain[];
  now: number;
  disabled: boolean;
  confirm: () => void;
}) {
  return (
    <div className="recovery-review">
      <h3>
        {r.source === 'origin' ? 'Source' : 'Destination'} ·{' '}
        {chains.find((c) => c.id === r.chainId)?.name}
      </h3>
      <ul>
        {r.assets.map((a) => (
          <li key={a.asset}>
            {formatAmount(a.amount, a.decimals)} {a.symbol}{' '}
            <small className="mono">{a.asset}</small>
          </li>
        ))}
      </ul>
      {r.received && (
        <p>
          Confirmed received:{' '}
          {r.received.map((a) => `${formatAmount(a.amount, a.decimals)} ${a.symbol}`).join(', ')}.
        </p>
      )}
      {r.status === 'partial' && (
        <p className="notice">
          Recovery returned less than the reviewed amount or left a remaining balance. Check funds
          again before preparing another recovery.
        </p>
      )}
      <p>Status: {r.status}. Wallet transaction gas is sponsored.</p>
      {r.requiresOwnerDeployment && (
        <p className="notice">
          This wallet needs to be activated on this network first. Confirming authorizes a sponsored
          activation transaction followed by recovery.
        </p>
      )}
      {r.status === 'quoted' && (
        <button
          className="primary"
          disabled={disabled || Date.parse(r.expiresAt) <= now}
          onClick={confirm}
        >
          {Date.parse(r.expiresAt) <= now ? 'Recovery review expired' : 'Confirm recovery'}
        </button>
      )}
      {r.error && (
        <p className="notice">
          {r.error.replaceAll('_', ' ').toLowerCase()}. Check funds again for a fresh review.
        </p>
      )}
      <div className="transaction-links">
        <TxLink
          hash={r.deployment?.hash}
          chainId={r.chainId}
          chains={chains}
          label="Wallet activation"
        />
        <TxLink hash={r.transaction?.hash} chainId={r.chainId} chains={chains} label="Recovery" />
      </div>
    </div>
  );
}

export function SwapActivity({ walletId, chains }: { walletId: string; chains: Chain[] }) {
  const [swaps, setSwaps] = useState<SwapView[]>([]),
    [error, setError] = useState('');
  const [next, setNext] = useState<number | null>(null),
    [busy, setBusy] = useState(false);
  const fetching = useRef(false);
  const lastPage = useRef(0);
  async function load(offset = 0) {
    if (fetching.current) return;
    fetching.current = true;
    setBusy(true);
    try {
      const result = await api<{ swaps: SwapView[]; nextOffset: number | null }>(
        `/wallets/${walletId}/swaps?offset=${offset}`,
      );
      setSwaps((prev) => {
        const merged = new Map(prev.map((s) => [s.id, s]));
        for (const next of result.swaps)
          if (!merged.has(next.id) || merged.get(next.id)!.version <= next.version)
            merged.set(next.id, next);
        return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
      if (offset >= lastPage.current) {
        lastPage.current = offset;
        setNext(result.nextOffset);
      }
      setError('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      fetching.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 10000);
    return () => clearInterval(timer);
  }, [walletId]);
  return (
    <section className="panel activity">
      <div className="panel-toolbar">
        <div>
          <h2>Swaps</h2>
          <p className="subtle">Cross-chain activity and recovery</p>
        </div>
        <Link className="secondary button-link" href={swapPath(walletId)}>
          ⇄ New swap
        </Link>
      </div>
      <ErrorBox error={error} />
      {!swaps.length && !error && (
        <div className="empty">
          <p>{busy ? 'Loading swaps…' : 'No swaps yet.'}</p>
        </div>
      )}
      <div className="operation-list">
        {swaps.map((swap) => (
          <Link
            className="operation swap-activity-row"
            key={swap.id}
            href={swapPath(walletId, swap.id)}
          >
            <span className="operation-icon">⇄</span>
            <div>
              <strong>
                {chains.find((c) => c.id === swap.request.originChainId)?.name} →{' '}
                {chains.find((c) => c.id === swap.request.destinationChainId)?.name}
              </strong>
              <small>
                {new Date(swap.createdAt).toLocaleString()}
                {active(swap)
                  ? ` · Input ${amount(swap.quote.inputAmount, swap.assetMetadata?.origin)} in progress`
                  : ''}
              </small>
              {active(swap) && <small>Expected receipt is excluded from wallet totals</small>}
              {swap.recoveries.length > 0 && (
                <small>{swap.recoveries.length} recovery review(s)</small>
              )}
            </div>
            <Status phase={swap.phase} />
          </Link>
        ))}
      </div>
      {next !== null && (
        <button
          className="secondary more"
          disabled={busy}
          onClick={() => {
            void load(next);
          }}
        >
          Load more swaps
        </button>
      )}
    </section>
  );
}
