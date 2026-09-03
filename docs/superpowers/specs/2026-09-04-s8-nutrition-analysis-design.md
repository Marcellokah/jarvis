# S8 — Táplálkozás: a negyedik elemzési terület

**Állapot:** a tulajdonos távollétében írva, előzetes felhatalmazással
(„Ha végezne F5 is, akkor mehet az S8… Dönts, és jelöld meg"). A sorrendet
korábban jóváhagytad: **energiaegyensúly → fehérjefedezet → következetesség.**

A távollétben hozott döntések a spec végén, egy helyen.

## Miért

A Táplálkozás az egyetlen területi oldal **elemzés-sáv nélkül.** Az F3 ezt
szándékosan hagyta üresen — nem „hamarosan" felirattal, hanem úgy, hogy a sáv
egyáltalán nincs ott —, mert nincs `nutrition` elemzési domain. Ez az a darab,
ami megcsinálja.

A rendszer három elemzési területet ismer (`physical`, `recovery`, `finance`)
plusz az összegzést. Mindegyik ugyanazon a csővezetéken megy: az
`aggregate()` kiszámolja a számokat, a `buildDomainPrompt` prompttá fűzi, a
modell megírja, az `analyses` tábla eltárolja, és a területi oldal megmutatja.
A táplálkozásnak megvan az adata és megvan a helye — csak a köre hiányzik.

## Amit az adat megenged, és amit nem

Ezt előre kimértem, mert a spec fele ezen múlik:

| Kérdés | Válasz |
|---|---|
| Hány napról van bevitel? | **74** |
| Az első bevitel óta eltelt nap? | **353** — tehát a napok 21%-áról van adat |
| Hány napon van bevitel ÉS alapanyagcsere ÉS aktív kalória? | **72** |
| Van testsúly-oszlop? | **NINCS** |
| Az étrend tervezett napi fehérjéje? | **112 g** (a heti étrend hét napjának átlaga) |

**A testsúly hiánya a legfontosabb.** A fehérjebevitelt szakmailag
testtömeg-kilogrammra vetítve szokás nézni, és a `health_snapshots` 34
oszlopa között **nincs testsúly**. Egy „1,6 g/ttkg" állításhoz a rendszernek
ki kellene találnia egy testsúlyt — pontosan az, amit ez a projekt nem tesz.
A fehérjefedezet ezért **a saját tervéhez** mérődik, nem a testhez: az étrend
112 g-ot tervez naponta, és a mérés megmondja, mennyi lett belőle.

## A három mutató

### 1. Energiaegyensúly

Napi `diet_kcal − (basal_kcal + move_kcal)`, azokon a napokon, ahol
**mindhárom** megvan. Ma 72 ilyen nap van.

- A napi egyenleg átlaga és szórása, a napok számával.
- Hány nap volt többletben, hány hiányban.
- **Csak együtt-mért napokból.** Egy hiányzó `move_kcal` nem nulla aktivitás,
  és egy egyenleg, ami ezt nullának veszi, több száz kalóriát hazudik. Ha egy
  napon bármelyik tag hiányzik, az a nap kimarad — és a kimaradó napok száma
  maga is állítás.

### 2. Fehérjefedezet

A mért napi fehérje az étrend tervezett napi fehérjéjéhez mérve.

- A mért napi átlag, a napok számával.
- A tervezett napi átlag az étrendből — **csak a teljesen beárazott
  napokból**, ugyanaz a szabály, amit az F3 táplálkozás-oldala már használ:
  egy részösszeg a teljes helyén a teljesnek olvasódik.
- A kettő aránya, ha mindkettő megvan.
- **Testtömegre vetített állítás nem születik**, és a prompt ezt kimondja a
  modellnek is. Nincs testsúly az adatbázisban; egy g/ttkg szám kitalált
  volna.

### 3. Következetesség

Hány napról van egyáltalán bevitel, az elsőtől máig.

- A mért napok száma és aránya (ma 74 / 353 = 21%).
- A leghosszabb megszakítás nélküli sorozat, és mikor volt.
- A legutóbbi mérés dátuma.

Ez a mutató azért van a sorban harmadikként, és nem elsőként, mert nem a
táplálkozásról szól, hanem a **mérésről**. De ott kell lennie, mert az első
két mutató annyit ér, amennyi napból számol — és 21% mellett minden állítás
ezzel a fenntartással érvényes.

## Ahol a kör bezárul

Az elemzés attól lesz kör, hogy a **következő futás visszakapja az előzőt.**
Ez már működik: minden domain válaszának utolsó blokkja egy `## Rövid
összegzés` bekezdés, és a következő futás azt kapja meg emlékezetként. A
táplálkozás ugyanezen a csővezetéken megy — nincs új mechanizmus.

## Hatókör

**Beletartozik:** a `nutrition` mutatók az `aggregate()`-ben; a `nutrition`
elemzési domain (típus, cím, rövid leírás, prompt, futtatás); a Táplálkozás
oldal elemzés-sávja és a hub kártyájának összefoglalója.

**Nem tartozik bele:** testsúly rögzítése (nincs csatorna hozzá, és az S7
napi magja sem tartalmazza); étrend-javaslat vagy bevásárlólista; a
`/szamok` tábla bővítése.

## Fájlszerkezet

```
MÓDOSUL
  src/core/analysis/aggregate.ts            NutritionMetrics + AggregateInput.plan
  src/infra/db/repositories/analyses.ts     Domain += "nutrition"
  src/core/analysis/analyst.ts              DOMAINS += "nutrition"
  src/core/analysis/prompts.ts              TITLE, BRIEF, a mutatók a promptban
  src/main.ts, scripts/analyze.ts,
    test/helpers.ts, src/core/ask/context.ts  az étrend átadása az aggregate-nek
  src/delivery/http/view/area/nutrition.ts  elemzés-sáv
  src/delivery/http/routes/areas.ts         a domain bekötése az oldalra és a hubra
```

Nincs új fájl és nincs új adatbázis-tábla. Az `AggregateInput` egy mezővel
bővül (`plan: readonly PlannedMeal[]`), mert a tervezett fehérje az étrendből
jön, és az `aggregate()` ma nem látja azt.

## Hibatűrés

Az `aggregate()` tiszta függvény: ha az étrend üres, a tervezett fehérje
`null`, és minden ráépülő állítás elmarad — nem nulla. A domain-futás
hibatűrése változatlan: a `runAnalysis` ma is domainenként kapja el a hibát,
és egy elszálló táplálkozás-elemzés a másik hármat nem viszi el.

Az oldalon a szokásos minta: az elemzés a saját `try/catch`-ében, saját
`logger.warn`-nal.

## Ellenőrzés

- **Az energiaegyensúly csak együtt-mért napokból számol.** A teszt fixtúrája
  olyan napot is tartalmaz, ahol a `move_kcal` hiányzik, és a mutatónak azt a
  napot ki kell hagynia — nem nullaként beszámítania. Ez a legfontosabb
  állítás az egész darabban.
- Egyetlen együtt-mért nap nélkül az egyenleg `null`, nem 0.
- A tervezett fehérje csak a teljesen beárazott étrend-napokból jön; egy
  beárazatlan tétel az egész napot kihagyja.
- **Sehol nem születik testtömegre vetített szám**, és a prompt szövege
  kimondja a modellnek, hogy nincs testsúly-adat.
- A következetesség nevezője az ELSŐ bevitel óta eltelt napok száma, nem a
  teljes előzmény — a 2019-es napokról nem azért nincs bevitel, mert
  kihagytad.
- A leghosszabb sorozat egyetlen mért napnál 1, nulla mért napnál `null`.
- A `nutrition` domain végigmegy a `runAnalysis`-on, és egy elszálló
  táplálkozás-elemzés nem viszi el a másik hármat.
- A Táplálkozás oldalnak **mostantól VAN elemzés-sávja**, és elemzés nélkül
  azt mondja, hogy még nem futott — az F3 „nincs ott a sáv" viselkedése
  megszűnik, és a tesztje ezzel együtt frissül.
- A hub Táplálkozás-kártyája a `nutrition` összefoglalóját viszi, ha van;
  ha nincs, marad a mért napok száma.
- **Minden új teszt bukjon el a javítatlan implementáció ellen.** Az F3-on
  tizenkét feladatból tizenegy, az F4-en négyből négy, az F5-ön háromból
  három igényelt plusz kört, szinte mindig azért, mert egy teszt nem látta a
  hibát, amit őrizni hivatott; **öt esetben maga a TERV tesztje volt
  tautologikus vagy kielégíthetetlen.** Ha egy előírt teszt nem tud elbukni,
  javítsd és írd meg — ne másold át hűségesen.

## A távollétben hozott döntések

Mindegyik megfordítható.

1. **Nincs testtömegre vetített fehérje-állítás**, mert nincs testsúly az
   adatbázisban. A fedezet a SAJÁT tervhez mérődik (112 g/nap az étrendből).
   Ha szeretnél g/ttkg-t, előbb testsúly-csatorna kell — az külön darab.
2. **Az energiaegyensúly kihagyja azt a napot, ahol bármelyik tag hiányzik.**
   A másik irány (a hiányzót nullának venni) több száz kalóriát hazudna
   naponta.
3. **A következetesség nevezője az első bevitel óta eltelt napok száma**, nem
   a teljes 2718 napos előzmény. A 2019-es napokról nem kihagyás miatt nincs
   bevitel.
4. **Az `AggregateInput` egy mezővel bővül** (`plan`), mert a tervezett
   fehérje az étrendből jön. Ez négy hívási helyet érint, mind mechanikus.
5. **A Táplálkozás oldal elemzés-sávot kap**, és ezzel az F3 kimondott
   „nincs ott a sáv" viselkedése megszűnik — ez volt a szándék, az F3 spec
   maga írta, hogy az S8 hozza meg.
