# S3 — Aggregációs réteg és mélyelemzés

**Dátum:** 2026-09-01
**Állapot:** elfogadott, implementálásra vár
**Előzmény:** S1+S4 (Groq-szintézis), S2 (adatalap) — mindkettő a `main`-en

## Cél

Az S2 után a rendszernek először van múltja: 2 715 nap, 2 390 edzés, 2019-től.
Ezt jelenleg **semmi nem olvassa**. Az S3 ebből csinál rövid- és hosszútávú
diagnosztikát: kézzel indítva, területenként külön, a korábbi megállapításait
megjegyezve.

A napi brief nem változik. Az elemzés külön termék, külön parancs.

## Amit az adat elbír

Ez nem háttérinfó, hanem a terv alapja. Mérve, a valódi adatbázisból:

| | 2019–21 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|
| Lépés | teljes | teljes | teljes | teljes | teljes | teljes |
| HRV / nyugalmi pulzus | – | ~300 | ~300 | ~270 | ~280 | 225 |
| Alvás | – | 217 | 85 | 19 | 22 | 41 |
| VO2max | – | 144 | 171 | 101 | 131 | 101 |
| Étkezés | – | – | – | – | 50 | 23 |
| Edzés (óra) | – | 349 | 401 | 322 | 351 | 196* |

\* 2026 augusztus végéig.

Három következtetés, amit a terv magára vesz:

1. **A lépésszám az egyetlen hiánytalan sorozat.** Hét és fél év, minden nap.
   Ahol hosszútávú trendet lehet mondani, ott ez az alap.
2. **Az alvás ritka, és egyre ritkább.** 2022-ben 217 nap, 2024-ben 19. Ez nem
   adathiba: nincs óra éjszaka. Bármely alvásra vonatkozó állítás mellé
   kötelező a lefedettség, különben 19 napból mondanánk véleményt egy évről.
3. **A pénzügyi történet ma egyetlen hónap.** A `subscription_months` az S2-ben
   született, előtte nincs semmi, és szándékosan nem gyártunk visszamenőleg. Az
   első hónapokban az elemzés helyes válasza az, hogy még nincs mit összevetni.

Egy megállapítás, ami már most kijött a nyers adatból, és jól mutatja, mire megy
ki a játék — négy éve közel állandó edzésterhelés mellett:

```
2026-04   VO2max 40,0   nyugalmi pulzus 57,5
2026-08   VO2max 37,9   nyugalmi pulzus 67,8
```

## Felépítés

Két fél, éles határral. Ez a terv legfontosabb döntése.

### 1. Aggregációs réteg — tiszta kód

`src/core/analysis/aggregate.ts`. Bemenet: a repók sorai. Kimenet: egy
`Metrics` szerkezet. **LLM nincs benne, hálózat nincs benne, véletlen nincs
benne** — ugyanaz a bemenet mindig ugyanazt adja, és fixtúrákkal tesztelhető.

Egy nyelvi modell 2 715 napon fejben rosszul átlagol. A számokat ezért kód
számolja; az LLM azt kapja, ami már ki van számolva.

Minden metrika mellett kötelezően utazik:

- `n` — hány napból számolt
- `coverage` — `n` osztva az ablak hosszával
- `window` — az ablak megnevezése

Egy metrika, aminek nincs elég adata, **nem nulla és nem becslés, hanem
hiányzik** — a mező `null`, és a lefedettség megmondja, miért. Ez ugyanaz a
szabály, amit az S2 az importban követett.

**Származtatott mennyiségek, pontos definícióval:**

- *Gördülő átlag* — 7 / 28 / 90 / 365 napos ablakok, a hiányzó napok kihagyva
  (nem nullának véve).
- *Eltérés az alaptól* — az aktuális 7 napos átlag és a 90 napos átlag
  különbsége, a 90 napos szórás egységében kifejezve.
- *Trend* — legkisebb négyzetes meredekség az ablakon, **30 napra vetítve**,
  hogy olvasható legyen ("−0,7 VO2max / hónap").
- *Terhelési arány* — a 28 napos napi átlagos edzésperc osztva a 365 napossal.
  Bevett mérőszám; 1 körül állandó terhelés, jóval alatta leépülés.

### 2. Szakaszos elemzés

`src/core/analysis/analyst.ts`. Négy Groq-hívás, sorban:

1. **Fizikai fejlődés** — edzésterhelés és keringési fittség
2. **Regenerálódás** — HRV, alvás, ébredések
3. **Pénzügy** — havi előfizetés-összeg és változásai
4. **Összegzés** — a fenti három eredménye és a *kiszámolt* összefüggések

Az első három egymástól függetlenül fut, mindegyik megkapja a saját területe
statisztikáit **és a saját területe legutóbbi három megállapítását**. Ettől tud
folytonos lenni: „harmadik hónapja jelzem", és ugyanígy azt is, hogy egy
korábbi aggodalma azóta megszűnt.

### Összefüggések — zárt lista

A negyedik hívás nem asszociál szabadon. Kizárólag olyan kapcsolatról írhat,
amit az aggregációs réteg **kiszámolt**, és a mintaszámot minden esetben ki kell
tennie.

A számolt párok — bővíteni kódmódosítás, és ez szándékos:

| Pár | Ablak |
|---|---|
| 28 napos edzésterhelés ↔ nyugalmi pulzus | 365 nap |
| 28 napos edzésterhelés ↔ HRV | 365 nap |
| HRV ↔ alváshossz | teljes átfedés |
| Lépésszám ↔ nyugalmi pulzus | 365 nap |

Pearson-korreláció azokon a napokon, ahol mindkét érték megvan.
**`n < 30` esetén a pár egyáltalán nem kerül a promptba** — nem gyenge
korrelációként, hanem sehogy.

Ennek oka egy mondatban: 2 715 nap és tucatnyi metrika mellett egy nyelvi modell
mindig talál mintázatot, akkor is, ha nincs. A projekt alapelve — a hiányzó adat
jobb a magabiztosan rossznál — itt a legsérülékenyebb, ezért itt a legszigorúbb
a korlát.

## Token-keret

A Groq ingyenes szintje **6 000 token/perc**. Célzott hívásonként: legfeljebb
~2 500 token bemenet (statisztikák + három korábbi összegzés, ~450 token) és ~1 200
kimenet, tehát ~3 700. Két hívás egy percen belül átlépné a keretet, ezért a
hívások között **várakozás** van, konfigurálható értékkel (alapértelmezés
60 másodperc). Négy hívás így nagyjából három perc.

A várakozás nem kellemetlenség, hanem az ára annak, hogy minden terület a teljes
keretet kapja magára ahelyett, hogy negyedelnénk.

## Tárolás — ez a memória

Új migráció, `006_analyses.sql`:

```sql
CREATE TABLE IF NOT EXISTS analyses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  domain     TEXT NOT NULL,      -- 'physical' | 'recovery' | 'finance' | 'synthesis'
  markdown   TEXT NOT NULL,      -- a teljes szöveg, amit az LLM írt
  summary    TEXT NOT NULL,      -- egy bekezdés, ezt látja a következő futás
  metrics    TEXT NOT NULL       -- a bemenet, JSON-ként
);
CREATE INDEX IF NOT EXISTS analyses_domain_time ON analyses (domain, created_at DESC);
```

A `metrics` azért kerül el, hogy egy régi megállapításról később eldönthető
legyen, milyen számokból született. Enélkül a memória csak állítások halmaza
lenne, ellenőrzés nélkül.

**A `summary` külön oszlop, és nem kényelmi másolat — a token-keret kényszeríti
ki.** Három teljes korábbi riport nagyjából 3 600 token, ami a statisztikák
mellett szétfeszítené a hívás saját keretét. Ezért minden területi válasz utolsó
blokkja egy rögzített című, egy bekezdésnyi összegzés, és **a memória ezeket az
összegzéseket adja vissza, nem a teljes riportokat** — három darab nagyjából
450 token.

Ha egy válaszból hiányzik az összegző blokk, a riport szövege attól még
használható és eltárolódik; a `summary` ilyenkor a markdown első bekezdése, és a
futás ezt naplózza. A memória romlása nem érhet fel odáig, hogy elveszítsük a
kész elemzést.

Repó: `src/infra/db/repositories/analyses.ts` — `save`, `recent(domain, n)`,
`latestRun()`.

## Hibakezelés

Ugyanaz a gerinc, mint a briefnél a template:

- **Területenként külön bukik.** Ha a pénzügyi hívás elszáll, a fizikai és a
  regenerálódási megállapítás megmarad, és a riport kiírja, melyik terület miért
  maradt el. Nem hallgat róla.
- **Ha a Groq teljesen elérhetetlen, a számok akkor is kiíródnak.** Az
  aggregáció a tartós termék, a próza a kommentár. Egy táblázat gördülő
  átlagokkal önmagában is használható; ez a réteg soha nem függ hálózattól.
- **Az összegző hívás kimarad, ha kettőnél kevesebb terület sikerült** — egyetlen
  terület fölött nincs mit összefüggésbe hozni.

## Kimenet

`npm run analyze` — markdown a terminálra, és minden szakasz elmentve az
`analyses` táblába. A parancs ugyanazt a tartósság-ellenőrzést végzi, amit az
`import-health` tanult: ha másik folyamat fogja az adatbázist, előre szól.

## Tesztelés

- **`aggregate.ts` tiszta**, tehát a teszt súlypontja itt van: ismert napsorozat
  → ismert gördülő átlag, meredekség, lefedettség, korreláció. A számokat a
  fixtúrából kell levezetni, nem egy futásból kimásolni.
- **Az elemző a meglévő `fixtureFetcher`-rel** tesztelhető, hálózat nélkül:
  rögzített Groq-válaszok, és annak ellenőrzése, hogy egy terület bukása nem
  viszi magával a többit.
- **Kötelező eset:** `n < 30` korreláció nem jelenik meg a promptban. Ezt
  bizonyítani kell, mert ez a szigor legfontosabb pontja.
- **Kötelező eset:** hiányzó metrika `null`-ként, nem nullaként megy tovább.

## Amit az S3 nem csinál

- Nem nyúl a napi briefhez és a modulokhoz.
- Nem küld Telegramot — az az S6.
- Nem épít felületet — az az S5.
- Nem gyárt visszamenőleges pénzügyi történetet.
- Nem vezet be testsúlymérést. Eldöntött: a fejlődést terhelésből és
  fittségből olvassuk.

## Szükséges kiegészítés a meglévő kódban

A `HealthRepo`-nak ma nincs tartomány-lekérdezése: `baseline(date, days)` a
*legutóbbi N nap*, ami ablakokhoz jó, tartományhoz nem. Az S3-hoz kell egy
`between(from, to): HealthSnapshot[]`, a `WorkoutRepo.between` mintájára. Ez a
munka része, nem külön feladat.

## Konfiguráció

A `config/config.ts`-be új blokk:

```ts
analysis: {
  model: "qwen/qwen3.8-27b",   // ugyanaz, ami a briefnél bevált
  maxTokens: 1_200,
  temperature: 0.3,
  timeoutMs: 60_000,
  /** Várakozás két hívás között, a 6 000 token/perc keret miatt. */
  paceMs: 60_000,
  /** Hány korábbi megállapítást lát egy terület. */
  memoryDepth: 3,
  /** Ennél kevesebb közös nap alatt a korreláció nem kerül a promptba. */
  minCorrelationN: 30,
},
```
