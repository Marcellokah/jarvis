# F2 — Diagram-alapkészlet: sorozat, sparkline, nagy nézet

**Állapot:** jóváhagyva 2026-09-02. A front-end kiépítés második darabja
(F1 váz ✓ · **F2 diagram** · F3 területi oldalak · F4 írás · F5 elemzés és chat).

## Miért

Az adatbázisban 2718 nap van, és az oldal egyetlen pillanatot mutat belőle.
A Számok oldal pontértékeket ad lefedettséggel, de semmi alakot: nem látszik,
hogy a nyugalmi pulzus két éve lassan csökken, hogy a VO2max mikor tört meg,
vagy hogy az alvás hogyan változott, amióta újra órával alszol.

## A tézis, és amiért mérésből jön

A lefedettség mérésenként drámaian eltér, és a hézagoknak **kétféle alakjuk
van** — ezt a teljes előzményen mértük 2026-09-02-án:

| mérés | nap | lefedettség | legnagyobb hézag |
|---|---|---|---|
| `steps` | 2716 | 99,9% | **35 nap** |
| `hrv` | 1424 | 52,4% | 6 nap |
| `rhr` | 1343 | 49,4% | 6 nap |
| `vo2max` | 648 | 23,8% | — |
| `asleep_min` | 386 | 14,2% | tömbös |
| `diet_kcal` | 74 | 2,7% | tömbös |

A HRV egyenletesen ritka: minden második nap, sehol nagy lyuk. A lépés 99,9%
mellett is hordoz egy 35 napos szakadást. Az alvás 14%-a pedig nem elszórt,
hanem tömbös — a Pillow-korszak, aztán semmi, aztán a mostani.

Ebből következik az F2 aláírás-eleme:

> **A diagram nem húz vonalat olyan napokon át, amikről nincs adata.**

Minden kész könyvtár interpolál: összeköti a két végpontot, és a 35 napos
szakadásból egy szép, egyenletes emelkedés lesz, ami soha nem történt meg. Ez
pontosan az a magabiztosan rossz adat, ami ellen az egész rendszer épül, csak
képben. A projektnek nincs futásidejű függősége, tehát a saját SVG-nkben ezt
mi döntjük el.

## Két szabály, amiből minden más következik

### 1. A vonal ott törik, ahol a hézag szokatlan ehhez a méréshez

Nem fix napszámnál. A HRV-nél a kétnapos ritmus a normális, tehát ott a hatnapos
lyuk a hír; a lépésnél a napi ritmus, tehát ott a három napos.

**A küszöb a sorozat saját medián-napközéből jön:** `küszöb = 3 × medián`. Két
egymást követő pontot csak akkor köt össze vonal, ha a köztük lévő napkülönbség
**kisebb, mint a küszöb**. A medián azért, és nem az átlag, mert egyetlen 35
napos lyuk az átlagot elhúzná, a mediánt nem — a küszöbnek a tipikus ritmust
kell leírnia, nem a kivételt.

Napi ritmusú sorozatnál a medián 1, tehát a küszöb 3: egy kihagyott nap még
összeköt, kettő már nem. A HRV-nél a medián 2, a küszöb 6 — és a mért
legnagyobb HRV-hézag épp 6 nap, tehát pontosan ott törik meg, ahol a hír van.

Kevesebb mint két pontnál nincs vonal, csak a pontok maguk.

### 2. A hiány pozitívan látszik

A nagy nézetben a szokatlan hézagok helyén halvány sáv áll a diagram mögött,
`--racs` színnel. Az „itt nincs jel" ugyanolyan információ, mint a jel, és a
sáv az egyetlen módja, hogy a hiány **méretét** is lásd — egy megszakadt vonal
csak azt mondja, hogy volt lyuk, azt nem, hogy meddig tartott.

A sparkline-ban nincs sáv: ott a vonal egyszerűen megszakad. Egy 60 pixeles
diagramon a sáv zaj lenne, nem információ.

**A hézag nem riasztás.** `--riado` marad kizárólag az állapotsáv esedékes-de-
nem-érkezett csatornájáé. Egy 2021-es lyuk az előzményben nem hiba, csak
hiány — ha magentát kapna, a szín elvesztené az erejét ott, ahol számít.

## A hosszú nézet nem vonal, hanem sáv

2718 pont egy 800 pixeles diagramon 3,4 pont per pixel — értelmetlen részlet, és
30–40 KB útvonal-adat diagramonként. Átlagolni viszont **nem szabad**: az átlag
elrejti a kiugrásokat, és egy hézagon átlagolva adatot talál ki.

Ezért: ha a pontok száma meghaladja a rendelkezésre álló pixeloszlopokat, a
diagram **oszloponként min–max sávot** rajzol, benne a mediánnal. Ez megmutatja,
mi történt valójában — a szórással együtt —, sosem talál ki semmit, és **ahol egy
oszlopba egyetlen mérés sem esik, az oszlop üres marad**. Egy évnyi HRV így a
valódi ingadozását mutatja, nem egy simított hazugságot.

Ha a pontok elférnek (kevesebb pont, mint oszlop), sima vonal rajzolódik, a
fenti törésszabállyal.

## Hatókör

**Beletartozik:** a sorozat-logika, a sparkline, a nagy nézet tengelyekkel és
hover-olvasóval, a tartományválasztó, egy `SOROZATOK` regiszter, sparkline-ok a
Számok oldal minden mérés-során, és egy új `/szamok/:metrika` részletoldal.

**Nem tartozik bele:** a területi oldalak (F3), írási műveletek (F4), az
elemzések böngészése és az újratöltés nélküli chat (F5).

**Új adatlekérdezés nem kell.** A `health.between(from, to)` már megvan, és a
teljes 7,5 év lekérése **3 ms** — nincs gyorsítótár, nincs API-végpont, nincs
kliensoldali adatbetöltés. A diagram a szerveren renderelt SVG.

## Fájlszerkezet

```
src/delivery/http/view/chart/
  series.ts     sorozat pontokból: törésküszöb, szakaszok, hézagok, tartomány
  buckets.ts    pixeloszlopokba sűrítés min/max/mediánnal
  sparkline.ts  a kicsi, tengely nélküli diagram
  plot.ts       a nagy nézet: tengelyek, hézagsávok, min–max sáv, olvasó
  registry.ts   SOROZATOK: mely oszlopból lehet diagram, milyen néven és egységgel
```

Egy fájl, egy dolog. A `series.ts` és a `buckets.ts` tiszta függvények — nincs
bennük SVG, és külön tesztelhetők.

## A `SOROZATOK` regiszter

Csak az kap diagramot, aminek **valódi napi oszlopa** van a történetben. Egy
bejegyzés: az oszlop neve, a megjelenített címke, az egység, a formázó, és hogy
a függőleges tengely nulláról induljon-e.

**A nulla-alap nem ízlés kérdése.** Ami *számláló* (lépés, kalória, perc, táv),
az nulláról indul, mert a nulla ott valódi érték és az arányok számítanak. Ami
*mérés* (HRV, nyugalmi pulzus, VO2max, járássebesség), az az adat saját
tartományát használja, mert a nulla ott fizikailag értelmetlen, és egy
nulla-alapú tengely a teljes ingadozást egy hajszálvonalba lapítaná. Ez ugyanaz
a megkülönböztetés, amit a rollup `agg: "sum" | "avg"` mezője már hordoz.

Az első tagok: `hrv`, `rhr`, `vo2max`, `hr_recovery`, `asleep_min`, `sleep_h`,
`awakenings`, `steps`, `distance_km`, `move_kcal`, `basal_kcal`,
`exercise_min`, `diet_kcal`, `diet_protein_g`, `walking_speed`,
`step_length_cm`, `six_min_walk_m`, `steadiness_pct`.

## A nagy nézet

**Útvonal:** `GET /szamok/:metrika` — a meglévő alapértelmezett-tiltás miatt
automatikusan a `pageAuth` mögött. Ismeretlen metrika 404, nem üres diagram.

**Tartományválasztó:** `?tart=30 | 365 | mind`, alapértelmezés `365`. Sima
linkek, nulla JS, és a cím megosztható-könyvjelzőzhető. A `?token=` kitörlése
csak a `token` paramétert bántja, tehát a `tart` megmarad.

**Hover-olvasó JS nélkül.** Minden pixeloszlop kap egy láthatatlan, teljes
magasságú, `tabindex="0"` téglalapot; `:hover` és `:focus-visible` alatt
megjelenik a hozzá tartozó olvasó (dátum, érték vagy tartomány, mérésszám).
Így egérrel, billentyűzettel és érintéssel is működik, és nem kell hozzá script
— érintésen a koppintás fókuszál.

**Szöveges összegzés minden diagramhoz.** Az SVG `<title>`-je és `aria-label`-je
szavakban mondja el, amit a kép: *„HRV, 365 nap: 1424 mérés, 52% lefedettség,
41–108 ms, a trend enyhén emelkedő."* Egy diagram, amit nem lehet elolvasni,
nem információ — és ez az egyetlen forma, amit a Telegram-válasz vagy egy
képernyőolvasó is használni tud.

## A Számok oldal

Minden sor, aminek van `SOROZATOK`-bejegyzése, kap egy **60×18 pixeles
sparkline-t** az érték és a lefedettségi sáv mellé, és a címke link lesz a
részletoldalra. Aminek nincs sorozata (terhelési arány, trendek, előfizetések),
az marad, ahogy van — sem sparkline, sem link.

Ehhez a `MetricRow` egy mezővel bővül: `series: { column: string; days: number }
| null`. A `column` mondja meg, melyik részletoldalra mutat a link, a `days`
pedig azt, hogy **a sparkline ugyanazt az ablakot mutassa, amit a sor** — a
„Lépés (7 nap)" és a „Lépés (365 nap)" ugyanabból az oszlopból jön, de két
különböző történetet mond, és egy közös sparkline mindkettőről hazudna.

Ez ugyanaz a lépés, mint amikor a `coverage` szám lett szövegből: a sáv és a
sparkline csak akkor mondhat igazat, ha valódi adatból rajzolódik, nem a
`detail` prózájából visszafejtve.

A sparkline ugyanabból a `Series`-ből rajzolódik, mint a nagy nézet, ugyanazzal
a törésszabállyal. Egyetlen logika, két méret.

## Szín

- **`--jel`** — a vonal, a min–max sáv és a pontok. Kizárólag mért adat.
- **`--vaz`** — tengelyek, rács, tengelyfeliratok. Soha nem adat.
- **`--racs`** — a hézagsávok és az olvasó háttere. A hiány és a chrome.
- **`--riado`** — **nem jelenik meg diagramon.** Lásd fent.

A min–max sáv `--jel` alacsony áttetszőséggel, a mediánvonal teljes erővel:
így a sáv a szórás, a vonal a történet, és a kettő egy színcsaládban marad.

## Mozgás

A vonal betöltéskor balról jobbra kirajzolódik (`stroke-dasharray` +
`stroke-dashoffset`, 700 ms). A min–max sáv ugyanazzal a ritmussal úszik be.
**A hézagsávok nem animálódnak** — ugyanaz az elv, mint a halott csatornánál: a
hiány attól látszik, hogy ott nem történik semmi.

`prefers-reduced-motion` esetén minden a végállapotban rendereli magát.

## Ellenőrzés

A tiszta logika (`series.ts`, `buckets.ts`) tesztje a lényeg, mert ott dől el,
igaz-e a kép:

- a törésküszöb a **mediánból** jön, nem az átlagból: egy 35 napos lyuk egy
  napi ritmusú sorozatban nem emelheti meg a küszöböt annyira, hogy a lyuk
  maga összekötöttnek számítson;
- két pont, amiket a küszöbnél nagyobb hézag választ el, **nem kerül egy
  szakaszba** — és ennek a párja: a küszöbnél kisebb hézag igen. Külön-külön
  mindkét fele átmegy egy olyan implementáción, ami a küszöböt figyelmen kívül
  hagyja;
- egy üres pixeloszlop **üres marad**, nem örökli a szomszédját;
- egy oszlop min–max-a a benne lévő valódi pontokból jön, és a szélső értékek
  **nem tűnnek el** a sűrítésben (egy egynapos kiugrás egy évnyi adatban
  látszik a sávon);
- nulla pont esetén nincs vonal, nincs sáv, és nincs kivétel sem — a diagram
  helyén az áll, hogy nincs mérés;
- egyetlen pont esetén pont rajzolódik, vonal nem.

A renderelés tesztje:

- a `SOROZATOK`-kal nem rendelkező metrika-sor **nem kap sem sparkline-t, sem
  linket**;
- ismeretlen metrika a részletoldalon **404**, nem üres diagram;
- a `?tart=` érvénytelen értéke a 365-re esik vissza, nem hibázik;
- minden diagram `<title>`-je tartalmazza a mérésszámot és a lefedettséget;
- a hézagsáv nem `--riado` színnel rajzolódik;
- token nélkül a részletoldal 401.

## Globális megkötések

- Node ≥ 24, nincs build lépés, `.ts` fut közvetlenül; minden relatív import
  `.ts` kiterjesztéssel.
- **Nincs új futásidejű függőség**, és a diagramokhoz **nincs kliensoldali JS**.
- `npm run typecheck` tiszta, a teljes csomag zöld, a tesztek hálózat nélkül
  futnak.
- Felhasználónak szóló szöveg magyarul, kódkommentek angolul, és a WHY-t
  magyarázzák.
- A tesztek nem írnak a `./data/jarvis.db`-be, nem nyúlnak a launchd
  ügynökhöz, és nem indítanak szervert a 8787-es porton.
