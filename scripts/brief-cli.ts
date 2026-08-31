/**
 * Prints the brief to stdout without going through HTTP.
 *
 *   npm run brief
 *   npm run brief -- --format=md
 *   npm run brief -- --synthesizer=template
 *   npm run brief -- --at=2026-08-31T06:20:00+02:00
 */
import { createApp } from "../src/app.ts";
import { toPlainText } from "../src/core/renderer.ts";
import { fakeClock, systemClock } from "../src/infra/clock.ts";

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}

const format = flag("format") ?? "text";
const at = flag("at");
const synthesizer = flag("synthesizer");

if (synthesizer) process.env.SYNTHESIS_CHAIN = synthesizer;
// The CLI's own logs would interleave with the brief itself on stdout.
process.env.LOG_LEVEL ??= "warn";

const app = createApp({ clock: at ? fakeClock(at) : systemClock });

try {
  const brief = await app.briefs.get(app.clock.now(), { force: true });

  if (format === "json") {
    console.log(JSON.stringify(brief, null, 2));
  } else {
    console.log(format === "md" ? brief.markdown : toPlainText(brief.markdown));
    console.error(
      `\n— ${brief.synthesizer} · ${brief.durationMs} ms · ${brief.actions.length} teendő`,
    );
  }
} finally {
  app.close();
}
