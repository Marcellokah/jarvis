# F1 platform-váz — implementációs terv

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mai egyoldalas felület helyére négy szerver-renderelt oldal kerül közös kerettel, navigációval, állapotsávval és egy cyberpunk designrendszerrel — kizárólag ma is létező tartalomból.

**Architecture:** A `src/delivery/http/page.ts` szétbomlik a `view/` alá: `channels.ts` (tiszta logika), `theme.ts` (tokenek + CSS), `shell.ts` (`layout()`), és oldalanként egy renderelő. A `routes/page.ts` négy `GET`-et regisztrál a meglévő `pageAuth` mögött. Új adatlekérdezés nincs; a `PageDeps` egyetlen mezővel bővül (`health`).

**Tech Stack:** Node ≥ 24 (`.ts` közvetlenül), Fastify 5, vitest, `node:sqlite`. Nincs kliensoldali keretrendszer, nincs build lépés.

**Spec:** `docs/superpowers/specs/2026-09-02-f1-platform-shell-design.md`

## Global Constraints

- Node ≥ 24, nincs build lépés, minden relatív import `.ts` kiterjesztéssel.
- **Nincs új futásidejű függőség.**
- `npm run typecheck` tiszta, `npm test` teljesen zöld minden feladat végén.
- Felhasználónak szóló szöveg **magyarul**, kódkommentek **angolul**, és a WHY-t magyarázzák.
- A tesztek hálózat nélkül futnak, nem írnak a `./data/jarvis.db`-be, nem nyúlnak a launchd ügynökhöz, nem indítanak szervert a 8787-es porton.
- Színek: `--jel` **kizárólag** mért adat, `--vaz` **soha** nem adat, `--riado` **kizárólag** elmaradt csatorna.
- Ami nincs mérve, az nem animálódik.
- Minden commit utolsó sora: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Fájlszerkezet

| Fájl | Felelőssége |
|---|---|
| `src/delivery/http/view/channels.ts` | `NAPI_MAG`, és a mai sorból + az órából csatornánkénti állapot |
| `src/delivery/http/view/theme.ts` | designtokenek és a közös CSS egyetlen sztringben |
| `src/delivery/http/view/shell.ts` | `layout()`: dokumentum, navigáció, állapotsáv |
| `src/delivery/http/view/today.ts` | a Ma oldal törzse |
| `src/delivery/http/view/numbers.ts` | a Számok oldal törzse + `MetricRow`, `metricsRowsFrom` |
| `src/delivery/http/view/analyses.ts` | az Elemzés oldal törzse |
| `src/delivery/http/view/ask.ts` | a Kérdés oldal törzse + a kliens-script |
| `src/delivery/http/routes/page.ts` | négy `GET` és a meglévő `POST /api/chat` |
| `src/delivery/http/page.ts` | **törlendő** a 8. feladatban |

---

### Task 1: `view/channels.ts` — a napi mag és az esedékesség

**Files:**
- Create: `src/delivery/http/view/channels.ts`
- Test: `test/delivery/view-channels.test.ts`

**Interfaces:**
- Consumes: `HealthSnapshot` a `src/infra/db/repositories/health.ts`-ből; `isoTime`, `TZ` a `src/shared/dates.ts`-ből.
- Produces:
  - `type ChannelState = "erkezett" | "varakozik" | "elmaradt"`
  - `interface Channel { column: string; label: string; dueHour: number; format: (v: number) => string }`
  - `const NAPI_MAG: readonly Channel[]`
  - `interface ChannelReading { channel: Channel; state: ChannelState; value: string | null }`
  - `function readChannels(today: HealthSnapshot | undefined, now: Date): ChannelReading[]`
  - `interface ChannelSummary { arrived: number; waiting: number; missing: number; missingLabels: string[]; total: number }`
  - `function summarise(readings: readonly ChannelReading[]): ChannelSummary`

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// test/delivery/view-channels.test.ts
import { describe, it, expect } from "vitest";
import { NAPI_MAG, readChannels, summarise } from "../../src/delivery/http/view/channels.ts";
import type { HealthSnapshot } from "../../src/infra/db/repositories/health.ts";

/** Egy mai sor, ahol minden null, kivéve amit a teszt megad. */
const row = (over: Partial<HealthSnapshot>): HealthSnapshot => ({
  date: "2026-09-02", sleepH: null, hrv: null, rhr: null, moveKcal: null,
  exerciseMin: null, steps: null, asleepMin: null, inBedMin: null, coreMin: null,
  remMin: null, deepMin: null, awakenings: null, vo2max: null, hrRecovery: null,
  walkingHr: null, basalKcal: null, flights: null, dietKcal: null,
  dietProteinG: null, dietCarbsG: null, dietFatG: null, distanceKm: null,
  standMin: null, walkingSpeed: null, stepLengthCm: null, doubleSupportPct: null,
  asymmetryPct: null, steadinessPct: null, sixMinWalkM: null, stairUpMs: null,
  stairDownMs: null, ingestedAt: "2026-09-02T06:00:00.000Z",
  ...over,
});

// 2026-09-02 08:00 CEST = 06:00Z; 10:00 CEST = 08:00Z; 00:30 CEST = 22:30Z előző nap.
const DELELOTT = new Date("2026-09-02T08:00:00.000Z"); // 10:00 helyi
const EJFEL_UTAN = new Date("2026-09-02T22:30:00.000Z"); // 2026-09-03 00:30 helyi

describe("napi mag", () => {
  it("csak minden nap érkező mérést tartalmaz, mindegyiket esedékes órával", () => {
    // A ritkán mértek (VO2max, járásstabilitás, hatperces séta) kimaradnak: a
    // hiányuk nem a csővezetékről mond semmit.
    expect(NAPI_MAG.map((c) => c.column)).toEqual(
      ["sleep_h", "hrv", "rhr", "steps", "move_kcal", "exercise_min"],
    );
    expect(NAPI_MAG.every((c) => c.dueHour >= 0 && c.dueHour <= 24)).toBe(true);
  });

  it("délelőtt az esti csatorna várakozik, nem maradt el", () => {
    // A pár első fele. Külön-külön mindkét fele átmegy egy olyan
    // implementáción, ami az esedékességet figyelmen kívül hagyja — együtt nem.
    const r = readChannels(row({ sleepH: 7.1, hrv: 67.7, rhr: 55 }), DELELOTT);
    const steps = r.find((x) => x.channel.column === "steps")!;
    expect(steps.state).toBe("varakozik");
    expect(summarise(r).missing).toBe(0);
  });

  it("éjfél után ugyanaz a hiány már elmaradt", () => {
    const r = readChannels(row({ sleepH: 7.1, hrv: 67.7, rhr: 55 }), EJFEL_UTAN);
    const steps = r.find((x) => x.channel.column === "steps")!;
    expect(steps.state).toBe("elmaradt");
    expect(summarise(r).missingLabels).toContain(steps.channel.label);
  });

  it("a megérkezett értéket embernek formázva adja", () => {
    const r = readChannels(row({ sleepH: 7.1, hrv: 67.7, rhr: 55, steps: 6753 }), EJFEL_UTAN);
    const byColumn = new Map(r.map((x) => [x.channel.column, x]));
    expect(byColumn.get("sleep_h")!.state).toBe("erkezett");
    expect(byColumn.get("sleep_h")!.value).toBe("7,1 óra");
    expect(byColumn.get("steps")!.value).toBe("6 753 lépés");
  });

  it("mai sor nélkül minden csatorna várakozik vagy elmaradt, de egyik sem nulla", () => {
    // Ez a hiba, aminek a megelőzésére az egész rendszer épül: a hiányzó
    // mérés soha nem jelenhet meg nullaként.
    const r = readChannels(undefined, EJFEL_UTAN);
    expect(r).toHaveLength(NAPI_MAG.length);
    expect(r.every((x) => x.value === null)).toBe(true);
    expect(summarise(r).arrived).toBe(0);
  });

  it("a nulla mérés valódi mérés", () => {
    // Nulla lépés egy ágyban töltött napon igaz. Csak a null jelent hiányt.
    const r = readChannels(row({ steps: 0 }), EJFEL_UTAN);
    const steps = r.find((x) => x.channel.column === "steps")!;
    expect(steps.state).toBe("erkezett");
    expect(steps.value).toBe("0 lépés");
  });
});
```

- [ ] **Step 2: Futtasd, és győződj meg róla, hogy bukik**

Run: `npx vitest run test/delivery/view-channels.test.ts`
Expected: FAIL — `Failed to resolve import ".../view/channels.ts"`

- [ ] **Step 3: Írd meg a minimális implementációt**

```ts
// src/delivery/http/view/channels.ts
import type { HealthSnapshot } from "../../../infra/db/repositories/health.ts";
import { isoTime, TZ } from "../../../shared/dates.ts";

export type ChannelState = "erkezett" | "varakozik" | "elmaradt";

export interface Channel {
  /** The history column this channel is measured in. */
  column: string;
  label: string;
  /**
   * The local hour by which the pipeline should have delivered it.
   *
   * Before this hour an absent value is not a gap, and must not be shown as
   * one: three of the six arrive from the 23:50 run, so without the hour the
   * status strip would read "3/6" and alarm every single day from morning to
   * night while nothing at all was wrong. A signal that always alarms is worth
   * exactly as much as one that never does.
   */
  dueHour: number;
  format: (v: number) => string;
}

const hu = (n: number, digits = 0) =>
  n.toLocaleString("hu-HU", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/**
 * What the daily channel delivers EVERY day, and when.
 *
 * Deliberately not the 31 stored columns: VO2max, walking steadiness and the
 * six-minute walk are measured occasionally by the watch, so their absence
 * says nothing about the pipeline. These six say everything about it.
 */
export const NAPI_MAG: readonly Channel[] = [
  { column: "sleep_h", label: "Alvás", dueHour: 8, format: (v) => `${hu(v, 1)} óra` },
  { column: "hrv", label: "HRV", dueHour: 8, format: (v) => `${hu(v, 1)} ms` },
  { column: "rhr", label: "Nyugalmi pulzus", dueHour: 8, format: (v) => `${hu(v)} bpm` },
  { column: "steps", label: "Lépés", dueHour: 24, format: (v) => `${hu(v)} lépés` },
  { column: "move_kcal", label: "Aktív kalória", dueHour: 24, format: (v) => `${hu(v)} kcal` },
  { column: "exercise_min", label: "Mozgás", dueHour: 24, format: (v) => `${hu(v)} perc` },
];

/** The snapshot field each channel column is read from. */
const FIELD: Record<string, keyof HealthSnapshot> = {
  sleep_h: "sleepH", hrv: "hrv", rhr: "rhr",
  steps: "steps", move_kcal: "moveKcal", exercise_min: "exerciseMin",
};

export interface ChannelReading {
  channel: Channel;
  state: ChannelState;
  /** Formatted for a person, or null when nothing was measured. */
  value: string | null;
}

export function readChannels(
  today: HealthSnapshot | undefined, now: Date,
): ChannelReading[] {
  const hour = Number(isoTime(now, TZ).slice(0, 2));

  return NAPI_MAG.map((channel) => {
    const raw = today?.[FIELD[channel.column]!];
    // Only null means absent. A measured zero — no steps on a day spent in bed
    // — is a fact, and turning it into a gap would be the same lie as turning
    // a gap into a zero.
    if (typeof raw === "number") {
      return { channel, state: "erkezett" as const, value: channel.format(raw) };
    }
    return {
      channel,
      state: hour >= channel.dueHour ? ("elmaradt" as const) : ("varakozik" as const),
      value: null,
    };
  });
}

export interface ChannelSummary {
  arrived: number;
  waiting: number;
  missing: number;
  /** Labels of the missing ones — the status strip names them. */
  missingLabels: string[];
  total: number;
}

export function summarise(readings: readonly ChannelReading[]): ChannelSummary {
  return {
    arrived: readings.filter((r) => r.state === "erkezett").length,
    waiting: readings.filter((r) => r.state === "varakozik").length,
    missing: readings.filter((r) => r.state === "elmaradt").length,
    missingLabels: readings.filter((r) => r.state === "elmaradt").map((r) => r.channel.label),
    total: readings.length,
  };
}
```

- [ ] **Step 4: Futtasd, és győződj meg róla, hogy átmegy**

Run: `npx vitest run test/delivery/view-channels.test.ts`
Expected: PASS (6 teszt)

- [ ] **Step 5: Ellenőrizd, hogy a tesztek tényleg fognak**

Rontsd el egyesével, futtass, majd állítsd vissza:
1. `hour >= channel.dueHour` → `true` — a „délelőtt várakozik" teszt bukjon.
2. `hour >= channel.dueHour` → `false` — az „éjfél után elmaradt" teszt bukjon.
3. `typeof raw === "number"` → `typeof raw === "number" && raw !== 0` — a „nulla mérés valódi mérés" teszt bukjon.

Ha bármelyik mutáció után minden teszt átmegy, a teszt nem fog — javítsd, mielőtt továbbmész.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/channels.ts test/delivery/view-channels.test.ts
git commit -m "$(printf 'feat: a napi mag csatornái és az esedékességük\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 2: `view/theme.ts` — designtokenek és közös CSS

**Files:**
- Create: `src/delivery/http/view/theme.ts`
- Test: `test/delivery/view-theme.test.ts`

**Interfaces:**
- Produces: `const TOKEN_NAMES: readonly string[]`, `const STYLE: string`

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// test/delivery/view-theme.test.ts
import { describe, it, expect } from "vitest";
import { STYLE, TOKEN_NAMES } from "../../src/delivery/http/view/theme.ts";

describe("téma", () => {
  it("mindkét séma minden tokent megad", () => {
    const root = /:root\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
    const light = /prefers-color-scheme:\s*light\s*\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
    for (const name of TOKEN_NAMES) {
      expect(root, `sötét: ${name}`).toContain(`${name}:`);
      expect(light, `világos: ${name}`).toContain(`${name}:`);
    }
  });

  it("nincs olyan szín, amit csak média-blokk ad meg", () => {
    // A klasszikus olvashatatlan-oldal hiba: egy szín, aminek az egyetlen
    // definíciója média-blokkban van, a másik sémában egyszerűen nincs.
    const light = /prefers-color-scheme:\s*light\s*\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
    const root = /:root\s*\{([^}]*)\}/.exec(STYLE)?.[1] ?? "";
    const declared = [...light.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]!);
    for (const name of declared) expect(root).toContain(`${name}:`);
  });

  it("a body kifest egy hátteret", () => {
    // Átlátszó törzs a gazda hátterét kölcsönzi, és a másik séma szövegét
    // teszi a saját alapjára.
    expect(/body\s*\{[^}]*background:\s*var\(--hatter\)/.test(STYLE)).toBe(true);
  });

  it("a csökkentett mozgás mindent leállít, az oldalváltást is", () => {
    // A @view-transition alapból animál; a reduced-motion blokknak a
    // ::view-transition-* pszeudóelemeket is le kell állítania, különben az
    // egyetlen mozgás marad, amit a beállítás nem tud kikapcsolni.
    expect(STYLE).toContain("@view-transition");
    const reduced = /prefers-reduced-motion[^{]*\{([\s\S]*)\}\s*`?\s*$/.exec(STYLE)?.[1] ?? "";
    expect(reduced).toContain("view-transition");
  });
});
```

- [ ] **Step 2: Futtasd, és győződj meg róla, hogy bukik**

Run: `npx vitest run test/delivery/view-theme.test.ts`
Expected: FAIL — nem oldható fel az import

- [ ] **Step 3: Írd meg az implementációt**

A tokenek pontos értékei a specből, szó szerint. A `STYLE` sztring tartalmazza a tokeneket, az alap tipográfiát, a navigációt, az állapotsávot, a readout-sorokat és a mozgást. A meglévő `src/delivery/http/page.ts` `STYLE` konstansa jó kiindulás: a `.rail`, `.note`, `.turn`, `form` szabályok átemelhetők, a színnevek viszont az újakra cserélődnek.

```ts
// src/delivery/http/view/theme.ts

/** Every design token, checked by the theme test against both schemes. */
export const TOKEN_NAMES = [
  "--hatter", "--lap", "--racs", "--szoveg", "--halvany",
  "--jel", "--jel-halk", "--vaz", "--riado",
] as const;

/**
 * The page is an instrument, and it shows its own signal quality.
 *
 * Every hard bug this project has had was a number that looked real and was
 * not, so colour carries exactly one meaning each: `--jel` is measured data
 * and nothing else, `--vaz` is chrome and never data, `--riado` is a channel
 * that was due and did not arrive, and never decoration. What was not
 * measured has no hue at all and does not animate — the absence is what you
 * see, because nothing happens there.
 */
export const STYLE = `
:root {
  color-scheme: dark light;
  --hatter: #07090E; --lap: #0E131C; --racs: #18212E;
  --szoveg: #DCE3EE; --halvany: #6C7891;
  --jel: #FFA23C; --jel-halk: rgba(255,162,60,.18);
  --vaz: #4B7A8C; --riado: #FF3D7F;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --text: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root {
    --hatter: #E9ECF1; --lap: #FFFFFF; --racs: #CFD5DF;
    --szoveg: #0E131C; --halvany: #626D80;
    --jel: #A85400; --jel-halk: rgba(168,84,0,.14);
    --vaz: #2C5766; --riado: #C1004E;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--hatter); color: var(--szoveg);
  font: 16px/1.65 var(--text); -webkit-font-smoothing: antialiased; }

/* ---- navigáció: asztalon bal sáv, telefonon alsó sor ---- */
nav { display: flex; gap: .25rem; position: fixed; inset: auto 0 0 0; z-index: 2;
  background: var(--lap); border-top: 1px solid var(--racs); padding: .4rem; }
nav a.menu { flex: 1; text-align: center; padding: .6rem .4rem; border-radius: .25rem;
  color: var(--halvany); text-decoration: none;
  font: 600 .68rem/1.4 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
nav a.menu[aria-current="page"] { color: var(--vaz); background: var(--hatter); }
/* A lámpa a menüpont alatt: ég, ha a szekciónak van most mit mutatnia. */
nav a.menu.jelzo::after { content: ""; display: block; width: 4px; height: 4px;
  border-radius: 50%; margin: .35rem auto 0; background: var(--racs); }
nav a.menu.jelzo.el::after { background: var(--jel); }
@media (min-width: 46rem) {
  nav { inset: 0 auto 0 0; width: 8.5rem; flex-direction: column; justify-content: flex-start;
    border-top: 0; border-right: 1px solid var(--racs); padding: 2rem .5rem; gap: .15rem; }
  nav a.menu { flex: 0 0 auto; text-align: left; padding: .55rem .7rem; }
  nav a.menu.jelzo::after { display: inline-block; margin: 0 0 .15rem .5rem; }
}

/* ---- lap ---- */
.lap { max-width: 48rem; margin: 0 auto; padding: 1.5rem 1.25rem 7rem; }
@media (min-width: 46rem) { .lap { padding: 2.5rem 2rem 4rem 10.5rem; max-width: 58rem; } }

/* ---- állapotsáv ---- */
.allapot { display: flex; flex-wrap: wrap; gap: .3rem 1.1rem; align-items: baseline;
  padding-bottom: 1rem; margin-bottom: 1.75rem; border-bottom: 1px solid var(--racs);
  font: .72rem/1.6 var(--mono); letter-spacing: .05em; }
.allapot .datum { color: var(--vaz); text-transform: uppercase; letter-spacing: .18em; }
.allapot .halk { color: var(--halvany); }
.allapot .elmaradt { color: var(--riado); }

/* ---- próza ---- */
section { margin-bottom: 2.75rem; }
section > :first-child { margin-top: 0; }
h2 { font: 600 .72rem/1.8 var(--mono); letter-spacing: .2em; text-transform: uppercase;
  color: var(--vaz); margin: 0 0 .9rem; }
h3 { font: 600 .7rem/1.8 var(--mono); letter-spacing: .16em; text-transform: uppercase;
  color: var(--szoveg); margin: 2.2rem 0 .6rem; padding-top: 1rem;
  border-top: 1px solid var(--racs); }
section > h3:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
p { margin: .7rem 0; }
ul { margin: .7rem 0; padding-left: 1.15rem; }
li { margin: .25rem 0; }
li.task { list-style: none; margin-left: -1.15rem; }
li.task input { accent-color: var(--jel); margin-right: .45rem; }
code { font: .88em var(--mono); background: var(--lap); padding: .12em .35em; border-radius: .2rem; }
strong { font-weight: 600; }
.halk { color: var(--halvany); }

/* ---- mai csatornák ---- */
.csatornak { display: grid; gap: 1px; background: var(--racs); border: 1px solid var(--racs); }
.csatorna { display: flex; justify-content: space-between; align-items: baseline;
  gap: 1rem; padding: .75rem .9rem; background: var(--hatter); }
.csatorna .cimke { font: .72rem/1.4 var(--mono); letter-spacing: .1em;
  text-transform: uppercase; color: var(--halvany); }
.csatorna .ertek { font: 500 1rem/1.4 var(--mono); font-variant-numeric: tabular-nums; }
.csatorna.erkezett .ertek { color: var(--jel); }
/* Ami nincs mérve, annak nincs színe — és nem is mozdul. */
.csatorna.varakozik .ertek, .csatorna.elmaradt .ertek {
  color: var(--halvany); font-size: .8rem; font-weight: 400; }

/* ---- readout tábla ---- */
table { border-collapse: collapse; width: 100%; }
tr { border-bottom: 1px solid var(--racs); }
tr:last-child { border-bottom: 0; }
td { padding: .7rem 0; vertical-align: baseline; }
td:first-child { font: .78rem/1.4 var(--mono); color: var(--halvany); padding-right: 1rem; }
td.value { font: 500 1.05rem/1.4 var(--mono); font-variant-numeric: tabular-nums;
  text-align: right; white-space: nowrap; color: var(--jel); padding-right: 1rem; }
tr.dead td.value { color: var(--halvany); font-weight: 400; font-size: .82rem; }
td.ev { width: 9.5rem; }
.rail { display: block; height: 2px; background: var(--racs); position: relative; overflow: hidden; }
.rail::after { content: ""; position: absolute; inset: 0 auto 0 0; width: var(--fill, 0%);
  background: var(--jel); transform-origin: left center; }
.rail.dead { background: none; height: 0; border-top: 1px dashed var(--racs); }
.rail.dead::after { content: none; }
.note { display: block; margin-top: .4rem; font: .68rem/1.4 var(--mono); color: var(--halvany); }

/* ---- beszélgetés ---- */
.turn { margin: 1rem 0; padding-left: .9rem; border-left: 2px solid var(--racs); }
.turn.user { border-left-color: var(--jel-halk); }
.who { font: .66rem/1.8 var(--mono); letter-spacing: .18em; text-transform: uppercase;
  color: var(--halvany); }

/* ---- kérdés ---- */
form { display: flex; gap: .5rem; margin-top: 1.4rem; position: relative; }
form input[type=text] { flex: 1; padding: .7rem .8rem; background: var(--lap);
  border: 1px solid var(--racs); border-radius: .3rem; color: var(--szoveg); font: inherit; }
form input[type=text]::placeholder { color: var(--halvany); }
form input[type=text]:focus-visible { outline: 2px solid var(--jel); outline-offset: 1px; }
form button { padding: .7rem 1.15rem; border: 1px solid var(--jel); border-radius: .3rem;
  background: transparent; color: var(--jel); cursor: pointer;
  font: 600 .72rem/1.4 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
form button:hover:not([disabled]) { background: var(--jel-halk); }
form button:focus-visible { outline: 2px solid var(--jel); outline-offset: 2px; }
form [disabled] { opacity: .45; cursor: not-allowed; }
form.busy::after { content: ""; position: absolute; left: 0; right: 0; bottom: -.6rem; height: 2px;
  background: linear-gradient(90deg, transparent, var(--jel), transparent);
  background-size: 40% 100%; background-repeat: no-repeat;
  animation: sweep 1.1s linear infinite; }

/* ---- mozgás ---- */
@view-transition { navigation: auto; }
@keyframes settle { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes rail-in { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes sweep { from { background-position: -40% 0; } to { background-position: 140% 0; } }
.allapot, section { animation: settle .5s cubic-bezier(.2,.8,.2,1) both;
  animation-delay: calc(var(--i, 0) * 60ms); }
.rail::after { animation: rail-in .7s cubic-bezier(.2,.8,.2,1) both;
  animation-delay: calc(320ms + var(--i, 0) * 45ms); }
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
  .allapot, section, .rail::after, form.busy::after { animation: none; }
}
`;
```

A `@view-transition { navigation: auto; }` a natív oldalváltás-átúsztatás: nulla JS, és ahol a böngésző nem ismeri, egyszerűen nem történik semmi.

- [ ] **Step 4: Futtasd, és győződj meg róla, hogy átmegy**

Run: `npx vitest run test/delivery/view-theme.test.ts`
Expected: PASS (4 teszt)

- [ ] **Step 5: Ellenőrizd, hogy a tesztek fognak**

Vedd ki a `--riado` sort a világos blokkból: az első teszt bukjon. Állítsd vissza.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/theme.ts test/delivery/view-theme.test.ts
git commit -m "$(printf 'feat: a designrendszer tokenjei és a közös stíluslap\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 3: `view/shell.ts` — oldalkeret, navigáció, állapotsáv

**Files:**
- Create: `src/delivery/http/view/shell.ts`
- Test: `test/delivery/view-shell.test.ts`

**Interfaces:**
- Consumes: `STYLE` (Task 2); `ChannelSummary` és `summarise` (Task 1); `escapeHtml` a `../markdown.ts`-ből.
- Produces:
  - `type Section = "ma" | "elemzes" | "szamok" | "kerdes"`
  - `interface NavState { ma: boolean; elemzes: boolean; kerdes: boolean }`
  - `interface ShellData { section: Section; dateLabel: string; briefAge: string | null; channels: ChannelSummary; nav: NavState; body: string }`
  - `function layout(data: ShellData): string`

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// test/delivery/view-shell.test.ts
import { describe, it, expect } from "vitest";
import { layout, type ShellData } from "../../src/delivery/http/view/shell.ts";

const base: ShellData = {
  section: "ma",
  dateLabel: "2026. szeptember 2., szerda",
  briefAge: "2 órája",
  channels: { arrived: 3, waiting: 3, missing: 0, missingLabels: [], total: 6 },
  nav: { ma: true, elemzes: true, kerdes: false },
  body: "<p>törzs</p>",
};

describe("oldalkeret", () => {
  it("egy teljes dokumentumot ad, a törzzsel benne", () => {
    const html = layout(base);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<p>törzs</p>");
  });

  it("az aktív menüpontot megjelöli, és csak azt", () => {
    const html = layout({ ...base, section: "szamok" });
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(/<a[^>]*href="\/szamok"[^>]*aria-current="page"/.test(html)).toBe(true);
  });

  it("a menüpontok jelzője a valódi adatból jön", () => {
    const html = layout(base);
    // A Kérdés jelzője kialszik, mert a modell nem érhető el.
    expect(/href="\/kerdes"[^>]*class="[^"]*holt/.test(html)).toBe(true);
    expect(/href="\/"[^>]*class="[^"]*holt/.test(html)).toBe(false);
  });

  it("a Számok menüpontnak nincs jelzője", () => {
    // Mindig van előzménye, tehát a jelzője soha nem tudna kialudni — egy
    // jelző, ami nem tud kikapcsolni, dekoráció.
    const nav = /<nav[\s\S]*?<\/nav>/.exec(layout(base))![0];
    const szamok = /<a[^>]*href="\/szamok"[\s\S]*?<\/a>/.exec(nav)![0];
    expect(szamok).not.toContain("jelzo");
  });

  it("elmaradt csatornát névvel és riasztó színnel mutat", () => {
    const html = layout({
      ...base,
      channels: { arrived: 3, waiting: 0, missing: 3, missingLabels: ["Lépés", "Aktív kalória", "Mozgás"], total: 6 },
    });
    expect(html).toContain("Lépés");
    expect(/class="[^"]*elmaradt/.test(html)).toBe(true);
  });

  it("nem mutat riasztást, amíg csak várakozás van", () => {
    const html = layout(base);
    expect(/class="[^"]*elmaradt/.test(html)).toBe(false);
  });

  it("escape-eli a beleadott szöveget", () => {
    const html = layout({ ...base, dateLabel: "<script>x()</script>" });
    expect(html).not.toContain("<script>x()</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
```

- [ ] **Step 2: Futtasd, és győződj meg róla, hogy bukik**

Run: `npx vitest run test/delivery/view-shell.test.ts`
Expected: FAIL — nem oldható fel az import

- [ ] **Step 3: Írd meg az implementációt**

```ts
// src/delivery/http/view/shell.ts
import { escapeHtml } from "../markdown.ts";
import { STYLE } from "./theme.ts";
import type { ChannelSummary } from "./channels.ts";

export type Section = "ma" | "elemzes" | "szamok" | "kerdes";

/** Whether each section has anything live to show right now. */
export interface NavState { ma: boolean; elemzes: boolean; kerdes: boolean }

export interface ShellData {
  section: Section;
  dateLabel: string;
  /** How old the brief is, already worded — null when there is none. */
  briefAge: string | null;
  channels: ChannelSummary;
  nav: NavState;
  body: string;
}

/**
 * `szamok` carries no indicator on purpose.
 *
 * It always has history behind it, so its lamp could never go dark — and an
 * indicator that cannot turn off is decoration, not information.
 */
const ITEMS: { section: Section; href: string; label: string; lamp: keyof NavState | null }[] = [
  { section: "ma", href: "/", label: "Ma", lamp: "ma" },
  { section: "elemzes", href: "/elemzes", label: "Elemzés", lamp: "elemzes" },
  { section: "szamok", href: "/szamok", label: "Számok", lamp: null },
  { section: "kerdes", href: "/kerdes", label: "Kérdés", lamp: "kerdes" },
];

function nav(data: ShellData): string {
  const items = ITEMS.map((item) => {
    const active = item.section === data.section;
    const lamp = item.lamp === null ? "" : (data.nav[item.lamp] ? " jelzo el" : " jelzo holt");
    return `<a href="${item.href}" class="menu${lamp}"${active ? ' aria-current="page"' : ""}>`
      + `${escapeHtml(item.label)}</a>`;
  }).join("");
  return `<nav>${items}</nav>`;
}

function statusStrip(data: ShellData): string {
  const { arrived, waiting, missing, missingLabels, total } = data.channels;
  const parts = [
    `<span class="datum">${escapeHtml(data.dateLabel)}</span>`,
    data.briefAge === null
      ? `<span class="halk">nincs mai briefing</span>`
      : `<span class="halk">briefing ${escapeHtml(data.briefAge)}</span>`,
    `<span class="halk">${arrived}/${total} csatorna</span>`,
  ];
  if (waiting > 0) parts.push(`<span class="halk">${waiting} várakozik</span>`);
  // The one place magenta appears: a channel that was due and did not arrive.
  if (missing > 0) {
    parts.push(`<span class="elmaradt">elmaradt: ${escapeHtml(missingLabels.join(", "))}</span>`);
  }
  return `<div class="allapot">${parts.join("")}</div>`;
}

export function layout(data: ShellData): string {
  return [
    "<!doctype html>",
    `<html lang="hu"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="dark light">`,
    "<title>Jarvis</title>",
    `<style>${STYLE}</style></head><body>`,
    nav(data),
    `<main class="lap">`,
    statusStrip(data),
    data.body,
    "</main></body></html>",
  ].join("");
}
```

- [ ] **Step 4: Futtasd, és győződj meg róla, hogy átmegy**

Run: `npx vitest run test/delivery/view-shell.test.ts`
Expected: PASS (7 teszt)

- [ ] **Step 5: Ellenőrizd, hogy a tesztek fognak**

1. Add meg a `szamok` menüpontnak is a lámpát — a „nincs jelzője" teszt bukjon.
2. Tedd az `aria-current`-et minden menüpontra — az „aktív menüpont" teszt bukjon.
3. Írasd ki az `elmaradt` blokkot akkor is, ha `missing === 0` — a „nem mutat riasztást" teszt bukjon.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/shell.ts test/delivery/view-shell.test.ts
git commit -m "$(printf 'feat: oldalkeret navigációval és állapotsávval\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 4: `view/today.ts` és a `/` útvonal

**Files:**
- Create: `src/delivery/http/view/today.ts`
- Modify: `src/delivery/http/routes/page.ts`, `src/delivery/http/server.ts:108-112`
- Test: `test/delivery/page.test.ts` (a „page routes" blokk bővül)

**Interfaces:**
- Consumes: `readChannels`, `summarise` (Task 1); `layout`, `ShellData` (Task 3); `renderMarkdown` a `../markdown.ts`-ből; `HealthRepo` a repositoryból.
- Produces: `function todayBody(data: TodayData): string`, `interface TodayData { briefMarkdown: string | null; readings: ChannelReading[]; lastSeen: string | null }`

**A `PageDeps` bővítése:** `health: HealthRepo`. A `server.ts` `registerPageRoutes` hívása kap egy `health: deps.health` mezőt — a `ServerDeps` már tartalmazza, mert az ingest is használja.

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
// test/delivery/page.test.ts — a "page routes" describe-on belül
it("a Ma oldal a mai méréseket mutatja, nullát soha", async () => {
  const a = await boot();
  const res = await a.server.inject({
    method: "GET", url: "/", headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  expect(res.statusCode).toBe(200);
  // Nincs mai sor: minden csatorna hiányzik, és egyik sem nulla.
  expect(res.body).toContain("nincs mérés");
  expect(res.body).not.toMatch(/>0 lépés</);
  await a.close();
});

it("a Ma oldal akkor is renderel, ha a brief lekérése hibát dob", async () => {
  const a = await boot();
  // A brief-szolgáltatás megbukik; a mérések és a keret akkor is ott vannak.
  (a.briefs as unknown as { cached: () => never }).cached = () => {
    throw new Error("szándékos hiba");
  };
  const res = await a.server.inject({
    method: "GET", url: "/", headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("Ma");
  await a.close();
});
```

- [ ] **Step 2: Futtasd, és győződj meg róla, hogy bukik**

Run: `npx vitest run test/delivery/page.test.ts`
Expected: FAIL — a `/` a régi egyoldalas HTML-t adja, „nincs mérés" nélkül

- [ ] **Step 3: Írd meg az implementációt**

```ts
// src/delivery/http/view/today.ts
import { escapeHtml, renderMarkdown } from "../markdown.ts";
import type { ChannelReading } from "./channels.ts";

export interface TodayData {
  briefMarkdown: string | null;
  readings: readonly ChannelReading[];
  /** The most recent day that has any data, when today has none. */
  lastSeen: string | null;
  /** When today's row was last written, already worded — null when there is none. */
  writtenAge: string | null;
}

/** A measured channel is lit; a waiting or missing one has no hue and no motion. */
function channelRow(r: ChannelReading): string {
  const shown = r.value ?? (r.state === "varakozik" ? "várakozik" : "nincs mérés");
  return [
    `<div class="csatorna ${r.state}">`,
    `<span class="cimke">${escapeHtml(r.channel.label)}</span>`,
    `<span class="ertek">${escapeHtml(shown)}</span>`,
    "</div>",
  ].join("");
}

export function todayBody(data: TodayData): string {
  // Empty-after-trim counts as absent: an empty "Briefing" heading with
  // nothing under it is missing data that does not look missing.
  const brief = data.briefMarkdown === null || data.briefMarkdown.trim() === ""
    ? `<p class="halk">Ma még nem készült briefing.</p>`
    : renderMarkdown(data.briefMarkdown);

  const stale = data.lastSeen === null
    ? ""
    : `<p class="halk">Ma még nincs adat. A legutóbbi nap: ${escapeHtml(data.lastSeen)}.</p>`;

  // Freshness belongs next to the readings: a row written at 08:15 and one
  // written at 23:55 hold very different amounts of the day, and the numbers
  // themselves cannot say which they are.
  const written = data.writtenAge === null
    ? ""
    : `<p class="halk">A mai sor ${escapeHtml(data.writtenAge)} íródott.</p>`;

  return [
    `<section><h2>Briefing</h2>${brief}</section>`,
    `<section><h2>A mai nap</h2>${stale}${written}`,
    `<div class="csatornak">${data.readings.map(channelRow).join("")}</div></section>`,
  ].join("");
}
```

A `routes/page.ts` `GET /` kezelője. Ez a minta, amit mind a négy útvonal
követ: **minden darab a saját `try`-jában bukik**, mert egy hiányzó brief nem
viheti magával a mai méréseket.

```ts
// src/delivery/http/routes/page.ts
import { readChannels, summarise } from "../view/channels.ts";
import { layout, type NavState } from "../view/shell.ts";
import { todayBody } from "../view/today.ts";
import { huLongDate, isoDate, TZ } from "../../../shared/dates.ts";

/** "2 órája" — a brief kora emberi szavakkal, vagy null, ha nincs brief. */
function ageWords(from: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 60) return `${minutes} perce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} órája`;
  return `${Math.round(hours / 24)} napja`;
}

app.get("/", async (_request, reply) => {
  const now = deps.clock.now();
  const today = isoDate(now, TZ);

  // `cached`, never `get`: opening the page must not start a brief
  // generation — every module plus a Groq synthesis, up to 45 seconds, for a
  // page the owner only wanted to read.
  let briefMarkdown: string | null = null;
  let briefAge: string | null = null;
  try {
    const brief = deps.briefs.cached(now);
    if (brief && brief.markdown.trim() !== "") {
      briefMarkdown = brief.markdown;
      briefAge = ageWords(brief.generatedAt, now);
    }
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "page rendered without a brief");
  }

  let snapshot = undefined;
  let lastSeen: string | null = null;
  try {
    snapshot = deps.health.forDate(today);
    if (snapshot === undefined) lastSeen = deps.health.latest(today)?.date ?? null;
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "page rendered without today's readings");
  }

  let hasAnalysis = false;
  try {
    hasAnalysis = deps.analyses.latestPerDomain().length > 0;
  } catch (err) {
    deps.logger.warn({ err: String(err) }, "nav indicator fell back to dark");
  }

  const readings = readChannels(snapshot, now);
  const nav: NavState = {
    ma: briefMarkdown !== null,
    elemzes: hasAnalysis,
    kerdes: await deps.chat.available(),
  };

  return reply.type("text/html; charset=utf-8").send(layout({
    section: "ma",
    dateLabel: huLongDate(now, TZ),
    briefAge,
    channels: summarise(readings),
    nav,
    body: todayBody({
      briefMarkdown,
      readings,
      lastSeen,
      writtenAge: snapshot ? ageWords(snapshot.ingestedAt, now) : null,
    }),
  }));
});
```

A `brief.generatedAt` mezőnevet a `src/core/brief-service.ts`-ből kell
ellenőrizni az első lépésben; ha másképp hívják, a `ageWords` hívása követi.
A `nav` összeállítása mind a négy útvonalon azonos — emeld ki egy
`navState(deps)` segédfüggvénybe a második útvonalnál, ne az elsőnél.

- [ ] **Step 4: Futtasd, és győződj meg róla, hogy átmegy**

Run: `npx vitest run test/delivery/page.test.ts`
Expected: PASS

- [ ] **Step 5: Ellenőrizd, hogy a tesztek fognak**

Cseréld a `channelRow` `shown` kifejezését `r.value ?? "0"`-ra: a „nullát soha" teszt bukjon.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/today.ts src/delivery/http/routes/page.ts src/delivery/http/server.ts test/delivery/page.test.ts
git commit -m "$(printf 'feat: a Ma oldal az új kereten\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 5: `view/numbers.ts` és a `/szamok` útvonal

**Files:**
- Create: `src/delivery/http/view/numbers.ts`
- Modify: `src/delivery/http/routes/page.ts`, `src/main.ts:8`
- Test: `test/delivery/page.test.ts`

**Interfaces:**
- Consumes: `layout` (Task 3).
- Produces: `interface MetricRow { label: string; value: string; detail: string; coverage: number | null }`, `function metricsRowsFrom(m: Metrics): MetricRow[]`, `function numbersBody(rows: readonly MetricRow[]): string`

A `MetricRow` és a `metricsRowsFrom` a mai `page.ts`-ből **változatlan tartalommal** költözik ide, a `readout` renderelővel együtt. A `main.ts:8` importja `./delivery/http/view/numbers.ts`-re változik.

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
it("a Számok oldal a metrikákat adja, sávval", async () => {
  const a = await boot();
  const res = await a.server.inject({
    method: "GET", url: "/szamok", headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("Terhelési arány");
  await a.close();
});
```

A `metricsRowsFrom` meglévő tesztjei (`describe("metricsRowsFrom")`) változatlanul maradnak, csak az import útja frissül.

- [ ] **Step 2: Futtasd** — `npx vitest run test/delivery/page.test.ts`, FAIL: 404.
- [ ] **Step 3: Írd meg az implementációt** — a `page.ts` `readout` és `metricsRowsFrom` függvényeinek átemelése, plusz:

```ts
export function numbersBody(rows: readonly MetricRow[]): string {
  return `<section><h2>Számok</h2><table>${rows.map(readout).join("")}</table></section>`;
}
```

- [ ] **Step 4: Futtasd** — PASS.
- [ ] **Step 5: Ellenőrizd** — vedd ki a `coverage === null` ágat a `readout`-ból: a meglévő „ablak nélküli sor nem kap sávot" teszt bukjon.
- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/numbers.ts src/delivery/http/routes/page.ts src/main.ts test/delivery/page.test.ts
git commit -m "$(printf 'feat: a Számok oldal\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 6: `view/analyses.ts` és a `/elemzes` útvonal

**Files:**
- Create: `src/delivery/http/view/analyses.ts`
- Modify: `src/delivery/http/routes/page.ts`
- Test: `test/delivery/page.test.ts`

**Interfaces:**
- Produces: `function analysesBody(items: readonly { domain: string; markdown: string; createdAt: string }[]): string`

A `DOMAIN_TITLE` térkép és az `analysesBlock` a mai `page.ts`-ből költözik, változatlan szöveggel („Még nem futott mélyelemzés. Indítsd: `npm run analyze`").

- [ ] **Step 1: Teszt**

```ts
it("az Elemzés oldal dátumozza az elemzéseket", async () => {
  const a = await boot();
  // AnalysisRepo.save(row: Omit<AnalysisRow, "id">) — createdAt, domain,
  // markdown, summary és metrics mind kötelező.
  a.analyses.save({
    createdAt: "2026-09-01T07:08:45.487Z", domain: "physical",
    markdown: "### Fizikai\n- Magas.", summary: "Magas.", metrics: "{}",
  });
  const res = await a.server.inject({
    method: "GET", url: "/elemzes", headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  expect(res.body).toContain("2026-09-01");
  await a.close();
});

it("az Elemzés oldal megmondja, ha még nem futott elemzés", async () => {
  const a = await boot();
  const res = await a.server.inject({
    method: "GET", url: "/elemzes", headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  expect(res.body).toContain("Még nem futott mélyelemzés");
  await a.close();
});
```

- [ ] **Step 2: Futtasd** — FAIL: 404.
- [ ] **Step 3: Implementáció** — `analysesBody` az átemelt kóddal, útvonal a `routes/page.ts`-ben, `try`-jal körbevéve.
- [ ] **Step 4: Futtasd** — PASS.
- [ ] **Step 5: Ellenőrizd** — üresítsd ki az „üres" ág szövegét: a második teszt bukjon.
- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/analyses.ts src/delivery/http/routes/page.ts test/delivery/page.test.ts
git commit -m "$(printf 'feat: az Elemzés oldal\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 7: `view/ask.ts` és a `/kerdes` útvonal

**Files:**
- Create: `src/delivery/http/view/ask.ts`
- Modify: `src/delivery/http/routes/page.ts`
- Test: `test/delivery/page.test.ts`

**Interfaces:**
- Produces: `function askBody(data: { history: readonly Turn[]; chatAvailable: boolean }): string`, `const SCRIPT: string`

A kliens-script a mai `page.ts`-ből változatlanul költözik, a `.quiet` osztály `.halk`-ra cserélésével. A `POST /api/chat` érintetlen.

**Kritikus:** a következő négy sztringnek szó szerint meg kell maradnia, mert a meglévő tesztek rájuk támaszkodnak, és a tiltás pontosan ezeket a vezérlőket nevezi meg:

```
<input type="text" placeholder="Kérdezz valamit…">
<input type="text" placeholder="Kérdezz valamit…" disabled>
<button type="submit">
<button type="submit" disabled>
```

- [ ] **Step 1: Teszt**

```ts
it("a Kérdés oldal használható marad, ha a modell nem érhető el", async () => {
  const a = await boot();
  const res = await a.server.inject({
    method: "GET", url: "/kerdes", headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  expect(res.body).toContain(`<input type="text" placeholder="Kérdezz valamit…" disabled>`);
  expect(res.body).toContain(`<button type="submit" disabled>`);
  expect(res.body).toContain("nem érhető el");
  await a.close();
});
```

- [ ] **Step 2: Futtasd** — FAIL: 404.
- [ ] **Step 3: Implementáció.**
- [ ] **Step 4: Futtasd** — PASS.
- [ ] **Step 5: Ellenőrizd** — engedélyezd a mezőt feltétel nélkül: a teszt bukjon.
- [ ] **Step 6: Commit**

```bash
git add src/delivery/http/view/ask.ts src/delivery/http/routes/page.ts test/delivery/page.test.ts
git commit -m "$(printf 'feat: a Kérdés oldal\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 8: A régi `page.ts` megszüntetése és a hitelesítés lezárása

**Files:**
- Delete: `src/delivery/http/page.ts`
- Modify: `test/delivery/page.test.ts`
- Test: `test/delivery/page.test.ts`

- [ ] **Step 1: Írd meg a bukó tesztet**

```ts
it("mind a négy oldal token nélkül elutasít", async () => {
  // Az oldalak a briefinget, minden elemzést, a számokat és a teljes szálat
  // viszik. A 127.0.0.1 nem garancia: a deploy egy `tailscale serve`-öt
  // dokumentál, ami ezt az origint a teljes tailnetnek kiszolgálja.
  const a = await boot();
  for (const url of ["/", "/elemzes", "/szamok", "/kerdes"]) {
    const res = await a.server.inject({ method: "GET", url });
    expect(res.statusCode, url).toBe(401);
  }
  await a.close();
});

it("mind a négy oldal tokennel kiszolgál", async () => {
  const a = await boot();
  for (const url of ["/", "/elemzes", "/szamok", "/kerdes"]) {
    const res = await a.server.inject({
      method: "GET", url, headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode, url).toBe(200);
    expect(res.headers["content-type"], url).toContain("text/html");
  }
  await a.close();
});
```

- [ ] **Step 2: Futtasd** — `npx vitest run test/delivery/page.test.ts`; ha valamelyik útvonal nincs a `pageAuth` mögött, itt derül ki.
- [ ] **Step 3: Töröld a `page.ts`-t, és futtasd a typecheck-et**

Run: `npm run typecheck`
Expected: tiszta. Ha marad rá hivatkozás, a fordító megnevezi.

- [ ] **Step 4: A teljes csomag**

Run: `npm test`
Expected: minden zöld. A `renderPage`-re épülő régi tesztek helyét az oldalankénti tesztek vették át; a `describe("renderPage")` blokk megszűnik, de **minden állítása** megjelenik valamelyik új teszten — ellenőrizd egyesével a spec „Ellenőrzés" szakasza szerint.

- [ ] **Step 5: Kézi szemrevételezés**

```bash
npm run typecheck && npm test
```

Majd indítsd újra az ügynököt és nézd meg mind a négy oldalt böngészőben, sötét és világos sémában is:

```bash
launchctl kickstart -k gui/$(id -u)/local.jarvis.agent
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(printf 'refactor: a régi egyoldalas page.ts megszűnik\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```
