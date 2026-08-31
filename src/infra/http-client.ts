import type { Logger } from "./logger.ts";

/**
 * Narrow fetch surface. Modules depend on this rather than global fetch so the
 * test suite can supply recorded fixtures and never touch the network.
 */
export interface Fetcher {
  json<T>(url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<T>;
  text(url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<string>;
}

export interface FetcherOptions {
  logger: Logger;
  retries?: number;
  userAgent?: string;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export function createFetcher(opts: FetcherOptions): Fetcher {
  const retries = opts.retries ?? 2;
  const userAgent = opts.userAgent ?? "jarvis/0.1 (personal assistant)";

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter, so a flaky feed doesn't stampede.
        const delay = 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        const res = await fetch(url, {
          ...init,
          headers: { "user-agent": userAgent, ...(init.headers ?? {}) },
        });
        if (res.ok) return res;
        if (!RETRYABLE.has(res.status) || attempt === retries) {
          throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        }
        lastError = new Error(`HTTP ${res.status} for ${url}`);
        opts.logger.warn({ url, status: res.status, attempt }, "retrying request");
      } catch (err) {
        // An aborted request is a deliberate timeout — never retry it.
        if (err instanceof Error && err.name === "AbortError") throw err;
        lastError = err;
        if (attempt === retries) throw err;
        opts.logger.warn({ url, attempt, err: String(err) }, "retrying request");
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      const res = await request(url, init);
      return (await res.json()) as T;
    },
    async text(url: string, init?: RequestInit): Promise<string> {
      const res = await request(url, init);
      return await res.text();
    },
  };
}

/** For tests: serves recorded fixtures, and throws on any unmapped URL. */
export function fixtureFetcher(routes: Record<string, unknown>): Fetcher {
  function lookup(url: string): unknown {
    if (url in routes) return routes[url];
    const match = Object.keys(routes).find((k) => url.startsWith(k));
    if (match) return routes[match];
    throw new Error(`No fixture for ${url} — tests must not hit the network`);
  }
  return {
    async json<T>(url: string) { return lookup(url) as T; },
    async text(url: string) { const v = lookup(url); return typeof v === "string" ? v : JSON.stringify(v); },
  };
}
