/**
 * Runs `fn` with a signal that combines the caller's `signal` and a hard
 * deadline of `timeoutMs`, and guarantees the timer and listener are cleaned
 * up on every path.
 *
 * The `signal.aborted` check has to happen before `fn` is ever called: an
 * `abort` event that already fired won't fire again for a listener attached
 * afterward, so an already-aborted caller signal would otherwise be missed
 * entirely and the request would run to completion — or until `timeoutMs`
 * elapses — instead of failing immediately. Two call sites (the Groq
 * synthesizer and Groq chat) had this same gap independently; centralizing
 * it here means there's only one place left to get it right.
 */
export async function withTimeout<T>(
  signal: AbortSignal,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new Error("aborted before the request started");

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
