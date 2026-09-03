import type { Metrics } from "./aggregate.ts";
import type { Relation } from "./relations.ts";
import type { Domain } from "../../infra/db/repositories/analyses.ts";

/** The heading each domain answer must end with. The memory depends on it. */
export const SUMMARY_HEADING = "## Rövid összegzés";

const TITLE: Record<Domain, string> = {
  physical: "Fizikai fejlődés",
  recovery: "Regenerálódás és alvás",
  finance: "Pénzügy",
  nutrition: "Táplálkozás",
  synthesis: "Összegzés",
};

const BRIEF: Record<Exclude<Domain, "synthesis">, string> = {
  physical:
    "Edzésterhelés és keringési fittség. A `loadRatio` a 28 napos napi átlagos "
    + "edzésperc a 365 naposhoz mérve: 1 körül állandó terhelés.",
  recovery:
    "HRV, alvás és ébredések. Az alvásadat ritka, és a ritkasága maga is "
    + "megállapítás.",
  finance:
    "Előfizetések havi képe. A tábla az S2-ben született, előtte nincs "
    + "történet, és visszamenőleg szándékosan nem gyártunk.",
  nutrition:
    "Energiaegyensúly, fehérjefedezet és a mérés következetessége. A "
    + "`balance` csak azokból a napokból számol, ahol a bevitel ÉS az "
    + "alapanyagcsere ÉS az aktív kalória is megvan; a `dropped` azt mondja, "
    + "hány mért nap maradt ki emiatt. A `plannedProteinG` a heti étrend "
    + "napi fehérjéje — ehhez mérd a mértet, mert TESTSÚLY-ADAT NINCS a "
    + "rendszerben, tehát testtömeg-kilogrammra vetített állítást ne írj.",
};

/**
 * The shared rules. Coverage is not decoration here: a 90-day sleep mean drawn
 * from twelve nights is a different claim from one drawn from ninety, and the
 * difference has to reach the reader.
 *
 * The closed-list rule belongs here rather than only on the synthesis call.
 * The domain passes are where the raw material actually is — the physical
 * prompt alone carries months of training load next to VO2max and resting
 * heart rate trends — so that is where the temptation to link two series by
 * eye lives. The synthesis pass gets the rule too, plus the extra wording
 * that its list arrives pre-computed.
 */
function systemFor(domain: Domain, extra: string): string {
  return [
    `Egy személyes asszisztens elemzője vagy. A területed: ${TITLE[domain]}.`,
    "",
    "Szabályok:",
    "- Kizárólag a megadott számokra támaszkodj. Ne találj ki adatot, és ne becsülj.",
    "- Minden állítás mellé tedd oda, hány napból származik (`n`) és mekkora a"
    + " lefedettség. Egy 90 napos átlag tizenkét mérésből más állítás, mint"
    + " kilencvenből.",
    "- A `null` azt jelenti, hogy nincs mérés. Nem nulla, és nem baj — mondd ki,"
    + " hogy erről nem tudsz nyilatkozni.",
    "- Ne találj ki összefüggést. Két számsor kapcsolatáról csak akkor írhatsz,"
    + " ha az kiszámolva, mintaszámmal együtt meg van adva — magadtól ne kapcsolj"
    + " össze két idősort, és a korreláció akkor sem ok-okozat.",
    "- Írj magyarul, tömören, felsorolásokkal. Ne írj bevezetőt és lezárást.",
    extra,
    "",
    `A válaszod UTOLSÓ blokkja pontosan ez a cím legyen: "${SUMMARY_HEADING}",`,
    "alatta EGYETLEN bekezdés, ami a lényeget összefoglalja. Ezt az egy",
    "bekezdést fogja a következő elemzés visszakapni emlékezetként.",
  ].join("\n");
}

export function buildDomainPrompt(
  domain: Exclude<Domain, "synthesis">,
  metrics: Metrics,
  memories: readonly string[],
): { system: string; user: string } {
  // Each pass gets only its own slice. A narrower prompt is both a cheaper one
  // and a harder one to wander out of.
  const slice = metrics[domain];

  const memoryBlock = memories.length === 0
    ? "Ez az első elemzés ezen a területen — nincs mihez viszonyítanod."
    : [
      "A korábbi megállapításaid, a legfrissebbel kezdve:",
      ...memories.map((m, i) => `${i + 1}. ${m}`),
      "",
      "Ha egy korábbi aggodalom azóta megszűnt, mondd ki. Ha harmadszor tér",
      "vissza ugyanaz, azt is.",
    ].join("\n");

  return {
    system: systemFor(domain, `- ${BRIEF[domain]}`),
    user: [
      `Dátum: ${metrics.today}`,
      "",
      memoryBlock,
      "",
      "A terület statisztikái:",
      JSON.stringify(slice, null, 2),
    ].join("\n"),
  };
}

export function buildSynthesisPrompt(
  summaries: readonly { domain: Domain; summary: string }[],
  relations: readonly Relation[],
): { system: string; user: string } {
  const system = systemFor(
    "synthesis",
    "- Csak a megadott összefüggésekről írhatsz. A korrelációk kiszámolva"
    + " érkeznek, mintaszámmal együtt: ez a lista zárt, továbbiakat nem"
    + " kereshetsz, és a mintaszámot mindegyik mellé ki kell írnod.",
  );

  const relationBlock = relations.length === 0
    ? "Egyetlen összefüggés sem érte el a mintaszám-küszöböt, tehát erről a"
      + " futásról nem mondhatsz kapcsolatról semmit."
    : [
      "A kiszámolt összefüggések:",
      ...relations.map((r) =>
        `- ${r.label}: r = ${r.r.toFixed(2)}, n = ${r.n}, ablak: ${r.window}`),
    ].join("\n");

  return {
    system,
    user: [
      "A területi elemzések összegzései:",
      ...summaries.map((s) => `### ${TITLE[s.domain]}\n${s.summary}`),
      "",
      relationBlock,
    ].join("\n"),
  };
}

/**
 * Pulls the summary block out of a domain answer.
 *
 * Falls back to the first paragraph when the model skipped the heading. Losing
 * the memory of one run is a small harm; throwing away a finished analysis
 * because its last heading was missing would be a much larger one.
 */
export function extractSummary(markdown: string): string {
  const text = markdown.trim();
  const start = text.indexOf(SUMMARY_HEADING);
  if (start !== -1) {
    const after = text.slice(start + SUMMARY_HEADING.length);
    const end = after.search(/\n#{1,6} /);
    const block = (end === -1 ? after : after.slice(0, end)).trim();
    if (block) return block;
  }
  const paragraph = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0 && !p.startsWith("#"));
  return paragraph ?? text;
}
