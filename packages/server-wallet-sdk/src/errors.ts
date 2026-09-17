export class WalletError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}
export class UpstreamError extends WalletError {
  constructor(
    public readonly upstreamCode: number,
    public readonly method: string,
  ) {
    super('UPSTREAM_ERROR', `WaaS ${method} failed (code ${upstreamCode}).`, 502);
  }
}
