export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  /** Total delivery attempts, including the first one, before a delivery is marked dead. */
  maxAttempts: number;
}

/**
 * Exponential backoff with ±20% jitter: base, 2×base, 4×base … capped at maxMs.
 * `attempt` is the number of the attempt that just failed (1-based).
 */
export function nextRetryDelayMs(
  policy: BackoffPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(policy.maxMs, exponential);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(capped * jitter);
}

export type FailureDecision = { action: 'retry'; delayMs: number } | { action: 'dead' };

export function decideAfterFailure(
  policy: BackoffPolicy,
  attempt: number,
  random?: () => number,
): FailureDecision {
  if (attempt >= policy.maxAttempts) return { action: 'dead' };
  return { action: 'retry', delayMs: nextRetryDelayMs(policy, attempt, random) };
}
