import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

/** Hash both sides so timingSafeEqual always gets equal-length buffers. */
function matches(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function bearerAuth(token: string) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;

    if (!provided || !matches(provided, token)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}

/** The page's cookie. Named, not guessed at, so the parser below stays exact. */
const COOKIE_NAME = "jarvis_token";

/** Thirty days: long enough that the token is typed once, short enough to lapse. */
const COOKIE_MAX_AGE = 30 * 24 * 3_600;

/**
 * Reads one cookie out of a raw `Cookie` header.
 *
 * Hand-rolled because this project takes no new runtime dependency for six
 * lines, and because the only cookie that matters here is one we set ourselves.
 */
function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Guards `GET /`, which carries the brief, every analysis, the numbers and the
 * whole web thread — more, in one response, than any `/api/` route hands out.
 *
 * A browser cannot send an Authorization header on a plain navigation, so the
 * first visit brings the token in the query string. That is accepted exactly
 * once and immediately traded for an HttpOnly, SameSite=Strict cookie: later
 * navigations carry no token in the URL, where it would otherwise land in the
 * browser history and (before this) the request log.
 *
 * No `Secure` flag: the server also answers plain http on 127.0.0.1, and a
 * Secure cookie would simply never come back there.
 */
export function pageAuth(token: string) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (bearer && matches(bearer, token)) return;

    const cookie = cookieValue(request.headers.cookie, COOKIE_NAME);
    if (cookie && matches(cookie, token)) return;

    const query = new URL(request.url, "http://localhost").searchParams.get("token");
    if (query && matches(query, token)) {
      reply.header(
        "set-cookie",
        `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
      );
      return;
    }

    await reply.code(401).send({ error: "unauthorized" });
  };
}
