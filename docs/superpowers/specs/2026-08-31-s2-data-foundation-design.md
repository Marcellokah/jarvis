# S2 — Adatalap

**Dátum:** 2026-08-31
**Állapot:** jóváhagyott terv, implementáció előtt
**Előzmény:** a hat alrendszerből a második. Az S1+S4 (leépítés és Groq) kész.

## Miért

A rendszer ma **két sort** tárol a `health_snapshots` táblában, és az előfizetéseket
csak jelen állapotként ismeri. Elemzést kérni tőle olyan, mintha egy naplóból
akarnánk trendet olvasni, amiben két bejegyzés van.

Az Apple Health teljes exportja viszont **hét és fél év adatát** tartalmazza. Egy
importtal a történet azonnal megvan — nem hónapok múlva.

Ez az alrendszer **nem tartalmaz LLM-et.** A modell csak azt tudja értelmezni, ami
a promptjában van; ez a munka teremti meg, hogy legyen mit odaadni neki.

## A mérés, ami a terv alapja

A felhasználó exportját végigolvastuk (2026-08-31):

| | |
|---|---|
| Nyers rekordok | **2 400 520** |
| Típusok | 47 |
| Időtartomány | **2019-02-13 .. 2026-08-31** |
| Kicsomagolt `export.xml` | 1054 MB (zip: 90 MB) |
| **Streaming végigolvasás** | **9 másodperc** |
| Edzések | 2 390, ebből 641 erősítő |

Két megállapítás közvetlenül alakította a tervet:

- **A 9 másodperces újraolvasás miatt nem kell nyers mintákat tárolni.** Ha egy
  későbbi kérdéshez mégis kellenének, újraimportálunk más összesítéssel. A
  döntés visszafordítható, ezért a legegyszerűbbet választjuk.
- **Testsúly-történet nincs:** `BodyMass` **6 rekord** hét év alatt, `Height` és
  `BodyMassIndex` egy-egy. A „fizikai fejlődés" tehát nem súlyból mérhető, hanem
  edzésterhelésből és keringési fittségből — abból viszont négy és fél év van.

## Az import

```bash
npm run import-health -- ~/Downloads/export.zip
```

Explicit útvonal, nincs mappafigyelés: a rendszer kézzel indított eszköz.

- A zipből **streamelve** olvasunk, kicsomagolás nélkül.
- **Nincs új futásidejű függőség.** Az `export.xml` szabályos (`<Record type=…
  startDate=… value=…/>`), ezért célzott olvasó dolgozza fel, nem általános
  XML-parser.
- **Idempotens:** ugyanaz a zip kétszer futtatva ugyanazt az állapotot adja. Ez
  nem kényelmi kérdés — havonta újraexportálsz, és az új zip a régit is
  tartalmazza.
- Az import a végén jelenti, mit tett: hány nap, hány edzés, mely metrikák,
  milyen időtartomány, és mit hagyott ki.

## Amit eltárolunk

### Napi összesítés — `health_snapshots` bővítése

Marad a napi egy sor, dátum kulccsal. A meglévő hat mező mellé:

| Terület | Mezők |
|---|---|
| Alvás | `asleep_min`, `in_bed_min`, `core_min`, `rem_min`, `deep_min`, `awakenings` |
| Keringés | `vo2max`, `hr_recovery`, `walking_hr` |
| Étkezés | `diet_kcal`, `diet_protein_g`, `diet_carbs_g`, `diet_fat_g` |
| Terhelés | `basal_kcal`, `flights` |

A meglévő `sleep_h` marad a brief kompatibilitása miatt, és az `asleep_min`-ből
származik.

**Az alvás a felébredés napjához tartozik.** Egy éjszaka átnyúlik éjfélen; a
briefnek „a tegnap éjszakai alvás" kell. A szakasz **záró** dátuma dönt.

Az alvás percei a `AsleepCore` + `AsleepREM` + `AsleepDeep` + `AsleepUnspecified`
szakaszok összege; az `InBed` külön; az `awakenings` az `Awake` szakaszok száma.

### Edzések — új `workouts` tábla

Napi több edzés is lehet, ezért nem fér a napi sorba:
`id`, `date`, `type`, `started_at`, `duration_min`, `energy_kcal`.

### Előfizetések — új `subscription_months` tábla

Havi pillanatkép, append-only: `month` (YYYY-MM), `name`, `amount_huf`, `cycle`,
`active`, `recorded_at`. Kulcs: `(month, name)`.

Minden brief-generáláskor rögzíti az aktuális hónap állapotát. Ugyanarra a
hónapra futtatva felülírja — a hónap végi állapot marad meg.

## Ütközés a napi Shortcuttal

Az import 2750 napot ír; a Shortcut a mait. A mai sor **most is tartalmaz** friss
HRV-t és nyugalmi pulzust, amit a telefon küldött.

**Szabály: az import soha nem ír felül létező mérést — csak hiányzó mezőt tölt ki.**

Ez provenance-nyilvántartás nélkül működik: a feltétel egyszerűen az, hogy a mező
`NULL`. Így egy újraimport nem törli a ma reggeli adatot, és a két forrás nem
versenyez egymással.

## Egy őszinte korlát

Az egészség-történet hét éve megvan. **A pénzügyiből ma van az első nap.**

A `subscriptions` tábla soha nem tárolt előzményt, tehát az első értelmes hó/hó
összehasonlítás egy hónap múlva jön. Ezen nem lehet segíteni: az adat nem
létezik.

**Rekonstrukciót nem csinálunk.** A `next_renewal` és a `cycle` mezőkből
visszaszámolható lenne, mikor voltak korábbi megújulások — de csak azzal a
feltevéssel, hogy az ár sosem változott. Az becslés lenne, nem mérés, és ez a
projekt következetesen a mérhetőt méri: inkább mondja azt, hogy „ehhez még nincs
adat", mint hogy egy feltevést tényként adjon tovább. Ha később mégis kell,
külön, jelölten kerül be.

## Mi válik azonnal lehetővé

Az import után az S3 aggregációs réteg ezekkel dolgozhat:

- **Négy és fél év edzésterhelés** — 641 erősítő edzés, gyakoriság és volumen
- **VO2Max, nyugalmi pulzus és pulzus-visszatérés 2022 óta** — keringési fittség
- **Két hónap sűrű alvásadat** (2026 március–április), szakaszokra bontva, és a
  szakadék utána
- **Hét hónap étkezési napló** (2025-09 .. 2026-04), amivel a fehérje-célok
  teljesülése visszamérhető

Érdemes látni a mintázatot: az alvás és az étkezés is **sűrű néhány hónapig,
aztán abbamarad**. Ez maga is olyasmi, amit az elemzésnek látnia kell — nem
adathiba, hanem a valóság.

## Tesztelés

Hálózat nélkül, a meglévő minta szerint.

Egy néhány száz soros, **kézzel írt** `export.xml` fixture a `test/fixtures/`-be.
Az igazi 1 GB-os fájl soha nem kerül tesztbe. A fixture tartalmazza:

- éjfélen átnyúló alvást, hogy a záró-dátum szabály bizonyítható legyen
- átfedő alvás-szakaszokat
- ugyanazt a rekordot kétszer (idempotencia)
- olyan napot, ahol csak némelyik mező van meg
- ismeretlen típusokat, amiket ki kell hagyni
- egy napot, ahol a Shortcut adata már megvan — a felülírás-tilalom bizonyítására

## Amit ez a spec nem fed

- **Az aggregációs réteg** (S3): gördülő átlagok, eltérések, trendek. A
  `baseline()` metódus létezik, és soha senki nem hívta meg.
- **A kérdés-felület** (S5) és a **proaktív értesítés** (S6).
- **A napi Shortcut bővítése** további metrikákra. Az import adja a szélességet
  és a múltat; hogy a napi frissítés mely mezőkre terjedjen ki, azt az S3 után
  érdemes eldönteni — akkor derül ki, mely metrikák érnek napi frissítést.
- **Testsúly-mérés bevezetése.** Eldöntött: a fejlődést a mért terhelésből és
  fittségből olvassuk, nem súlyból.
