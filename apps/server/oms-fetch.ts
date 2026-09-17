/** Use the application's configured origin for server-to-OMS gateway requests. */
export function omsFetch(origin: string, fetcher: typeof fetch = fetch): typeof fetch {
  const requestOrigin = new URL(origin).origin;
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set('Origin', requestOrigin);
    return fetcher(input, { ...init, headers });
  };
}
