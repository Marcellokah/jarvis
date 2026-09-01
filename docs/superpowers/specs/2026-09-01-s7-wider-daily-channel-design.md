# S7 — A napi egészség-csatorna kiszélesítése

**Dátum:** 2026-09-01
**Állapot:** elfogadott, implementálásra vár
**Előzmény:** S2 (adatalap), S3 (aggregáció), S5 (kérdés-felület), S6 (proaktív értesítés) — mind a `main`-en

## Cél

A telefon ma hat mezőt küld; a napi sorban huszonnégy oszlop van, és a maradékot
csak a havi import tölti. Ez a munka kiszélesíti a csatornát, hogy ami *ma*
számít, ma is meglegyen — és felveszi azt a tíz mérést, amit az óra és a telefon
eddig is gyűjtött, csak soha nem olvastuk.

## Amit mérni kellett

**A napi hat mező nem a mezőszám miatt kevés, hanem mert a források kiszáradtak.**

| | napok | utolsó adat |
|---|---|---|
| Alvás (összes) | 384 | 2026-05-05 |
| Alvás: mély / REM | 206 / 155 | 2026-04-30 |
| Étrend (kcal, fehérje) | 73 | 2026-04-06 |
| VO2max | 648 | 2026-08-29 |

A tulajdonos újrakezdi az éjszakai óraviselést és a Yazióval az étkezés-naplózást,
tehát mindkét forrás visszatér. **Ez a munka arra készül fel, amit használni fog,
nem a mai száraz állapotra.**

**És van tíz mérés, ami folyamatosan gyűlik, csak nem olvassuk.** Az exportból,
típusonkénti dátumtartománnyal:

| Típus | Rekordok | Meddig |
|---|---|---|
| `DistanceWalkingRunning` | 250 063 | **2019-02-13** → ma |
| `WalkingSpeed` | 53 523 | 2021 → ma |
| `WalkingStepLength` | 53 522 | 2021 → ma |
| `WalkingDoubleSupportPercentage` | 49 559 | 2021 → ma |
| `WalkingAsymmetryPercentage` | 30 669 | 2021 → ma |
| `AppleStandTime` | 67 167 | 2022 → ma |
| `StairAscentSpeed` / `StairDescentSpeed` | 3 615 / 3 446 | 2022 → ma |
| `AppleWalkingSteadiness` | 251 | 2021 → ma |
| `SixMinuteWalkTestDistance` | 207 | 2022 → ma |

Ezekhez **nem kell szokás**: passzívan keletkeznek. A távolság ráadásul a
leghosszabb folytonos sorozat a lépésszám után — hét és fél év.

## Felépítés

### 1. Egy útvonal, két forrás

**A telefon nem kiszámolt alvás-órát küld, hanem nyers mintákat**, ugyanabban az
alakban, amit az export-olvasó ad:

```ts
{ type, value, unit, startDate, endDate, source }
```

A szerver ezeket ugyanazon a `rollup()`-on futtatja át, ami az importot is
feldolgozza. A telefon ettől **még egy termelő ugyanabban a folyamban**.

Ez nem elegancia, hanem szükség. Az óra fázisonként külön mintát ír, tehát egy
éjszaka sok mintából áll, és Shortcutban nincs mód összegezni őket: a
`Calculate Statistics` a minták *értékén* dolgozik, alvásnál viszont az érték a
fázis neve, nem időtartam. A jelenlegi „vedd a legutóbbi mintát" megoldás egy
hétórás éjszakára **0,3 órát** adna — nem hiányzó adat, hanem magabiztosan rossz.

A közös útvonal ingyen hozza azt is, amit az S3-ban építettünk: az **átfedő
források feloldását** (a tulajdonos adataiban 1 573 napon versengtek források), a
fázisok **végződési napra** könyvelését, és hogy egy ébredést két forrásból is
egynek számol.

### 2. Két határátalakító, mert a telefon máshogy beszél

**A dátum alakja.** Az export nem ISO 8601: `'2026-03-01 23:10:00 +0100'`. A
Shortcut ISO-t ad. Egy tiszta függvény alakítja át a határon; a `rollup` és a
`parseAppleDate` **változatlan marad**, mert az import helyessége nem függhet
attól, hogy a telefon útvonala bővül.

**A fázisok neve.** Az export `HKCategoryValueSleepAnalysisAsleepDeep`-et ír; a
Shortcut a Health app megjelenített nevét adja (`Deep`, `REM`, `Core`, `Awake`,
`In Bed`). A szerver **mindkettőt elfogadja**.

> Az pontos megjelenített neveket nem tudtuk lemérni — ehhez egy olyan éjszaka
> kellene, amiről már van fázisokra bontott adat. Ezért a leképezés **liberális
> abban, amit elfogad, és hangos abban, amit nem ért**: egy fel nem ismert
> fázisnév a válasz `ignored` tömbjébe kerül, névvel együtt. Így az első valódi
> futáskor kiderül, ahelyett hogy csendben elveszne.

### 3. Tíz új oszlop, és az import is feltölti őket

Új migráció, `008_mobility.sql`:

| Oszlop | Forrás | Összegzés | Egység |
|---|---|---|---|
| `distance_km` | `DistanceWalkingRunning` | sum | km |
| `stand_min` | `AppleStandTime` | sum | min |
| `walking_speed` | `WalkingSpeed` | avg | km/hr |
| `step_length_cm` | `WalkingStepLength` | avg | cm |
| `double_support_pct` | `WalkingDoubleSupportPercentage` | avg | % |
| `asymmetry_pct` | `WalkingAsymmetryPercentage` | avg | % |
| `steadiness_pct` | `AppleWalkingSteadiness` | avg | % |
| `six_min_walk_m` | `SixMinuteWalkTestDistance` | avg | m |
| `stair_up_ms` | `StairAscentSpeed` | avg | m/s |
| `stair_down_ms` | `StairDescentSpeed` | avg | m/s |

Az egységek mértek, nem feltételezettek — az S3 egység-ellenőrzése egy eltérésnél
az egész oszlopot eldobja, ezért a valódi exportból vettük őket.

**Az összegzés módja köti a Shortcutot is.** Egy oszlopot két forrás tölt, és ha
másképp számolnák, ugyanabban a mezőben két különböző jelentés keveredne — a
`fillGaps` miatt ráadásul csendben, mert amelyik előbb ír, az marad. Ezért a
telefon **ugyanazt a műveletet végzi, mint az import**: a `sum` oszlopokra
`Calculate Statistics → Sum`, az `avg` oszlopokra `→ Average`, a nap összes
mintáján — nem pedig „a legutóbbi minta", ahogy a mai Shortcut teszi. Ez a mai
`hrv` és `rhr` mezőre is vonatkozik: ott az egyetlen napi mintán az átlag
ugyanaz, tehát a váltás nem ront, csak egységesít.

**A `DAILY` térkép is megkapja mind a tízet**, tehát a következő import
visszamenőleg feltölti a történetet. A távolságnál ez 2019 februárjáig ér vissza.

### 4. Az ingest kiszélesítése

A `READING` térkép hatról az összes számmezőre bővül, tartományokkal együtt. A
nulla kérdése **mezőnként** dől el, nem szabályként:

**Nulla = nincs mérés** — `dietKcal` és a makrók, `vo2max`, `hrRecovery`,
`walkingHr`, `basalKcal`, `walkingSpeed`, `stepLengthCm`, `doubleSupportPct`,
`asymmetryPct`, `steadinessPct`, `sixMinWalkM`, `stairUpMs`, `stairDownMs`.
Senki nem eszik nulla kalóriát és nem jár nulla sebességgel.

**Nulla = valódi érték** — `steps`, `moveKcal`, `exerciseMin`, `flights`,
`distanceKm`, `standMin`.

**Az alvás oszlopai egyik listán sincsenek**, és ez szándékos: azok nem közvetlen
mezőként érkeznek, hanem a nyers mintákból számolja őket a `rollup`. Ott a
kérdés fel sem merül — egy hiányzó fázisból nem lesz nulla perc, hanem nem lesz
sor. Az `awakenings` ugyanígy: a nulla ébredés ott azt jelenti, hogy nem volt
ilyen minta, nem azt, hogy hiányzik az adat.

Az S5 óta érvényes szabály marad: **egy rossz mező nem viszi el a többit**, és a
válasz megnevezi, mit dobott el.

### 5. Két kérés: a mai pillanat és a tegnapi összeg

Nem az étkezés a kivétel — **minden halmozódó napi összeg** csak a nap végén
teljes. Reggel fél nyolckor a lépésszám nagyjából kétezer, a napi valóság pedig
tizenegyezer.

És ez nem csak pontatlan lenne, hanem **javíthatatlan**. A két írási útvonal
ellentétes precedenciájú, szándékosan:

```
upsert   (telefon):  COALESCE(excluded.x,           health_snapshots.x)  → a beérkező nyer
fillGaps (import):   COALESCE(health_snapshots.col, excluded.col)        → a meglévő nyer
```

A telefon reggel beírná a kétezret, és az import **soha nem tudná javítani**. A
nap véglegesen kétezer lépéssel maradna rögzítve — magabiztosan rossz adat, amit
mi magunk gyártanánk.

Ezért a mezők aszerint válnak szét, hogy **mikor teljesek**:

**A mai napra, a reggeli kéréssel** — pillanatnyi és éjszakai mérések, amiknek
reggel már van végleges értékük: `hrv`, `rhr`, az alvás nyers mintái, `vo2max`,
`hrRecovery`, `walkingHr`, `steadinessPct` és `sixMinWalkM`. Ez utóbbi kettő is
periodikus becslés, amit az óra egészben számol ki — nem a nap során gyűlik.

**A tegnapi napra, egy második kéréssel** — halmozódó összegek: `steps`,
`distanceKm`, `moveKcal`, `basalKcal`, `exerciseMin`, `flights`, `standMin`,
`dietKcal` és a makrók — **valamint a járás-metrikák napi átlagai**
(`walkingSpeed`, `stepLengthCm`, `doubleSupportPct`, `asymmetryPct`,
`stairUpMs`, `stairDownMs`).

Az átlag ugyanolyan részleges, mint az összeg: a `DAILY` ezt a hatot `agg:
"avg"`-gel a nap **összes** mintájára számolja, tehát egy fél nyolckor küldött
átlag pár száz lépésé — csak nem néz ki hiányosnak, mint egy részösszeg, hanem
hihetőnek, és `upsert`-tel beírva ugyanúgy véglegesen rögzülne az import elől.

A végpont **már most elfogad explicit `date` mezőt**, úgyhogy szerver-oldalon
ehhez semmit nem kell átírni — csak a Shortcut küld kettőt.

> A mai napi összegek így egy nappal késve érkeznek. Ez helyes csere: a brief a
> mai *állapotról* beszél — alvás, regeneráció, készenlét —, amihez a pillanatnyi
> mérések kellenek. A tegnapi teljes lépésszám többet ér, mint a mai fél.

Ettől záródik be egy hurok, ami eddig nyitva volt: a rendszer kiszámolja a napi
fehérje-célt az étrendtervből, ki is írja a briefbe — és **soha semmi nem mérte
hozzá, mennyi lett belőle.** A tegnapi étkezés a tegnapi tervhez mérhető.

### 6. Szokás-őrzés az S6-ban

Két új jelölt a proaktív értesítésben: ha három napja nincs alvás-adat, vagy
három napja nincs étkezés-adat, szól. Ugyanaz a küszöb-, kapu- és
ismétlés-szűrő gépezet, mint minden másnál.

**Az adathiány maga lesz megállapítás, nem csend.** Épp ez hiányzott: az alvás
négy, az étkezés öt hónapja állt le, és soha semmi nem jelezte.

## Hibakezelés

- **A nyers-minta útvonal a meglévő `fillGaps`-szel ír**, ami csak lyukat tölt.
  Ma ez pontosan jó, mert még nincs import-adat a mai napra — de ha a Shortcut
  kétszer fut egy nap, a második nem javítja felül az elsőt. Ez illeszkedik ahhoz,
  ahogy a rendszer mindenhol máshol viselkedik, és inkább ezt választjuk, mint
  egy kivételt.
- **A halmozódó mezők a tegnapi napra mennek, és ez nem ízlés kérdése.** Egy
  reggel elküldött részösszeg a `fillGaps` precedenciája miatt véglegesen
  rögzülne, és az import nem tudná javítani. A szétválasztás nem finomítás,
  hanem az egyetlen mód, hogy ne mi magunk gyártsunk hamis napokat.
- **Egy fel nem ismert minta-típus vagy fázisnév nem hiba, hanem jelentés.** A
  válasz `ignored` tömbjébe kerül, és a kérés többi része feldolgozódik.
- **A `rollup` hibája nem viszi el a mezők útvonalát**: a nyers minták és a
  közvetlen mezők egymástól függetlenül dolgozódnak fel, és a válasz mindkettőről
  külön számol be.

## Tesztelés

- Az ISO → Apple dátumalak átalakító tiszta, tehát kimerítően tesztelhető,
  nyári és téli időszámítással is.
- A fázisnév-leképezés mindkét irányban: `HKCategoryValue…` és megjelenített
  név, plusz **kötelező eset**, hogy egy ismeretlen név az `ignored`-ba kerül és
  nem tűnik el.
- **Kötelező eset:** egy éjszaka több fázis-mintából a `rollup`-on át helyes
  `asleep_min`, `deep_min`, `rem_min` és `awakenings` értéket ad — ugyanazokat,
  amiket ugyanabból az importból kapna.
- A nulla-szabály mezőnként, mindkét oldalról: ami abszensnek számít, eldobódik;
  ami valódi nulla, átmegy.
- Az új oszlopok egységei: eltérő egység az egész oszlopot eldobja, és ezt kiírja.

## Amit az S7 nem csinál

- **Nem változtatja meg a `rollup`-ot és a `parseAppleDate`-et.** Az import
  helyessége nem függhet attól, hogy a telefon útvonala bővül.
- **Nem vezet be testsúlymérést.** Eldöntött: a fejlődést terhelésből és
  fittségből olvassuk.
- **Nem veszi fel a futó- és kerékpár-metrikákat.** Négy év alatt 18 futás, a
  kerékpár 2025 októberében abbamaradt.
- **Nem generálja a Shortcutot** — az a következő lépés, és csak akkor
  véglegesíthető, ha a szerver már tudja, mit fogad. A formátum visszafejtése
  megvan: `docs/ios-shortcut-format.md`.
