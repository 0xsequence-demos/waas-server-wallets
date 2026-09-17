import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Balance, Balances, Operation, WalletSnapshot } from '@oms/server-wallet-sdk';
import { api } from './api';
import { formatAmount, toUnits } from './amount';
import { balanceValue, formatUsd, walletBalances } from './balances';
import { Link, navigate, readRoute, usePathname, walletPath } from './navigation';
import './style.css';

interface Chain {
  id: number;
  name: string;
  symbol: string;
  explorer: string;
}
interface Configuration {
  chains: Chain[];
  missing: string[];
  issuer: string;
  audience: string;
  waasVersion: string;
}
interface Wallet {
  id: string;
  identifier: string;
  name: string;
  createdAt: string;
  snapshot: WalletSnapshot | null;
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.';
const short = (value?: string) => (value ? `${value.slice(0, 8)}…${value.slice(-6)}` : 'Pending');

function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close} aria-label={title}>
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" onClick={close} aria-label="Close dialog">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
function ErrorBox({ message }: { message: string }) {
  return message ? (
    <div className="error" role="alert">
      {message}
    </div>
  ) : null;
}
function Status({ value }: { value: string }) {
  return <span className={`status ${value}`}>{value.replace(/_/g, ' ')}</span>;
}
function WalletValue({ balances }: { balances: Balances | null | undefined }) {
  const value = balances ? balanceValue(balances) : undefined;
  return (
    <div className="wallet-value">
      <strong>
        {balances === undefined
          ? 'Loading…'
          : value?.usd !== undefined && value.usd !== null
            ? formatUsd(value.usd)
            : 'Unavailable'}
      </strong>
      <small>
        {value?.partial
          ? 'Partial value · some balances or prices unavailable'
          : 'Across all supported networks'}
      </small>
    </div>
  );
}
function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ authenticated: boolean }>('/session')
      .then((r) => setAuthenticated(r.authenticated))
      .catch((e) => {
        setError(errorText(e));
        setAuthenticated(false);
      });
    const expired = () => setAuthenticated(false);
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/login', { password });
      setPassword('');
      setAuthenticated(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (authenticated === null) return <div className="loading-page">Opening workspace…</div>;
  if (!authenticated)
    return (
      <main className="login-page">
        <div className="login-art">
          <div className="brand">
            ◈ <strong>OMS</strong>
            <span>WALLET INFRASTRUCTURE</span>
          </div>
          <div>
            <p className="eyebrow">YOUR WALLETS. ONE WORKSPACE.</p>
            <h1>
              Control at the
              <br />
              <em>application layer.</em>
            </h1>
            <p>
              Create wallets, move assets, and sign messages.
              <br />
              Powered by OMS wallet infrastructure.
            </p>
          </div>
          <span className="subtle">Server wallet integration · Prototype</span>
        </div>
        <form
          className="login-form"
          onSubmit={(event) => {
            void login(event);
          }}
        >
          <p className="eyebrow">ADMIN WORKSPACE</p>
          <h2>Welcome back</h2>
          <p className="subtle">Enter your shared admin password to continue.</p>
          <label>
            Password
            <input
              autoFocus
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <ErrorBox message={error} />
          <button className="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Open dashboard →'}
          </button>
        </form>
      </main>
    );
  return (
    <Dashboard
      logout={() => {
        void api('/logout', {})
          .then(() => setAuthenticated(false))
          .catch((e) => setError(errorText(e)));
      }}
    />
  );
}
function Dashboard({ logout }: { logout: () => void }) {
  const pathname = usePathname();
  const route = readRoute(pathname);
  const [config, setConfig] = useState<Configuration>();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [balances, setBalances] = useState<Record<string, Balances | null>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const requestVersion = useRef(0);
  async function load(offset = 0) {
    const version = ++requestVersion.current;
    setLoading(true);
    setError('');
    if (!offset) setBalances({});
    try {
      const data = await api<{ wallets: Wallet[]; nextOffset: number | null }>(
        `/wallets?search=${encodeURIComponent(search)}&offset=${offset}`,
      );
      if (version !== requestVersion.current) return;
      setWallets((previous) => (offset ? [...previous, ...data.wallets] : data.wallets));
      setNext(data.nextOffset);
      for (let i = 0; i < data.wallets.length; i += 3)
        await Promise.all(
          data.wallets
            .slice(i, i + 3)
            .filter((wallet) => wallet.snapshot?.wallet)
            .map(async (wallet) => {
              try {
                const result = await walletBalances(wallet.id);
                if (version === requestVersion.current)
                  setBalances((prev) => ({ ...prev, [wallet.id]: result }));
              } catch {
                if (version === requestVersion.current)
                  setBalances((prev) => ({ ...prev, [wallet.id]: null }));
              }
            }),
        );
    } catch (e) {
      if (version === requestVersion.current) setError(errorText(e));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }
  useEffect(() => {
    void api<Configuration>('/config')
      .then(setConfig)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    setCreating(false);
    if (route.kind !== 'list') return;
    const timer = setTimeout(() => {
      void load();
    }, 200);
    return () => {
      clearTimeout(timer);
      requestVersion.current++;
    };
  }, [search, pathname]);
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          ◈ <strong>OMS</strong>
        </div>
        <div className="workspace">
          <span className="workspace-icon">S</span>
          <div>
            Server wallets<small>Admin workspace</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <Link
          className="nav-item active"
          href="/"
          aria-current={route.kind === 'list' ? 'page' : undefined}
        >
          ▦ &nbsp; Wallets
        </Link>
        <div className="sidebar-bottom">
          <span className="status active">● &nbsp; OMS infrastructure</span>
          <p>
            Backend-controlled wallets.
            <br />
            Keys secured by WaaS.
          </p>
          <button className="nav-item" onClick={logout}>
            ↗ &nbsp; Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        <header>
          <div>
            <span className="breadcrumb">Workspace /</span> Server wallets
          </div>
          <span className="admin-avatar" title="Shared administrator">
            A
          </span>
        </header>
        {route.kind === 'wallet' ? (
          config ? (
            <WalletDetail key={route.id} id={route.id} config={config} />
          ) : (
            <section className="page-title">
              <h1>Loading wallet…</h1>
              <ErrorBox message={error} />
            </section>
          )
        ) : route.kind === 'not-found' ? (
          <section className="page-title">
            <div>
              <h1>Page not found</h1>
              <Link className="back" href="/">
                ← All wallets
              </Link>
            </div>
          </section>
        ) : (
          <>
            <section className="page-title">
              <div>
                <p className="eyebrow">WALLET OPERATIONS</p>
                <h1>Your wallet workspace</h1>
                <p className="subtle">Create and manage wallets from your backend.</p>
              </div>
              <button
                className="primary create-wallet-button"
                disabled={!config || config.missing.length > 0}
                onClick={() => setCreating(true)}
              >
                <svg
                  className="button-icon"
                  viewBox="0 0 20 20"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M10 4v12M4 10h12" />
                </svg>
                Create wallet
              </button>
            </section>
            {config && config.missing.length > 0 && (
              <div className="setup-notice">
                <strong>Connect your OMS environment</strong>
                <p>
                  The dashboard is ready for configuration. Complete: {config.missing.join(', ')}.
                </p>
                <p>
                  Deploy the issuer, register its discovery URL in OMS dev, then configure the
                  publishable key and approved enclave measurements.
                </p>
              </div>
            )}
            <section className="stats">
              <div>
                <span>Wallets loaded</span>
                <strong>
                  {wallets.length.toLocaleString()}
                  {next !== null ? '+' : ''}
                </strong>
                <small>One identity, one wallet</small>
              </div>
              <div>
                <span>Supported networks</span>
                <strong>
                  5 <i>EVM</i>
                </strong>
                <small>Polygon, Arbitrum, Base, BNB, Ethereum</small>
              </div>
              <div>
                <span>Transaction fees</span>
                <strong className="sponsored-text">
                  Sponsored <span>↗</span>
                </strong>
                <small>Required for every transfer</small>
              </div>
            </section>
            <section className="panel">
              <div className="panel-toolbar">
                <div>
                  <h2>
                    Wallets <span className="count">{wallets.length}</span>
                  </h2>
                  <p className="subtle">Balances provided by the OMS indexer gateway</p>
                </div>
                <button
                  className="secondary"
                  onClick={() => {
                    void load();
                  }}
                  disabled={loading}
                >
                  {loading ? 'Refreshing…' : '↻ Refresh'}
                </button>
              </div>
              <div className="filters">
                <input
                  type="search"
                  aria-label="Search wallets"
                  placeholder="Search name or identifier…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <ErrorBox message={error} />
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Wallet</th>
                      <th>Address</th>
                      <th>Balance (USD)</th>
                      <th>Credential</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallets.map((wallet) => {
                      const result = balances[wallet.id];
                      const state = wallet.snapshot?.disabled
                        ? 'disabled'
                        : wallet.snapshot?.expiresAt &&
                            Date.parse(wallet.snapshot.expiresAt) <= Date.now()
                          ? 'expired'
                          : wallet.snapshot?.wallet
                            ? 'active'
                            : 'pending';
                      return (
                        <tr
                          key={wallet.id}
                          className="wallet-row"
                          onClick={(event) => {
                            if (
                              (event.target as HTMLElement).closest('a, button') ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey
                            )
                              return;
                            navigate(walletPath(wallet.id));
                          }}
                        >
                          <td>
                            <Link className="wallet-link" href={walletPath(wallet.id)}>
                              <span className="wallet-mark">
                                {wallet.name.slice(0, 1).toUpperCase()}
                              </span>
                              <span>
                                {wallet.name}
                                <small>{wallet.identifier}</small>
                              </span>
                            </Link>
                          </td>
                          <td className="mono">{short(wallet.snapshot?.wallet?.address)}</td>
                          <td>
                            <WalletValue balances={wallet.snapshot?.wallet ? result : null} />
                          </td>
                          <td>
                            <Status value={state} />
                          </td>
                          <td className="subtle">
                            {new Date(wallet.createdAt).toLocaleDateString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!loading && wallets.length === 0 && (
                <div className="empty">
                  <div className="empty-icon">◇</div>
                  <h3>{search ? 'No matching wallets' : 'Your first wallet starts here'}</h3>
                  <p>
                    {search
                      ? 'Try a different name or identifier.'
                      : 'Create a wallet with an identifier from your application.'}
                  </p>
                </div>
              )}
              {next !== null && (
                <button
                  className="secondary more"
                  onClick={() => {
                    void load(next);
                  }}
                  disabled={loading}
                >
                  Load more wallets
                </button>
              )}
            </section>
          </>
        )}
        {creating && (
          <CreateWallet
            close={() => setCreating(false)}
            created={(id) => {
              setCreating(false);
              navigate(walletPath(id));
            }}
          />
        )}
        <footer>
          OMS Server Wallets <span>Prototype · WaaS v1.1.0</span>
        </footer>
      </main>
    </div>
  );
}
function CreateWallet({ close, created }: { close: () => void; created: (id: string) => void }) {
  const [identifier, setIdentifier] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const wallet = await api<Wallet>('/wallets', { identifier, name });
      created(wallet.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Create a wallet" close={close}>
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <p className="subtle">
          An existing identifier restores its wallet. Each identity owns one wallet across supported
          EVM networks.
        </p>
        <label>
          Display name
          <input
            autoFocus
            required
            maxLength={120}
            placeholder="Treasury wallet"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Application identifier
          <input
            required
            maxLength={128}
            placeholder="customer-001"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
          <small>This identifier is permanent.</small>
        </label>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating wallet…' : 'Create wallet'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function WalletDetail({ id, config }: { id: string; config: Configuration }) {
  const [wallet, setWallet] = useState<Wallet>();
  const [balances, setBalances] = useState<Balances | null>();
  const [ops, setOps] = useState<Operation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'send' | 'sign' | 'disable' | 'rotate'>();
  const [copied, setCopied] = useState(false);
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      const row = await api<Wallet>(`/wallets/${id}`);
      setWallet(row);
      setOps((await api<{ operations: Operation[] }>(`/wallets/${id}/operations`)).operations);
      if (row.snapshot?.wallet) setBalances(await walletBalances(id));
      else setBalances(null);
    } catch (e) {
      setBalances(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    const pending = ops.filter(
      (op) => op.kind === 'transfer' && ['pending', 'unknown', 'submitting'].includes(op.status),
    );
    if (!pending.length) return;
    const timer = setInterval(() => {
      void Promise.all(
        pending.map(async (op) => {
          try {
            const result = await api<{ operation: Operation | null }>(
              `/wallets/${id}/operations/${op.id}`,
            );
            if (result.operation) {
              setOps((old) => old.map((item) => (item.id === op.id ? result.operation! : item)));
              if (result.operation.status === 'executed' && op.status !== 'executed')
                setBalances(await walletBalances(id));
            }
          } catch (e) {
            setError(errorText(e));
          }
        }),
      );
    }, 4000);
    return () => clearInterval(timer);
  }, [ops, id]);
  async function action(kind: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/wallets/${id}/${kind}`, {});
      setDialog(undefined);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const address = wallet?.snapshot?.wallet?.address;
  return (
    <>
      <Link className="back" href="/">
        ← All wallets
      </Link>
      <section className="page-title">
        <div>
          <p className="eyebrow">{wallet?.identifier ?? 'WALLET'}</p>
          <h1>{wallet?.name ?? (error ? 'Wallet unavailable' : 'Loading wallet…')}</h1>
          <button
            className="address"
            disabled={!address}
            onClick={() => {
              if (address)
                void navigator.clipboard
                  .writeText(address)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })
                  .catch((e) => setError(errorText(e)));
            }}
          >
            {address ?? 'Address pending'} {copied ? '✓ Copied' : '⧉'}
          </button>
        </div>
        <div className="actions">
          <button
            className="secondary"
            disabled={!address || wallet?.snapshot?.disabled || busy}
            onClick={() => setDialog('sign')}
          >
            Sign message
          </button>
          <button
            className="primary"
            disabled={!address || wallet?.snapshot?.disabled || busy}
            onClick={() => setDialog('send')}
          >
            ↗ Send transfer
          </button>
        </div>
      </section>
      <ErrorBox message={error} />
      <section className="portfolio-value" aria-label="Total wallet balance">
        <span>Total balance (USD)</span>
        <WalletValue balances={balances} />
      </section>
      <section className="credential-bar">
        <div>
          <Status value={wallet?.snapshot?.disabled ? 'disabled' : 'managed'} />
          <span>Automatic credential renewal</span>
          <small>
            {wallet?.snapshot?.expiresAt
              ? `Current expiry: ${new Date(wallet.snapshot.expiresAt).toLocaleString()}`
              : 'No active credential'}
          </small>
        </div>
        <div className="actions">
          {!address && (
            <button
              className="secondary"
              onClick={() => {
                void action('restore');
              }}
              disabled={busy}
            >
              Restore wallet
            </button>
          )}
          <button
            className="text-button"
            onClick={() => setDialog('rotate')}
            disabled={busy || !address || wallet?.snapshot?.disabled}
          >
            Rotate credential
          </button>
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              wallet?.snapshot?.disabled ? void action('enable') : setDialog('disable')
            }
          >
            {wallet?.snapshot?.disabled ? 'Enable wallet' : 'Disable wallet'}
          </button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-toolbar">
          <div>
            <h2>Assets</h2>
            <p className="subtle">
              {balances
                ? `Updated ${new Date(balances.fetchedAt).toLocaleTimeString()}`
                : 'Balances are loaded from OMS'}
            </p>
          </div>
          <button
            className="secondary"
            onClick={() => {
              void refresh();
            }}
            disabled={busy}
          >
            {busy ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
        {balances?.errors.map((e, i) => (
          <div className="notice" key={`${e.chainId}-${i}`}>
            {config.chains.find((c) => c.id === e.chainId)?.name}: {e.message}
          </div>
        ))}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Network</th>
                <th>Balance</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {balances?.items.map((item) => (
                <tr key={`${item.chainId}-${item.asset}`}>
                  <td>
                    <strong>{item.symbol}</strong>
                    <small>{item.name}</small>
                  </td>
                  <td>{config.chains.find((c) => c.id === item.chainId)?.name}</td>
                  <td className="mono">{formatAmount(item.balance, item.decimals)}</td>
                  <td>{item.balanceUSD ? formatUsd(item.balanceUSD) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {balances?.items.length === 0 && (
          <div className="empty">
            <h3>No assets returned</h3>
            <p>Fund this wallet to make your first transfer.</p>
          </div>
        )}
        {balances?.nextPage !== undefined && (
          <div className="notice">Some assets could not be loaded. Refresh to retry.</div>
        )}
      </section>
      <section className="panel activity">
        <div className="panel-toolbar">
          <div>
            <h2>Activity</h2>
            <p className="subtle">Transfers and messages initiated in this workspace</p>
          </div>
        </div>
        {!ops.length ? (
          <div className="empty">
            <p>No operations yet.</p>
          </div>
        ) : (
          <div className="operation-list">
            {ops.map((op) => (
              <div className="operation" key={op.id}>
                <span className="operation-icon">{op.kind === 'sign' ? '✎' : '↗'}</span>
                <div>
                  <strong>{op.kind === 'sign' ? 'Message signature' : 'Token transfer'}</strong>
                  <small>
                    {new Date(op.createdAt).toLocaleString()} ·{' '}
                    {config.chains.find((c) => c.id === op.chainId)?.name ?? ''}
                  </small>
                  {op.signature && (
                    <button
                      className="text-button"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(op.signature!)
                          .catch((e) => setError(errorText(e)));
                      }}
                    >
                      Copy verified signature ⧉
                    </button>
                  )}
                  {op.txnHash && (
                    <a
                      href={`${config.chains.find((c) => c.id === op.chainId)?.explorer}/tx/${op.txnHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View transaction ↗
                    </a>
                  )}
                  {op.error && <small>{op.error}</small>}
                </div>
                <Status value={op.status} />
              </div>
            ))}
          </div>
        )}
      </section>
      {dialog === 'send' && wallet && (
        <SendTransfer
          id={id}
          balances={balances?.items ?? []}
          chains={config.chains}
          close={() => setDialog(undefined)}
          completed={() => {
            setDialog(undefined);
            void refresh();
          }}
        />
      )}
      {dialog === 'sign' && (
        <SignMessage
          id={id}
          chains={config.chains}
          close={() => {
            setDialog(undefined);
            void refresh();
          }}
        />
      )}
      {(dialog === 'disable' || dialog === 'rotate') && (
        <Modal
          title={dialog === 'disable' ? 'Disable this wallet?' : 'Rotate wallet credential?'}
          close={() => setDialog(undefined)}
        >
          <p className="subtle">
            {dialog === 'disable'
              ? 'This stops new operations and automatic reauthentication, and attempts to revoke the current credential. Transactions already submitted can still complete.'
              : 'The current credential will be revoked and replaced. Your wallet address stays the same.'}
          </p>
          <ErrorBox message={error} />
          <div className="actions">
            <button className="secondary" onClick={() => setDialog(undefined)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                void action(dialog);
              }}
            >
              {busy ? 'Working…' : 'Confirm'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function SendTransfer({
  id,
  balances,
  chains,
  close,
  completed,
}: {
  id: string;
  balances: Balance[];
  chains: Chain[];
  close: () => void;
  completed: () => void;
}) {
  const [chain, setChain] = useState(137);
  const [asset, setAsset] = useState('native');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [op, setOp] = useState<Operation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = balances.find((b) => b.chainId === chain && b.asset === asset);
  const symbol = selected?.symbol ?? chains.find((c) => c.id === chain)?.symbol;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ operation: Operation }>(`/wallets/${id}/transfers`, {
        id: crypto.randomUUID(),
        chainId: chain,
        asset,
        to,
        amount: toUnits(amount, asset === 'native' ? 18 : selected!.decimals!),
      });
      setOp(result.operation);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    setBusy(true);
    setError('');
    try {
      await api(`/wallets/${id}/operations/${op!.id}/execute`, {});
      completed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={op ? 'Confirm transfer' : 'Send a transfer'} close={close}>
      {op ? (
        <>
          <div className="transfer-summary">
            <p className="eyebrow">YOU ARE SENDING</p>
            <strong>
              {amount} {symbol}
            </strong>
            <span>{chains.find((c) => c.id === chain)?.name}</span>
            <hr />
            <span>To</span>
            <code>{to}</code>
            <p>
              <Status value="sponsored" /> No gas payment from this wallet
            </p>
            <small>
              Quote expires {op.quote && new Date(op.quote.expiresAt).toLocaleTimeString()}
            </small>
          </div>
          <ErrorBox message={error} />
          <div className="actions">
            <button className="secondary" onClick={() => setOp(undefined)} disabled={busy}>
              Back
            </button>
            <button
              className="primary"
              onClick={() => {
                void execute();
              }}
              disabled={busy}
            >
              {busy ? 'Submitting…' : 'Confirm & send'}
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            void submit(e);
          }}
        >
          <div className="form-grid">
            <label>
              Network
              <select
                value={chain}
                onChange={(e) => {
                  setChain(Number(e.target.value));
                  setAsset('native');
                }}
              >
                {chains.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Asset
              <select value={asset} onChange={(e) => setAsset(e.target.value)}>
                <option value="native">
                  {chains.find((c) => c.id === chain)?.symbol} · Native
                </option>
                {balances
                  .filter(
                    (b) => b.chainId === chain && b.asset !== 'native' && b.decimals !== undefined,
                  )
                  .map((b) => (
                    <option key={b.asset} value={b.asset}>
                      {b.symbol} · {short(b.asset)}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label>
            Recipient address
            <input required placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            Amount
            <input
              required
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {selected && (
              <small>
                Available: {formatAmount(selected.balance, selected.decimals)} {symbol}
              </small>
            )}
          </label>
          <div className="notice">
            Gas sponsorship is required. You’ll review the transfer before it is submitted.
          </div>
          <ErrorBox message={error} />
          <div className="actions">
            <button type="button" className="secondary" onClick={close}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              {busy ? 'Preparing…' : 'Review transfer →'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function SignMessage({ id, chains, close }: { id: string; chains: Chain[]; close: () => void }) {
  const [chain, setChain] = useState(137);
  const [message, setMessage] = useState('');
  const [signature, setSignature] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ operation: Operation }>(`/wallets/${id}/sign`, {
        id: crypto.randomUUID(),
        chainId: chain,
        message,
      });
      setSignature(result.operation.signature ?? '');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Sign a message" close={close}>
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <label>
          Network
          <select
            value={chain}
            onChange={(e) => {
              setChain(Number(e.target.value));
              setSignature('');
            }}
          >
            {chains.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Message
          <textarea
            required
            rows={5}
            maxLength={16_384}
            value={message}
            placeholder="Enter the exact message to sign…"
            onChange={(e) => {
              setMessage(e.target.value);
              setSignature('');
            }}
          />
        </label>
        {signature && (
          <div className="signature">
            <Status value="verified" />
            <textarea aria-label="Verified signature" readOnly value={signature} rows={4} />
            <button
              className="secondary"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(signature).catch((e) => setError(errorText(e)));
              }}
            >
              Copy signature ⧉
            </button>
          </div>
        )}
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" className="secondary" onClick={close}>
            Close
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Signing & verifying…' : 'Sign message'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
