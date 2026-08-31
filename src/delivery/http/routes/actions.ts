import type { FastifyInstance } from "fastify";
import type { ProposalService } from "../../../core/proposals.ts";
import { ProposalError } from "../../../core/proposals.ts";
import type { Clock } from "../../../infra/clock.ts";

const STATUS: Record<ProposalError["code"], number> = {
  not_found: 404,
  wrong_kind: 400,
  already_resolved: 409,
  calendar_failed: 502,
};

export function registerActionRoutes(
  app: FastifyInstance,
  deps: { proposals: ProposalService; clock: Clock },
): void {
  app.post<{ Params: { id: string } }>("/api/actions/:id/accept", async (request, reply) => {
    try {
      const result = await deps.proposals.accept(request.params.id, deps.clock.now());
      return reply.send({ ok: true, eventUid: result.eventUid, calendar: result.calendar });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/actions/:id/done", async (request, reply) => {
    try {
      const action = await deps.proposals.complete(request.params.id, deps.clock.now());
      return reply.send({ ok: true, status: action.status });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/actions/:id/decline", async (request, reply) => {
    try {
      const action = await deps.proposals.decline(request.params.id, deps.clock.now());
      return reply.send({ ok: true, status: action.status });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/calendar/writes", async () => ({ writes: deps.proposals.listUndoable(20) }));

  app.post<{ Params: { uid: string } }>("/api/calendar/writes/:uid/undo", async (request, reply) => {
    try {
      await deps.proposals.undo(request.params.uid, deps.clock.now());
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

/** Structural, so it accepts a FastifyReply from any route's generics. */
interface Replyish {
  code(status: number): { send(body: unknown): unknown };
}

function sendError(reply: Replyish, err: unknown): unknown {
  if (err instanceof ProposalError) {
    return reply.code(STATUS[err.code]).send({ error: err.code, message: err.message });
  }
  throw err;
}
