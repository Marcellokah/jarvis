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
