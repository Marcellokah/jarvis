/**
 * Miért ad a nyers minták összege többet, mint amit a Health mutat?
 *
 *   npm run diagnose-overlap -- ~/Downloads/export.zip [nap]
 *
 * A telefon 2026-09-01-én 12 727 lépést összegzett egyetlen forrásra szűrve,
 * a Health ugyanarra a napra 6 645-öt mutatott. A duplikált eszköz mint
 * magyarázat kiesett (a két azonos nevű óra-bejegyzés között nincs időbeli
 * átfedés), és ez a script azt méri meg, ami marad: átfednek-e egymással
 * EGY forráson belül a rekordok, és van-e köztük betű szerinti duplikátum.
 *
 * Ez nem csak a Shortcutot érinti. A rollup forrásonként összeadja a
 * halmozódó típusokat, tehát ha itt átfedés van, a beimportált előzmény
 * ugyanígy felfújt — ezért néz a script a `device` attribútumra is, amit a
 * reader ma nem olvas ki: két azonos nevű eszköz egyetlen kulcsba esik össze.
 *
 * Csak olvas. Nem ír adatbázisba és nem módosít semmit.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const path = process.argv[2];
const days = Number(process.argv[3] ?? 7);
if (!path) {
  console.error("Használat: npm run diagnose-overlap -- <export.zip vagy export.xml> [nap]");
  process.exit(1);
}

/** A halmozódó típusok, ahol az összeadás egyáltalán értelmes kérdés. */
const TYPES = new Set([
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierDistanceWalkingRunning",
  "HKQuantityTypeIdentifierActiveEnergyBurned",
  "HKQuantityTypeIdentifierFlightsClimbed",
]);

interface Rec { start: number; end: number; value: number; raw: string }
/** típus -> nap -> forráskulcs -> rekordok */
const buckets = new Map<string, Map<string, Map<string, Rec[]>>>();
const devicesBySource = new Map<string, Set<string>>();

const ATTR = /(\w+)="([^"]*)"/g;
const attrs = (line: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(ATTR)) out[m[1]!] = m[2]!;
  return out;
};

/** '2026-09-01 23:10:00 +0200' -> ms. A nap az első tíz karakter, átváltás nélkül. */
const parse = (s: string) => Date.parse(`${s.slice(0, 10)}T${s.slice(11, 19)}${s.slice(20, 23)}:${s.slice(23, 25)}`);

/**
 * A HKDevice sztringből a hardver, ami két azonos nevű eszközt megkülönböztet.
 *
 * A mezőket vessző+szóköz választja el, a modellnévben viszont maga is van
 * vessző (`Watch6,1`) — sima vesszőre vágva `Watch6` lenne belőle, és két
 * generáció egy kulcsba esne össze, épp az ellenkezője annak, amit mérni akar.
 */
const hardware = (device: string | undefined): string => {
  const m = /hardware:(.+?)(?:,\s|>|$)/.exec(device ?? "");
  return m ? m[1]!.trim() : "—";
};

const nest = <K, V>(m: Map<K, V>, k: K, make: () => V): V => {
  let v = m.get(k);
  if (v === undefined) { v = make(); m.set(k, v); }
  return v;
};

const stream = path.endsWith(".zip")
  ? spawn("unzip", ["-p", path, "apple_health_export/export.xml"]).stdout!
  : createReadStream(path);

let cutoff = "";
for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
  const t = line.trimStart();
  if (!t.startsWith("<Record ")) continue;
  const a = attrs(t);
  if (!a.type || !TYPES.has(a.type) || !a.startDate) continue;

  const day = a.startDate.slice(0, 10);
  if (day > cutoff) cutoff = day;

  const type = a.type.replace("HKQuantityTypeIdentifier", "");
  const source = `${a.sourceName ?? ""} [${hardware(a.device)}]`;
  nest(devicesBySource, a.sourceName ?? "", () => new Set<string>()).add(hardware(a.device));
  nest(nest(nest(buckets, type, () => new Map()), day, () => new Map()), source, () => [] as Rec[])
    .push({
      start: parse(a.startDate), end: parse(a.endDate ?? a.startDate),
      value: Number((a.value ?? "0").replace(",", ".")),
      raw: `${a.startDate}|${a.endDate}|${a.value}`,
    });
}

// Az utolsó `days` nap: az export végét nézzük, mert a kérdés a mai adatról szól.
const lastDays = (d: string) => {
  const ms = Date.parse(cutoff) - Date.parse(d);
  return ms >= 0 && ms < days * 86_400_000;
};

console.log(`\nExport utolsó napja: ${cutoff}\n`);

console.log("Források és a mögöttük álló eszközök:");
for (const [name, hw] of [...devicesBySource].sort()) {
  const mark = hw.size > 1 ? "  ← EGY NÉV, TÖBB ESZKÖZ" : "";
  console.log(`  ${name}: ${[...hw].sort().join(", ")}${mark}`);
}

for (const [type, byDay] of [...buckets].sort()) {
  console.log(`\n── ${type} ──`);
  for (const [day, bySource] of [...byDay].filter(([d]) => lastDays(d)).sort()) {
    console.log(`  ${day}`);
    for (const [source, recs] of [...bySource].sort()) {
      recs.sort((x, y) => x.start - y.start || x.end - y.end);

      // Átfedés: hány rekord kezdődik azelőtt, hogy az előző véget ért volna.
      // Egy forráson belül ez az, ami az összeadást értelmetlenné teszi.
      let overlaps = 0, overlapValue = 0, maxEnd = -Infinity;
      for (const r of recs) {
        if (r.start < maxEnd) { overlaps += 1; overlapValue += r.value; }
        maxEnd = Math.max(maxEnd, r.end);
      }

      // Betű szerinti duplikátum: ugyanaz a kezdet, vég és érték kétszer.
      const seen = new Set<string>();
      let dupes = 0, dupeValue = 0;
      for (const r of recs) {
        if (seen.has(r.raw)) { dupes += 1; dupeValue += r.value; } else seen.add(r.raw);
      }

      const sum = recs.reduce((s, r) => s + r.value, 0);
      const f = (n: number) => n.toLocaleString("hu-HU", { maximumFractionDigits: 2 });
      console.log(
        `    ${source.padEnd(38)} n=${String(recs.length).padStart(4)}  Σ=${f(sum).padStart(10)}`
        + `  átfedő=${String(overlaps).padStart(4)} (${f(overlapValue)})`
        + `  duplikátum=${String(dupes).padStart(4)} (${f(dupeValue)})`
        + `  Σ−duplikátum=${f(sum - dupeValue)}`,
      );
    }
  }
}
console.log("");
