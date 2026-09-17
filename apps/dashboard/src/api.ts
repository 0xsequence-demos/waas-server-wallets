export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/login')
      window.dispatchEvent(new Event('session-expired'));
    throw new Error(
      result &&
        typeof result === 'object' &&
        'message' in result &&
        typeof result.message === 'string'
        ? result.message
        : 'Request failed.',
    );
  }
  return result as T;
}
