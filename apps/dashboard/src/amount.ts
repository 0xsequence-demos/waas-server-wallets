export function formatAmount(raw: string, decimals?: number): string {
  if (decimals === undefined) return `${raw} base units`;
  const digits = raw.padStart(decimals + 1, '0');
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
export function toUnits(value: string, decimals: number): string {
  if (
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    throw new Error('Enter a valid positive amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    throw new Error(`This token supports at most ${decimals} decimal places.`);
  const units = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (units <= 0n || units >= 2n ** 256n) throw new Error('Amount is outside the supported range.');
  return units.toString();
}
