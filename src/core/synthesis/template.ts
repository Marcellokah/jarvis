import type { Synthesizer, BriefContext } from "./synthesizer.ts";
import type { ModuleOutcome } from "../module.ts";

/**
 * The guarantee.
 *
 * Pure TypeScript: no network, no subprocess, no credentials, sub-millisecond.
 * It is what makes the 07:30 notification unconditional when the CLI is
 * missing, mid-upgrade, timing out, or the network is down — and it is what
 * the whole test suite runs against, which keeps the module contract honest.
 */
export function templateSynthesizer(): Synthesizer {
  return {
    name: "template",
    async available() {
      return true;
    },
    async synthesize(ctx: BriefContext) {
      return render(ctx);
    },
  };
}

function render(ctx: BriefContext): string {
  const lines: string[] = [`# ${ctx.dateLabel}`, ""];

  const visible = ctx.outcomes.filter((o) => o.status !== "empty");
  if (visible.length === 0) {
    lines.push("Ma nincs jelenteni való. Minden modul csendben van.", "");
    return lines.join("\n");
  }

  for (const outcome of visible) {
    lines.push(`## ${outcome.title}`, "");
    if (outcome.plain) lines.push(outcome.plain, "");
    if (outcome.result?.degraded) {
      lines.push(`> ⚠️ Részleges adat: ${outcome.result.degraded}`, "");
    }
    const actions = renderActions(outcome);
    if (actions.length > 0) lines.push(...actions, "");
  }

  const failed = ctx.outcomes.filter((o) => o.status === "failed");
  if (failed.length > 0) {
    lines.push("---", "", `_Nem futott le: ${failed.map((f) => f.name).join(", ")}._`, "");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderActions(outcome: ModuleOutcome): string[] {
  return outcome.actions.map((action) => {
    if (action.kind === "proposal") {
      const when = formatWindow(action.proposal.start, action.proposal.end);
      const where = action.proposal.location ? ` · ${action.proposal.location}` : "";
      return `- [ ] ${action.text} — _${when}${where}_`;
    }
    return `- [ ] ${action.text}`;
  });
}

/** '09:00–11:30' when same day, otherwise the full ISO dates. */
function formatWindow(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startIso} – ${endIso}`;
  }
  const hhmm = (d: Date) =>
    new Intl.DateTimeFormat("hu-HU", {
      timeZone: "Europe/Budapest", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
  const day = (d: Date) =>
    new Intl.DateTimeFormat("hu-HU", {
      timeZone: "Europe/Budapest", month: "short", day: "numeric",
    }).format(d);

  return day(start) === day(end)
    ? `${day(start)} ${hhmm(start)}–${hhmm(end)}`
    : `${day(start)} ${hhmm(start)} – ${day(end)} ${hhmm(end)}`;
}
