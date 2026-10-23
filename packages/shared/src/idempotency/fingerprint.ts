import { createHash } from 'node:crypto';

/** Stable JSON: object keys sorted recursively so equivalent bodies hash identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, canonicalize(inner)]),
    );
  }
  return value;
}

/** SHA-256 of the canonical request body; detects an idempotency key reused with different parameters. */
export function requestFingerprint(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(body)))
    .digest('hex');
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY_RE.test(value);
}
