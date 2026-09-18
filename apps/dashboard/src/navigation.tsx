import { useSyncExternalStore, type AnchorHTMLAttributes } from 'react';

const navigationEvent = 'dashboard:navigate';
function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  window.addEventListener(navigationEvent, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(navigationEvent, listener);
  };
}
export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}
export function navigate(href: string) {
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (current === href) return;
  window.history.pushState(null, '', href);
  window.dispatchEvent(new Event(navigationEvent));
  window.scrollTo(0, 0);
}
export function walletPath(id: string): string {
  return `/wallets/${encodeURIComponent(id)}`;
}
export function swapPath(id: string, swapId?: string): string {
  return `${walletPath(id)}/${swapId ? `swaps/${encodeURIComponent(swapId)}` : 'swap'}`;
}
export type Route =
  | { kind: 'list' }
  | { kind: 'wallet'; id: string }
  | { kind: 'swap'; id: string; swapId?: string }
  | { kind: 'not-found' };
export function readRoute(pathname: string): Route {
  if (pathname === '/') return { kind: 'list' };
  const swap = /^\/wallets\/([A-Za-z0-9_-]{1,100})\/(swap|swaps\/([A-Za-z0-9_-]{8,100}))\/?$/.exec(
    pathname,
  );
  if (swap) return { kind: 'swap', id: swap[1], swapId: swap[3] };
  const match = /^\/wallets\/([A-Za-z0-9_-]{1,100})\/?$/.exec(pathname);
  return match ? { kind: 'wallet', id: match[1] } : { kind: 'not-found' };
}

/** Real links retain new-tab, copy-link and keyboard behavior; normal clicks stay in the SPA. */
export function Link({
  href,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          (props.target && props.target !== '_self') ||
          props.download !== undefined
        )
          return;
        if (new URL(href, window.location.href).origin !== window.location.origin) return;
        event.preventDefault();
        navigate(href);
      }}
    />
  );
}
