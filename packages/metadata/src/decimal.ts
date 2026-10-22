/**
 * Exact decimal handling for Number, Currency and Percent. Values are kept as
 * strings end to end (JSONB holds "1234.50", not a binary double), so an
 * 18-digit currency amount survives a round trip unchanged (DECISIONS.md D-030).
 */

export type Decimal = { negative: boolean; digits: bigint; scale: number };

const DECIMAL_RE = /^([+-])?(\d+)?(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Parses "12.5", "-0.001", "1e3", 42 ... Returns null if it isn't a finite decimal. */
export function parseDecimal(input: string | number): Decimal | null {
  const text =
    typeof input === "number" ? (Number.isFinite(input) ? String(input) : "") : input.trim();
  const m = DECIMAL_RE.exec(text);
  if (!m || (m[2] === undefined && m[3] === undefined)) return null;
  const intPart = m[2] ?? "";
  const fracPart = m[3] ?? "";
  const exp = Number(m[4] ?? 0);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) return null;
  let digits = BigInt(`${intPart}${fracPart}` || "0");
  let scale = fracPart.length - exp;
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { negative: m[1] === "-" && digits !== 0n, digits, scale };
}

/** Rounds half away from zero (Salesforce's rule) to `scale` decimal places. */
export function roundTo(d: Decimal, scale: number): Decimal {
  if (d.scale <= scale) {
    return { ...d, digits: d.digits * 10n ** BigInt(scale - d.scale), scale };
  }
  const drop = 10n ** BigInt(d.scale - scale);
  let q = d.digits / drop;
  if ((d.digits % drop) * 2n >= drop) q += 1n;
  return { negative: d.negative && q !== 0n, digits: q, scale };
}

/** Number of digits before the decimal point (0 for 0.5). */
export function integerDigits(d: Decimal): number {
  const whole = d.digits / 10n ** BigInt(d.scale);
  return whole === 0n ? 0 : whole.toString().length;
}

/** Fixed notation with exactly d.scale decimals: "-12.50". */
export function formatDecimal(d: Decimal): string {
  let s = d.digits.toString().padStart(d.scale + 1, "0");
  if (d.scale > 0) s = `${s.slice(0, -d.scale)}.${s.slice(-d.scale)}`;
  return d.negative ? `-${s}` : s;
}

/** Canonical form for equality: no trailing zeros, no "-0" ("1.50" -> "1.5"). */
export function canonicalDecimal(d: Decimal): string {
  let { digits, scale } = d;
  while (scale > 0 && digits % 10n === 0n) {
    digits /= 10n;
    scale -= 1;
  }
  return formatDecimal({ negative: d.negative && digits !== 0n, digits, scale });
}
