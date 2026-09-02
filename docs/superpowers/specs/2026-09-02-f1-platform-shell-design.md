# F1 — Platform-váz: útvonalak, oldalkeret, designrendszer

**Állapot:** jóváhagyva 2026-09-02. Ez az öt részből álló front-end kiépítés
első darabja (F1 váz · F2 diagram-alapkészlet · F3 területi oldalak · F4 írás ·
F5 elemzés és beszélgetés).

## Miért

Az adatbázisban 2718 nap × 31 mérés, 2392 edzés, elemzések, előfizetések és a
teljes beszélgetés van. Az oldal ebből egyetlen hosszú görgetést mutat. A
kiépítés célja egy felület, amit minden nap érdemes megnyitni — de a felület
előbb keretet kíván, különben minden további oldal a semmibe épül.

**F1 nem váz helyőrzőkkel.** Kizárólag olyan tartalmat rendez oldalakra, ami ma
is létezik, tehát a végén működő, navigálható alkalmazás áll, egyetlen
„hamarosan" felirat nélkül.

## Hatókör

**Beletartozik:** négy útvonal, közös oldalkeret navigációval és állapotsávval,
a designrendszer mint egyetlen stíluslap, és a mai `page.ts` szétbontása.

**Nem tartozik bele:** diagram (F2), területi oldalak (F3), írási műveletek
(F4), az elemzések böngészése és az újratöltés nélküli chat (F5). **F1 nem
vezet be új adatlekérdezést** — minden oldal meglévő repository-hívásból él.

## Útvonalak

Szerver-oldali oldalak, nem SPA: nincs build lépés, nincs keretrendszer, és
telefonon Tailscale-en a kiszolgált HTML a leggyorsabb, ami lehet. Mind a négy
a meglévő `pageAuth` mögött van, változatlanul — a token egyszeri, a szerver
`HttpOnly` sütire cseréli.

| Út | Oldal | Adatforrás |
|---|---|---|
| `/` | Ma | `briefs.cached(now)`, `health.forDate(ma)`, `health.latest(ma)` |
| `/elemzes` | Elemzés | `analyses.latestPerDomain()` |
| `/szamok` | Számok | `metricsRows()` |
| `/kerdes` | Kérdés | `conversations.recent(WEB_CHAT_ID, 20)`, `chat.available()` |

`GET /` ma a teljes tartalmat egy dokumentumban adja; ez a négy útvonalra
oszlik. A `POST /api/chat` változatlan marad.

`PageDeps` egy mezővel bővül: `health: HealthRepo`. A Ma oldalnak a mai sor
kell, és azt ma semmi nem adja neki.

### Hibatűrés

A mai route mintája marad, útvonalanként: **minden darab magában bukik.** Egy
hiányzó brief nem viheti magával a mai méréseket, és egy hibázó
`metricsRows()` nem viheti el az oldalt. Minden elkapott hiba `logger.warn`,
és a hiányzó rész hiányzóként jelenik meg — soha nem üres kerettel.

## Fájlszerkezet

A mai `src/delivery/http/page.ts` 209 sorban négy dolgot csinál: stíluslap,
kliens-script, HTML-sablon és metrika-formázás. Ide épül minden további oldal,
ezért szétbontjuk:

```
src/delivery/http/view/
  theme.ts     a designrendszer tokenjei és a közös CSS (egy sztring)
  shell.ts     layout(): dokumentum, navigáció, állapotsáv
  today.ts     a Ma oldal
  analyses.ts  az Elemzés oldal
  numbers.ts   a Számok oldal (ide költözik a metricsRowsFrom)
  ask.ts       a Kérdés oldal
```

`markdown.ts` érintetlen. A régi `page.ts` megszűnik; a `MetricRow` típus és a
`metricsRowsFrom` a `view/numbers.ts`-be kerül, a `renderPage` helyét a
`layout()` plusz az oldalankénti renderelők veszik át.

## A designrendszer

A tegnapi tézis nem cserélődik le, hanem felnő cyberpunkba: **az oldal műszer,
ami a saját jelminőségét is mutatja.** Egy játékbeli személyi asszisztensnél ez
természetes, mert ott az offline szenzor offline-nak látszik. Minden hard hiba,
amit ez a projekt eddig megélt, egy magabiztosan rossz szám volt — a felület
első dolga tehát a mért és a nem mért közti határ.

### Szín

Három szín, mindegyiknek egyetlen dolga van. **A szín információ, nem
dekoráció.** Ami nincs mérve, annak nincs színe.

```
:root {                          /* sötét: ez a design */
  --hatter:    #07090E;   /* alap */
  --lap:       #0E131C;   /* kiemelt felület */
  --racs:      #18212E;   /* hajszálvonalak */
  --szoveg:    #DCE3EE;
  --halvany:   #6C7891;   /* a "nincs jel" hang, szándékosan színtelen */
  --jel:       #FFA23C;   /* KIZÁRÓLAG mért adat */
  --jel-halk:  rgba(255,162,60,.18);
  --vaz:       #4B7A8C;   /* keret, chrome, HUD-felirat — soha nem adat */
  --riado:     #FF3D7F;   /* KIZÁRÓLAG figyelmeztetés és anomália */
}
@media (prefers-color-scheme: light) {
  :root {
    --hatter: #E9ECF1;  --lap: #FFFFFF;  --racs: #CFD5DF;
    --szoveg: #0E131C;  --halvany: #626D80;
    --jel: #A85400;     --jel-halk: rgba(168,84,0,.14);
    --vaz: #2C5766;     --riado: #C1004E;
  }
}
```

A világos változat nem utólagos engedmény: reggel fényes ablaknál olvasható
kell legyen. A szerepek cserélődnek, a jelentések nem.

### Betű

Két család, mindkettő az OS-ben van. Webfontot nem töltünk: egy be nem töltődő
betű pont a személyiséget vinné el, és a nulla-költség elvvel is szemben áll.

- **Mono** (`ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas`):
  szerkezet, számok, HUD-feliratok. Nagybetű, tág betűköz (.16–.22em) a
  címkéknél. `font-variant-numeric: tabular-nums` mindenhol, ahol számjegy
  oszlopba áll.
- **Humanista** (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto`):
  próza. A briefinget félálomban olvassa az ember.

### Elrendezés

Egy oszlop, legfeljebb 48rem szélesen, 4px-es térköz-alap. Széles tartalom
(tábla, kód) saját `overflow-x: auto` konténerben görög, a törzs vízszintesen
soha.

### Navigáció

Asztalon (≥ 46rem) bal oldali sáv, telefonon alsó sor — mert az oldalt
telefonról, Tailscale-en nyitod, és a hüvelykujj alul van.

Minden menüpont **saját jelzőt** visz, ami valódi adatból jön:

| Menüpont | A jelző akkor él, ha |
|---|---|
| Ma | van a mai napra brief |
| Elemzés | van legalább egy elemzés |
| Kérdés | `chat.available()` igaz |
| Számok | *nincs jelzője* |

A Számok szándékosan marad jelző nélkül: mindig van előzménye, tehát a jelzője
soha nem tudna kialudni — egy jelző, ami nem tud kikapcsolni, dekoráció.

### Állapotsáv

Minden oldal tetején, mono betűvel: a mai dátum, a brief kora, és **hány
csatorna él ma**.

A csatornaszám nem a 31 oszlopon értendő. A `NAPI_MAG` egy nevesített,
exportált halmaz — azok a mérések, amiket a napi csatorna **minden nap**
szállít:

```
sleep_h · hrv · rhr · steps · move_kcal · exercise_min
```

Ezekben a hiány azt jelenti, hogy a csővezeték hibázott, nem azt, hogy a mérés
nem történt meg. A ritkán mérteket (VO2max, járásstabilitás, hatperces séta)
szándékosan nem tartalmazza: egy örökké „4/12"-t mutató sáv riasztana valamire,
ami teljesen rendben van. Ez ugyanaz az elv, amin az egész rendszer áll, csak
magára a csővezetékre alkalmazva.

Ha a mai magból hiányzik valami, a hiányzó csatornák neve a sávban látszik,
`--riado` színnel. Ez a magenta egyetlen rendeltetése ezen az oldalon.

### Mozgás

A tegnapi szótár marad, kiegészülve az oldalváltással:

| Mikor | Mi | Paraméter |
|---|---|---|
| betöltés | a sávok beülnek | `settle` 500ms `cubic-bezier(.2,.8,.2,1)`, 60ms lépcső |
| betöltés | a lefedettségi sávok kitöltenek | `rail-in` 700ms, 320ms késleltetés |
| oldalváltás | natív keresztúsztatás | `@view-transition` 220ms |
| várakozás | a jel-sáv végigsöpör | `sweep` 1,1s, ismétlődő |

**Ami nincs mérve, az nem animálódik.** A hiányt az teszi láthatóvá, hogy ott
nem történik semmi.

`@media (prefers-reduced-motion: reduce)` mindent leállít, és a végállapotot
rendereli.

### Amit szándékosan kihagyunk

- **Scanline-textúra és glitch-effekt** — dekoráció, és pont ez teszi
  sablonossá a cyberpunk felületeket.
- **Sorszámozott szekciók (01 / 02 / 03)** — a szekciók nem sorozat, tehát a
  sorszám hazudna egy rendről, ami nincs.
- **Webfont** — lásd fent.

A cyberpunk hangulatot a szigorú színhasználat, a mono tipográfia és a
mérés-vezérelt jelzők adják. Egy adottság ingyen jön hozzá: **a felület
magyar.** A műfaj HUD-jai angolul-japánul beszélnek; egy magyar műszaki nyelvű
asszisztens-felület önmagában megkülönböztet.

## A Ma oldal tartalma

1. **Állapotsáv** (a keretből).
2. **Briefing** — a mai brief markdownja. Ha nincs, vagy trim után üres:
   „Ma még nem készült briefing." Üres cím tartalom nélkül nem elfogadható.
3. **A mai nap mérései** — a `NAPI_MAG` hat csatornája, mindegyik a saját
   értékével vagy „nincs mérés"-sel. A mértek `--jel` színnel, a hiányzók
   színtelenül és szaggatottan.
4. **Frissesség** — mikor íródott a mai sor (`ingestedAt`), és ha nincs mai
   sor, akkor melyik a legutóbbi nap, amiről van adat.

## Ellenőrzés

A meglévő 27 oldal-teszt **állításai megmaradnak**; ahol a szerkezet változott,
a szelektor követi, a követelmény nem. Nevezetesen marad: a hiányzó mérés
„nincs mérés" és nem nulla; a modell elérhetetlenségekor a tartalom teljes és
csak a kérdés-mező tiltott; az üres brief nem briefnek számít; és minden, amit
modell vagy ember írt, escape-elve jelenik meg.

Új tesztek:

- mind a négy útvonal tokennel 200-at ad, token nélkül 401-et;
- a navigáció aktív eleme az aktuális oldal, és csak az;
- a menüpontok jelzője a valódi adatból jön — brief nélkül a Ma jelzője
  kialszik, elemzés nélkül az Elemzésé, elérhetetlen modellnél a Kérdésé;
- a Számok menüpontnak nincs jelzője;
- egy mai sor nélküli nap a Ma oldalon hat „nincs mérés"-t mutat és egyetlen
  nullát sem;
- a `NAPI_MAG` hiányzó csatornái névvel jelennek meg az állapotsávban;
- a Ma oldal akkor is renderel, ha a brief lekérése hibát dob.

## Globális megkötések

- Node ≥ 24, nincs build lépés, `.ts` fut közvetlenül; minden relatív import
  `.ts` kiterjesztéssel.
- **Nincs új futásidejű függőség.** A diagramokat F2-ben kézzel írjuk SVG-ben.
- `npm run typecheck` tiszta, a teljes csomag zöld, a tesztek hálózat nélkül
  futnak.
- Felhasználónak szóló szöveg magyarul, kódkommentek angolul, és a WHY-t
  magyarázzák.
- A tesztek nem írnak a `./data/jarvis.db`-be, nem nyúlnak a launchd
  ügynökhöz, és nem indítanak szervert a 8787-es porton.
