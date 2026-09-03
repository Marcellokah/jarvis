import type { FastifyInstance, FastifyReply } from "fastify";
import { ProposalError, type ProposalService } from "../../../core/proposals.ts";
import type { Clock } from "../../../infra/clock.ts";
import type { Logger } from "../../../infra/logger.ts";

/**
 * The page's own way in to the four writes the system already knows how to do.
 *
 * `/api/actions/*` and `/api/calendar/writes/*` already expose the same
 * service as JSON, and they stay: Telegram and the Shortcut speak to those.
 * These four are for a browser with no JavaScript, which means an HTML form —
 * and a form gets POST/Redirect/GET, because without the redirect a refresh
 * re-submits the POST and writes a second calendar event.
 *
 * No CSRF token: the page's cookie is `SameSite=Strict` (see `auth.ts`), so a
 * cross-site POST never carries it, and these routes accept nothing else.
 */
export function registerWriteRoutes(
  app: FastifyInstance,
  deps: { proposals: ProposalService; clock: Clock; logger: Logger },
): void {
  /**
   * Back to the page, carrying the error code when there is one.
   *
   * `303 See Other` rather than 302: it is the status that means "the result
   * of your POST is at this other address, fetch it with GET", which is
   * exactly the promise being made.
   *
   * `already_resolved` deliberately redirects clean. It is what a double tap
   * or a back-then-resubmit produces, and the state the reader wanted already
   * holds — an alarm that fires whenever nothing is wrong is the same kind of
   * indicator this project refuses everywhere else.
   */
  const back = (reply: FastifyReply, err?: unknown): FastifyReply => {
    if (err === undefined) return reply.code(303).header("location", "/").send();
    if (!(err instanceof ProposalError)) throw err;
    if (err.code === "already_resolved") {
      return reply.code(303).header("location", "/").send();
    }
    deps.logger.warn({ code: err.code, err: String(err) }, "write from the page failed");
    return reply.code(303)
      .header("location", `/?hiba=${encodeURIComponent(err.code)}`).send();
  };

  const run = async (reply: FastifyReply, work: () => Promise<unknown>) => {
    try {
      await work();
      return back(reply);
    } catch (err) {
      return back(reply, err);
    }
  };

  app.post<{ Params: { id: string } }>("/teendo/:id/kesz", (request, reply) =>
    run(reply, () => deps.proposals.complete(request.params.id, deps.clock.now())));

  app.post<{ Params: { id: string } }>("/teendo/:id/elfogad", (request, reply) =>
    run(reply, () => deps.proposals.accept(request.params.id, deps.clock.now())));

  app.post<{ Params: { id: string } }>("/teendo/:id/elutasit", (request, reply) =>
    run(reply, () => deps.proposals.decline(request.params.id, deps.clock.now())));

  app.post<{ Params: { uid: string } }>("/naptar/:uid/visszavon", (request, reply) =>
    run(reply, () => deps.proposals.undo(request.params.uid, deps.clock.now())));
}
