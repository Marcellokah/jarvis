# F3 — Területi oldalak

**Állapot:** jóváhagyva 2026-09-03. Az öt részből álló front-end kiépítés
harmadik darabja (F1 váz ✓ · F2 diagram-alapkészlet ✓ · **F3 területi oldalak**
· F4 írás · F5 elemzés és beszélgetés).

## Miért

Az F1 keretet adott, az F2 diagramot. Az adatbázisban viszont máig van négy
halmaz, amit a felület egyáltalán nem mutat:

| Adat | Mennyiség | Időtartomány |
|---|---|---|
| Edzések | 2392 alkalom, 12 típus, ~1620 óra | 2022-02-16 → 2026-09-01 |
| Előfizetések | 5 aktív + 10 rögzített hónapsor | 64 860 Ft/hó |
| Heti étrend | 21 sor (7 nap × 3 étkezés), kiolvasztási idővel | — |
| Bevitel | 74 mért nap | 2025-09-16 → 2026-09-01 |

A 2392 edzés a legnagyobb kihagyott halmaz: négy és fél év, és semmi sem
mutatja. Az `/elemzes` közben négy elemzést sorol egymás alá, elszakítva attól
az adattól, amiről szólnak — a „terhelés 1,41-szerese az éves átlagnak"
mondat mellett nem áll ott sem a havi bontás, sem egyetlen edzés.

**F3 nem vezet be új adatot.** Csak azt rendezi területre, ami ma is az
adatbázisban van, és ott mutatja meg, ahol értelme van.

## Hatókör

**Beletartozik:** hat új útvonal, egy második diagram-primitív (havi
oszlopdiagram), az `/elemzes` feloldása, két új lekérdezés a
`WorkoutRepo`-ban, és a `PageDeps.metricsRows` cseréje nyers `Metrics`-re.

**Nem tartozik bele:** minden írási művelet — a teendők kipipálása, a
javaslatok elfogadása, előfizetés szerkesztése (F4); az elemzések
előzményének böngészése és az újratöltés nélküli chat (F5); a táplálkozási
mélyelemzés (S8, a backend oldalán).

## Útvonalak

```
/                          Ma                       (változatlan)
/terulet                   hub: Összegzés + négy kártya
/terulet/terheles          Terhelés
/terulet/terheles/naplo    a teljes edzésnapló, lapozva
/terulet/regeneracio       Regeneráció
/terulet/taplalkozas       Táplálkozás
/terulet/penzugy           Pénzügy
/szamok                    Számok                   (változatlan)
/szamok/:metrika           mérés-részlet            (változatlan)
/kerdes                    Kérdés                   (változatlan)
/elemzes                   MEGSZŰNIK
```

Mind az F1 `pageAuth`-ja mögött, változatlanul. Szerver-oldali oldalak,
kliens-oldali keretrendszer nélkül — ahogy az F1 óta.

Az `/elemzes` azért szűnik meg, és nem azért marad, mert a tartalma
szétosztható arra a négy helyre, ahol az adata van. A `synthesis` elemzés a
hubra kerül, a `physical`, `recovery` és `finance` a saját területére. Egy
elemzés két helyen ismételve nem lenne több információ, csak több felület.

### Navigáció

A menü **négy elem marad** — Ma · Terület · Számok · Kérdés. Ez nem esztétikai
döntés: telefonon alsó sor a navigáció (F1), és hét-nyolc elem ott elemenként
~14% szélesség, vágott címkékkel. A négy terület a `/terulet` lapról érhető el,
ami nem üres átkattintó: az Összegzés elemzést és négy élő kártyát visz.

Asztalon (≥ 46rem) az oldalsáv a Terület alatt behúzva sorolja a négy
területet, de **csak akkor, ha a `terulet` szekcióban vagyunk** — a Ma, a
Számok és a Kérdés oldalán a menü ugyanaz a négy elem, mint ma. Telefonon
nincs almenü egyáltalán: az alsó sor négy eleme marad, és a hub a belépő.

**A Terület jelzője akkor él, ha a legfrissebb elemzés legfeljebb 7 napos.**

Az F1 szabálya, hogy egy jelző, ami nem tud kikapcsolni, dekoráció. A régi
`/elemzes` jelzője („van legalább egy elemzés") pontosan ilyen volt: az első
elemzés után soha többé nem aludt ki. Az elemzés kézzel indul
(`npm run analyze`), tehát az elavulása valódi és cselekvésre hívó állapot. A
7 nap azért ez: az elemzés 28 napos ablakokban számol, és egy hét alatt az
ablak negyede kicserélődik — onnantól a leírt kép már nem a mai.

`Section` ennek megfelelően `"ma" | "terulet" | "szamok" | "kerdes"`. A négy
területi oldal és a napló mind `terulet` szekció: a menü aktív eleme
mindegyiken a Terület.

## Minden területi oldal ugyanaz a négy sáv

Ugyanaz a szerkezet mind a négyen, mert a felületet minden nap ugyanaz az
ember nézi, és a keresés helye ne változzon oldalanként:

1. **Vezető szám** — az az egy adat, ami megmondja, hogy áll a terület, a
   viszonyítási alapjával együtt. Mono betű, nagy méret.
2. **Diagramok** — a terület sorozatai az F2 készletéből, sparkline-nal és a
   `/szamok/:metrika` részletoldalra mutató linkkel.
3. **A terület saját tartalma** — amit sehol máshol nem lehet megnézni.
4. **Elemzés** — a domain legutóbbi elemzése a dátumával, az `/elemzes`-ről
   ideköltözve.

A vezető szám hiányzó értéke ugyanaz a szabály, mint mindenütt: nem nulla,
hanem a hiány kimondva, `--halvany` színnel, animáció nélkül.

## A hub — `/terulet`

**Összegzés:** a `synthesis` domain legutóbbi elemzése, markdownnal
renderelve, a dátumával. Ha nincs, a sáv elmarad — nem üres címmel.

**Négy kártya**, mindegyik a saját területére linkel:

| Kártya | Amit visz |
|---|---|
| Terhelés | terhelési arány + a `physical` elemzés `summary` mezője |
| Regeneráció | HRV-eltérés + a `recovery` elemzés `summary` mezője |
| Táplálkozás | 74 mért nap, átlagos bevitel — **elemzés nélkül** |
| Pénzügy | havi teher + a `finance` elemzés `summary` mezője |

A Táplálkozás kártyája azért visz mért számot összefoglaló helyett, mert
nincs `nutrition` domain (az S8 hozza majd). Ez nem hiányállapot és nem
„hamarosan": a kártyának van mit mondania a saját adatából.

Minden kártyán ott a forrás kora: egy két hete készült elemzés
összefoglalója akkor is két hetes, ha magabiztosan hangzik.

## Terhelés — `/terulet/terheles`

**Vezető szám: terhelési arány** (`physical.loadRatio`, ma 1,41×) — a 28
napos napi átlag edzésperc a 365 naposhoz képest. Ha `null` (a mai szabály
szerint 28 előzmény-edzésnap alatt), akkor „nincs elég előzmény a
viszonyításhoz" áll ott, nem `1,00×`.

**Diagramok:** lépés, táv, aktív kalória, mozgásperc — mind a `SOROZATOK`-ból,
sparkline-nal és a részletoldalra vezető linkkel.

**Havi edzésóra, oszlopdiagram** — `physical.byMonth`, 56 hónap. Az erősítő
alkalmak száma külön sorban a hónap alatt, nem külön diagramon: két
oszlopdiagram egymás alatt ugyanarról az időtengelyről nehezebben olvasható,
mint egy diagram és egy szám.

**Típusbontás** — a 12 edzéstípus táblája: alkalom, összes óra, összes
kalória, és mikor volt az utolsó. Ez a tábla nem az `aggregate()`-ből jön,
hanem új lekérdezésből (lásd lentebb): 2392 sor betöltése és csoportosítása
JS-ben minden oldalletöltésre indokolatlan, amikor az SQLite egy `GROUP BY`-jal
elvégzi.

Az `energy_kcal` nullázható. Egy típus, aminél egyetlen alkalom sem hordoz
kalóriát, „nincs mérés"-t kap a kalória-oszlopban, nem `0 kcal`-t. Ahol
csak egy részük hordoz, ott az összeg mellett ott áll, hány alkalomból jön.

**Utolsó 20 edzés** — dátum, típus, hossz, kalória. Alatta link a teljes
naplóra.

**Elemzés:** `physical`.

## Edzésnapló — `/terulet/terheles/naplo`

Mind a 2392 edzés, fordított időrendben, oldalanként 50, `?oldal=N`
paraméterrel. A lapozás sima link, JS nélkül — az F1 óta ez a szabály.

Oszlopok: dátum, kezdés ideje, típus, hossz, kalória, forrás.

`?oldal` értelmezése szigorú: az `1`-nél kisebb, a legutolsó oldalnál
nagyobb, a nem egész és a hiányzó érték mind az **első oldalra** esik. Nem
404, mert a napló létezik — csak az a kérés volt értelmetlen, és egy üres
tábla azt állítaná, hogy nincs edzés.

## Regeneráció — `/terulet/regeneracio`

**Vezető szám: a HRV a saját 90 napos alapvonalához mérve**, szórásban
(`recovery.hrvDeviation`, ami `{ sigma, n7, n90 }` vagy `null`). Ez azért jobb
vezető szám, mint a nyers 7 napos átlag: egy ms-érték önmagában nem
viszonyítható semmihez, „a 90 napos alapvonalánál ennyi szórással feljebb"
viszont igen. A két mintaszám (`n7`, `n90`) ott áll mellette: a szórás annyit
ér, amennyi mérésből számoltuk. Ha `null`, a hiány áll ott.

**Diagramok:** HRV, nyugalmi pulzus, pulzus-visszatérés.

**Az alvás lefedettsége** — `recovery.sleepByYear`, évenként: hány napról van
egyáltalán sor, és abból hányon van alvás. A mai szám 2718 napból 386, és az
elmúlt 90 napban **nulla**. Az évenkénti bontás mondja meg, mi történt:
2022-ben 217 nap, 2023-ban 85, 2024-ben 19, 2025-ben 22 — a lefedettség
évről évre esett, majd 2026-ban 43-ra kúszott vissza. Ez a projekt legnagyobb ismert adathiánya, és a
felület első dolga az F1 óta a mért és a nem mért közti határ — tehát ez a
blokk nem eldugva, hanem a diagramok után rögtön, a hiány kimondva. Az évek
lefedettsége az F1 lefedettségi sávjával jelenik meg, ugyanazzal a
színszabállyal.

Az S8 óta tudjuk, hogy a hiány itt **szándékos**: éjszaka nincs óra a
csuklón. A felület ezt nem minősíti — annyit mond, ami mérhető: hány napról
van alvásadat. Egy „miért nincs" magyarázat nem az oldal dolga.

**Alvásfázisok és ébredés** — `recovery.stages` (`core`, `rem`, `deep`;
magyarul alap, REM, mély) és `recovery.awakenings`. Mindegyik a saját
lefedettségével: 90 nap nulla mérése után a fázisok bontása a 386 mért nap
előzményéből jön, és ezt látni kell.

**Elemzés:** `recovery`.

## Táplálkozás — `/terulet/taplalkozas`

**Vezető szám: hány napról van bevitel** — 74 nap, és mikor volt az utolsó.
Ez a terület még alig mért, és a vezető számnak ezt kell mondania, nem egy
magabiztos napi átlagot 74 nap mintájából.

Ez az egyetlen szám az öt oldalon, ami **nem** az `aggregate()`-ből jön: a
`Metrics`-nek nincs `nutrition` ága (az S8 hozza majd). Az oldal a
`health.between("1970-01-01", ma)` sorain számolja meg a nem-null
`diet_kcal`-t — ugyanaz a lekérdezés, amit a `main.ts` az aggregátumhoz
amúgy is elvégez.

**Diagramok:** bevitt kalória (`diet_kcal`), fehérje (`diet_protein_g`) — mind
a kettőnek már van `SeriesSpec`-je a `SOROZATOK`-ban.

**A heti étrend** — 7 nap × 3 étkezés táblája a `MealRepo`-ból, a kiolvasztást
igénylő tételek megjelölve a saját előkészítési idejükkel. Naponta összegezve
a tervezett kalória és fehérje.

A `MealRepo`-nak nincs „mindet" metódusa, és nem is kap: a hét hívás
`forWeekday(0..6)` összesen 21 sort olvas, ami olcsóbb, mint egy új
repository-metódus és a tesztje.

**Terv és valóság egymás mellett** — a tervezett napi átlag (az étrendből) és
a mért napi átlag (a 74 napból) két szám egymás mellett, a mért napok
számával. Nem elemzés és nem ítélet: az összevetés értelmezése az S8 dolga
lesz. A tervezett érték is lehet hiányos — a `protein_g` és a `kcal`
nullázható —, és akkor a tervezett oldal is „nincs adat", nem részösszeg.

**Nincs elemzés-sáv.** Nincs `nutrition` domain, tehát a negyedik sáv nem
üresen áll ott, hanem egyáltalán nincs ott. Az F1 kimondta: egyetlen
„hamarosan" felirat sem elfogadható.

## Pénzügy — `/terulet/penzugy`

**Vezető szám: a havi teher és a hónap-változása** — `finance.months` utolsó
eleme és `finance.monthOverMonth`. Ma 64 860 Ft, változás nulla.

**Havi teher, oszlopdiagram** — `finance.months`. Ma két hónap, tehát két
oszlop. Ez kevés egy diagramhoz, de a rögzítés hónapról hónapra nő, és a
diagram nem hazudik két oszlopról sem — a rögzítés kezdete előtti hónapok
**nincsenek** a diagramon (nem nulla oszlopok), lásd a primitív szabályát.

**Az előfizetések listája** — név, összeg, ciklus, kategória, a következő
megújulás dátuma és hány nap múlva esedékes, és az **utolsó használat**.

Az utolsó használat azért van a listán, mert ez az egyetlen mező, amiből
kiderül, hogy egy futó előfizetés használatban van-e. Hiányzó `last_used_at`
esetén „nincs adat" áll ott — nem „soha", mert a kettő nem ugyanaz, és a
mező csak akkor íródik, ha valami feljegyzi.

**Évesített teher** — `finance.annualisedHuf`. Ma **`null`**, mert a
rögzített hónapok száma 2, a projekció küszöbe pedig 6. Ott tehát „nincs elég
hónap az évesítéshez (2 a 6-ból)" áll, **nem `0 Ft`** és nem egy hónapból
szorzott szám. A küszöb indoklása az `aggregate.ts`-ben áll, és nem
változik.

**Elemzés:** `finance`.

## Az új diagram-primitív: havi oszlopok

`src/delivery/http/view/chart/bars.ts`

Az F2 `plot`-ja napi mérés-sorozatra készült, hézagsávval. Az edzésmennyiség
más alakú adat: hónapokra összesített, és egy edzés nélküli nap valódi nulla,
nem hiányzó mérés. A napi perc-vonal a legtöbb oszlopon nullán feküdne, a
mediánja is nulla lenne — a kép találó lenne, csak nem mondana semmit.

**A primitív kulcsdöntése, hogy kétféle üres van:**

- `null` → **nincs adat**: a hely üresen marad, a hónap címkéje szürke. Ilyen
  a pénzügy 2026 augusztusa előtti minden hónapja: a `subscription_months`
  tábla az S2-ben született, és a korábbi hónapokat szándékosan nem
  rekonstruáljuk.
- `0` → **mért nulla**: látható tőcsonk a tengelyen, olvasóban `0`. Ilyen egy
  edzés nélküli hónap a rekord tartományán belül.

A kettő a kimenetből megkülönböztethető kell legyen — ez a primitív egyetlen
igazi állítása, és a tesztje is erre megy. (A 2022-02 → 2026-09 közötti mind
az 56 hónapban van edzés, tehát a mért nulla ma elméleti eset. A primitív
attól még nem hazudhat, ha egyszer bekövetkezik: pontosan az ilyen, „ma
úgysem fordul elő" helyek termelték eddig a projekt magabiztosan rossz
számait.)

**Ami az F2-től öröklődik változatlanul:**

- `--jel` kizárólag mért adatra; a hiányzó hónap színtelen
- olvasó a hónap fölé: a hónap neve és az értéke, `:hover` és `:focus` hatásra
- ami nincs mérve, az nem animálódik
- `prefers-reduced-motion` a végállapotot rendereli
- nincs kliensoldali JavaScript

**Interfész:**

```ts
export interface BarsSpec {
  label: string;
  format: (v: number) => string;
}
export function bars(
  rows: readonly { label: string; value: number | null }[],
  spec: BarsSpec,
): string
```

A hívó dönti el, mit ad `null`-nak és mit nullának — a primitív nem találgat.
A sorok sorrendje a hívóé; a diagram nem rendez át, és a `label` már kész
szöveg (a primitív nem tud róla, hogy hónap).

**Címkék:** 56 oszlop alá 56 felirat nem fér. A tengely annyi feliratot rak
ki, amennyi olvashatóan elfér, egyenletesen ritkítva, és az **első meg az
utolsó mindig ki van írva** — az a kettő mondja meg, milyen tartományt
nézünk. Minden oszlop teljes felirata elérhető az olvasójából, tehát a
ritkítás nem vesz el információt.

## Fájlszerkezet

`routes/page.ts` ma 318 sor, és hat útvonallal ~600 lenne. Követi az F1
mintáját, ahol a 209 soros `page.ts` hat modulra bomlott:

```
src/delivery/http/routes/
  page.ts        a közös shellInputs/render + a meglévő négy útvonal
  areas.ts       a hub, a négy terület és a napló útvonalai

src/delivery/http/view/area/
  hub.ts         /terulet — az Összegzés és a négy kártya
  load.ts        Terhelés
  recovery.ts    Regeneráció
  nutrition.ts   Táplálkozás
  finance.ts     Pénzügy
  worklog.ts     az edzésnapló táblája és lapozója

src/delivery/http/view/chart/
  bars.ts        a havi oszlopdiagram
```

A `view/area/*` modulok **már lekérdezett adatot kapnak és HTML-t adnak
vissza** — nem érnek repository-hoz. Ez teszi őket tesztelhetővé adatbázis
nélkül, ahogy az F1 `view/*` moduljait is.

A `shell.ts` `Section` típusa és `ITEMS` listája követi a menüváltozást;
`view/analyses.ts` `analysesBlock`-ja megmarad és a területi oldalak
használják — a `analysesBody` (a `/elemzes` teljes törzse) megszűnik vele
együtt.

## Interfész-változások

### `PageDeps.metricsRows` → `PageDeps.metrics`

```ts
// Ma:      metricsRows: () => MetricRow[];
// Ezután:  metrics: () => Metrics;
```

A területi oldalaknak `physical.byMonth`, `recovery.sleepByYear`,
`finance.monthOverMonth` kell, nem formázott sorok. A `/szamok` útvonal maga
alkalmazza a `metricsRowsFrom`-ot a kapott `Metrics`-re — ez egy sor, és
ugyanabban a `try/catch`-ben marad, ami ma is védi.

A `main.ts` „kérésenként újraszámolva, nem gyorsítótárazva" viselkedése és a
hozzá tartozó indoklás változatlan; csak a `metricsRowsFrom` hívás költözik
a route-ba.

`PageDeps` két új mezőt kap: `workouts: WorkoutRepo`, `meals: MealRepo`,
`subscriptions: SubscriptionRepo`.

### Két új lekérdezés a `WorkoutRepo`-ban

```ts
/** Típusonkénti összesítés a teljes előzményre, alkalomszám szerint csökkenő. */
byType(): {
  type: string;
  sessions: number;
  minutes: number;
  /** Összes kalória, és hány alkalom hordozott egyáltalán kalóriát. */
  kcal: number | null;
  kcalFrom: number;
  lastDate: string;
}[];

/** Egy oldalnyi edzés, legújabb elöl. */
page(offset: number, limit: number): { rows: WorkoutRow[]; total: number };
```

Mindkettő azért repository-szintű, mert az alternatíva 2392 sor betöltése és
JS-ben csoportosítása minden oldalletöltésre. A `kcal`/`kcalFrom` páros a
nullázható `energy_kcal` becsületes kezelése: az összeg mellett ott van, hány
alkalomból jön, és ha egyik sem, akkor `null`, nem `0`.

## Hibatűrés

Az F1 mintája marad, útvonalanként: **minden darab magában bukik.** Egy
hibázó `byType()` nem viheti el a diagramot, egy hibázó `metrics()` nem
viheti el az edzésnaplót, és egyik sem viheti el az oldalt. Minden elkapott
hiba `logger.warn`, és a hiányzó rész hiányzóként jelenik meg — soha nem üres
kerettel.

Ismeretlen terület-slug (`/terulet/valami`) **404**, nem üres keret és nem
átirányítás a hubra: ugyanaz a döntés, mint a `/szamok/:metrika`-nál, ahol
egy üres diagram azt állítaná, hogy létezik az a mérés.

## Ellenőrzés

A meglévő tesztek állításai megmaradnak; ahol a szerkezet változott, a
szelektor követi, a követelmény nem. Az `/elemzes` tesztjei a hubra és a
területi oldalakra költöznek — az az állítás, hogy egy elemzés a dátumával
együtt jelenik meg, nem szűnik meg, csak áthelyeződik.

**Jogosultság** — ez az F1 záró reviewjának két valódi leletét ismétli meg az
új útvonalakon:

- mind a hat új útvonal tokennel 200-at ad, token nélkül 401-et
- a százalék-kódolt alak (`/%74erulet`, `/terulet/%74erheles`) sem csúszik át
  a szűrőn — az F1-en pontosan egy ilyen kérés adta vissza a teljes oldalt

**A `bars` primitív:**

- a *nincs adat* és a *mért nulla* a kimenetből megkülönböztethető
- egyetlen hónapból álló bemenet nem esik szét, és nem oszt nullával
- csupa `null` bemenet nem üres diagramot ad, hanem kimondja a hiányt
- `--riado` egyetlen szabályában sem szerepel (az F2 ugyanezt őrzi)

**A napló lapozója** — `?oldal=0`, `?oldal=-3`, `?oldal=9999`, `?oldal=abc`,
`?oldal=` és a hiányzó paraméter mind az első oldalt adja, és a lapozó
linkjei sosem mutatnak a tartományon kívülre.

**A hiány hiányként:**

- az alvás 90 napos nulla mérése hiányként jelenik meg, nem `0 perc`-ként
- `annualisedHuf === null` esetén „nincs elég hónap", nem `0 Ft`
- `loadRatio === null` esetén nem `1,00×`
- egy kalóriát nem hordozó edzéstípusnál „nincs mérés", nem `0 kcal`
- hiányzó `last_used_at` „nincs adat", nem „soha"
- a Táplálkozás oldalán nincs elemzés-sáv, és nincs „hamarosan" felirat sem

**A menü:**

- mind az öt terület-oldalon a Terület az aktív elem, és csak az
- a Terület jelzője kialszik, ha a legfrissebb elemzés 7 napnál régebbi, és
  akkor is, ha egy elemzés sincs

**Mutációs fegyelem:** minden új teszt bukjon el a javítatlan implementáció
ellen. Ez a projekt eddig ~14 olyan tesztet termelt, ami elromlott
implementáció mellett is zöld volt — az F2 záró javításánál is pontosan ez
történt: a teszt az útvonalak *számát* nézte, a mértanát nem, és nem látta,
hogy a hiba megmaradt.
