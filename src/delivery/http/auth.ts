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
    if (!bearerProves(request, token)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}

/** True when the request carries the token in an `Authorization: Bearer` header. */
function bearerProves(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  return Boolean(provided && matches(provided, token));
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
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed percent-escape (`jarvis_token=%zz`) makes this throw, and
      // the cookie is checked before the query-token branch — so one bad
      // cookie turned every guarded route into a 500, the documented
      // `/?token=…` recovery included, and locked the owner out until they
      // cleared cookies by hand. A cookie that cannot even be decoded is not
      // a credential: it proves nothing, and must leave the other proofs
      // their turn rather than taking the whole server with it.
      return null;
    }
  }
  return null;
}

/** True when the request carries the token in the page's own cookie. */
function cookieProves(request: FastifyRequest, token: string): boolean {
  const cookie = cookieValue(request.headers.cookie, COOKIE_NAME);
  return Boolean(cookie && matches(cookie, token));
}

/**
 * Guards `POST /api/chat`: the bearer header, or the page's own cookie.
 *
 * The cookie is how the page itself asks, and now the only way it does. The
 * page used to send a bearer header built from a `sessionStorage` copy of
 * `?token=`, but sessionStorage dies with the browser session — a returning
 * visitor got a 200 page from the 30-day cookie and a 401 on every question,
 * with no recovery but re-pasting the token into the URL. With the cookie
 * accepted here, that copy had no job left, so the page keeps no token at all
 * (see `view/ask.ts`) and there is nothing on the page for script to read.
 *
 * No CSRF surface added: the cookie is `SameSite=Strict`, so a cross-site
 * page cannot make the browser attach it, and `HttpOnly`, so script on such a
 * page cannot read it either. The bearer header stays for the callers that do
 * have a token to send — the Shortcut, `curl`, the smoke test.
 */
export function chatAuth(token: string) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (bearerProves(request, token) || cookieProves(request, token)) return;
    await reply.code(401).send({ error: "unauthorized" });
  };
}

/**
 * Guards `GET /`, which carries the brief, every analysis, the numbers and the
 * whole web thread — more, in one response, than any `/api/` route hands out.
 *
 * A browser cannot send an Authorization header on a plain navigation, so the
 * first visit brings the token in the query string. That is accepted exactly
 * once and immediately traded for an HttpOnly, SameSite=Strict cookie: later
 * navigations carry no token in the URL, where it would otherwise land in the
 * browser history and (before this) the request log. The one URL that does
 * carry it is scrubbed out of the address bar by the shell's own script
 * (`SCRUB_SCRIPT` in `view/shell.ts`), which every page ships — that is the
 * half of the promise the server cannot keep on its own.
 *
 * No `Secure` flag: the server also answers plain http on 127.0.0.1, and a
 * Secure cookie would simply never come back there.
 */
export function pageAuth(token: string) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (bearerProves(request, token) || cookieProves(request, token)) return;

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
