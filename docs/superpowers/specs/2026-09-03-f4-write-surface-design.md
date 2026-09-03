# F4 — Írás: a teendők és a naptár-visszavonás a felületen

**Állapot:** a tulajdonos távollétében írva, előzetes felhatalmazással
(„kezdd el magadtól a következő spec-et és implementation terv-et írni, majd
valósítsd is meg automatikusan"). Az öt részből álló front-end kiépítés
negyedik darabja (F1 váz ✓ · F2 diagram ✓ · F3 területi oldalak ✓ ·
**F4 írás** · F5 elemzés és beszélgetés).

**A távollétben hozott döntések** külön szakaszban, a spec végén, egy helyen
összeszedve — hogy visszatéréskor egy olvasással átnézhetők legyenek.

## Miért

A rendszer ma **tud** írni: a `ProposalService` elfogadja, elutasítja és
kipipálja a teendőket, naptárba ír, és vissza is tud vonni egy naptár-írást.
Mind a négy művelet kész, tesztelt, és a `/api/actions/*` meg a
`/api/calendar/writes/*` útvonalakon ki is van vezetve.

Egyetlen dolog nem éri el: **maga a weboldal.** A teendők a briefing
markdownjában szövegként megjelennek, de nincs mellettük gomb. Aki a
telefonjáról nyitja meg az oldalt reggel, csak elolvashatja, hogy „🚗
Kirándulás Szentendre — szombat (05.)", elfogadni nem tudja. Ahhoz Telegram
kell, vagy egy kézzel összerakott `curl`.

Az F4 tehát **nem ad új képességet a rendszernek.** Azt teszi elérhetővé a
felületen, amit a rendszer már tud — ugyanúgy, ahogy az F3 nem vezetett be új
adatot, csak megmutatta a meglévőt.

Ma kilenc teendő van nyitva, köztük két naptár-javaslat.

## Hatókör

**Beletartozik:** a nyitott teendők megjelenítése a Ma oldalon, kipipálás,
naptár-javaslat elfogadása és elutasítása, a visszavonható naptár-írások
listája és a visszavonás — mind JavaScript nélkül, űrlappal.

**Nem tartozik bele:** előfizetés szerkesztése (nincs mögötte szolgáltatás-
réteg, és a `markUsed` egy másik alrendszer); az elemzések böngészése és az
újratöltés nélküli chat (F5); bármilyen új írási képesség a maghoz.

## A megkötés, ami az egész alakját megszabja

**Ezen az oldalon nincs kliensoldali JavaScript.** Ez az F1 óta érvényes, és
nem esztétikai döntés: az oldal telefonról, Tailscale-en nyílik, és a
kiszolgált HTML a leggyorsabb, ami lehet. Két örökölt kivétel van — a token-
takarító script a fejlécben és a kérdés-űrlap küldője —, és ez a szám nem nő.

Írás JavaScript nélkül **HTML-űrlap**, és a helyes minta a
**POST → átirányítás → GET**: az űrlap POST-ol, a szerver elvégzi a
műveletet, majd `303 See Other`-rel visszaküld az oldalra. Enélkül a
frissítés újraküldené a POST-ot, és egy második naptár-esemény születne.

### Amit meg kellett mérni, nem feltételezni

A Fastify alapból **csak JSON-t** olvas. Egy `application/x-www-form-urlencoded`
POST — akár van mezője, akár nincs — **415 Unsupported Media Type**-ot kap.
Ezt lemértem, nem következtettem:

```
üres form-POST parser NÉLKÜL:   415 FST_ERR_CTP_INVALID_MEDIA_TYPE
mezős form-POST parser NÉLKÜL:  415 FST_ERR_CTP_INVALID_MEDIA_TYPE
form-POST parserrel (üres):     303 → /
form-POST parserrel (a=1):      303 → /
```

A megoldás **nem** a `@fastify/formbody` — a nulla új futásidejű függőség
kemény projektszabály. A beépített `URLSearchParams` négy sorban elvégzi:

```ts
app.addContentTypeParser(
  "application/x-www-form-urlencoded", { parseAs: "string" },
  (_req, body, done) => { done(null, Object.fromEntries(new URLSearchParams(body as string))); },
);
```

Az űrlapoknak amúgy **nem lesz mezőjük**: a teendő azonosítója az útvonalban
utazik. A parser attól még kell, mert a böngésző az üres törzset is ezzel a
content-type-pal küldi.

### CSRF: nincs új felület

A lap sütije `SameSite=Strict` (`auth.ts`), tehát **idegen oldalról indított
POST-tal a süti el sem indul.** Ez nem szerencse, hanem az F1-ben leírt
döntés, és pont ezért nem kell token-mező az űrlapokba. A spec kimondja, mert
ez az első kérdés, amit egy átnéző fel fog tenni.

## Útvonalak

```
POST /teendo/:id/kesz        egy checkbox kipipálása
POST /teendo/:id/elfogad     naptár-javaslat elfogadása (ez ír a naptárba)
POST /teendo/:id/elutasit    naptár-javaslat elutasítása
POST /naptar/:uid/visszavon  egy naptár-írás visszavonása
```

Mind a négy `303 See Other`-rel a `Location: /`-re küld vissza, és mind a négy
az F1 alapból-tiltó hitelesítése mögött van — nem `/api/` előtaggal, tehát az
oldal-hitelesítés (süti vagy bearer) őrzi őket, ugyanúgy, mint a lapokat.

A meglévő `/api/actions/*` és `/api/calendar/writes/*` JSON-útvonalak
**változatlanul maradnak.** A Telegram és a Shortcut azokat használja; ez a
négy új útvonal a böngésző saját, űrlapos bejárata ugyanahhoz a
szolgáltatáshoz. Két bejárat egy szolgáltatáshoz nem duplikáció: az egyik
JSON-t ad egy programnak, a másik átirányít egy embernek.

## A Ma oldal két új sávja

### Teendők

**Nem a mai nap teendői — az összes nyitott.** Ezt meg kellett mérni, mert az
első megfogalmazás hibás volt: ma 2026-09-03 van, és a kilenc nyitott tétel
dátuma 2026-08-30, 08-31 és 09-04. A `listOpen(ma)` **üres listát adna**, és a
Ma oldal azt állítaná, hogy nincs teendő, miközben kilenc nyitva áll.

Ennek oka a `replaceForDate` szerkezete: a modulok naponta lecserélik az adott
NAP teendőit, tehát egy másik napé nyitva marad örökre, ha senki nem zárja le.
Egy ki nem pipált kiolvasztás-emlékeztető négy nappal ezelőttről valódi
információ — arról, hogy nem lett lezárva.

Ezért az `ActionRepo` egy metódust kap: `listAllOpen()`. Egyetlen sor SQL, és
ez az egyetlen új képesség az egész F4-ben.

A lista **dátum szerint csoportosítva, a legfrissebbel elöl.** A dátum az a
tény, ami egy teendőt elhelyez; a modul neve soronkénti címke mellette.

**A modul címkéje a modul saját `title`-je**, nem egy kitalált fordítás: a
`action_items.module` a modul `name`-jét tárolja („FinanceAndSubs"), a
`ServerDeps.modules` pedig ott a szerveren, a saját címeivel („💰 Pénzügy &
Előfizetések", „🥾 Hétvége"). Ha egy modul már nem létezik, a nyers név marad
— egy eltűnt modulhoz kitalálni egy szép nevet hazugság volna.

Soronként a szöveg, mellette a művelet:

| Fajta | Gomb(ok) |
|---|---|
| `checkbox` | **Kész** |
| `proposal` | **Elfogadom** · **Elutasítom** |

A naptár-javaslatnál a szöveg alatt ott a javaslat lényege is: mikor kezdődik,
hol, és — ha van — a jegyzete. Ez ma csak a `proposal_json`-ben létezik, és
pont ez az, amit el kell olvasni, mielőtt az ember elfogad valamit. Egy
gombhoz, ami a naptárba ír, kevés a cím.

**Ha nincs nyitott teendő, a sáv elmarad** — nem üres címmel. Ez ugyanaz a
szabály, mint mindenütt: a hiány hiányzónak látsszon, az üres keret pedig nem
az.

### Visszavonható naptár-írások

`proposals.listUndoable(20)` — amit ma a naptárba írtunk, és amit vissza
lehet vonni. Soronként a cím, a kezdés és a naptár neve, mellette
**Visszavonom**.

Ez a sáv is elmarad, ha nincs mit visszavonni. És **csak akkor jelenik meg,
ha tényleg van** — nem előre kirakott üres doboz arra az esetre, ha egyszer
lesz.

## A hibák, amiket látni kell

Ez a spec érdemi része, mert egy írási művelet négyféleképp tud nem sikerülni,
és háromféleképp kellene róla beszélni.

A `ProposalService` négy hibakódot ad: `not_found`, `wrong_kind`,
`already_resolved`, `calendar_failed`. Átirányítás után a hiba nem él túl
magától, tehát a query stringben utazik: `/?hiba=<kód>`, és a Ma oldal tetején
egy sávban jelenik meg.

| Kód | Mit jelent | Hogyan jelenik meg |
|---|---|---|
| `calendar_failed` | az iCloud nem vette be az eseményt | **Sáv, `--riado` színnel.** A teendő nyitva marad, és a lap újraolvasás után meg is mutatja — tehát az ember látja, hogy újra próbálhatja. |
| `not_found` | nincs ilyen teendő (régi lap, kézzel írt URL) | Sáv, halványan. Nem riasztás: nem történt semmi, és nem is a szerver hibája. |
| `wrong_kind` | kipipálásra küldött naptár-javaslat vagy fordítva | Sáv, halványan. Ugyanaz: rossz kérés, nem hiba. |
| `already_resolved` | ezt már elintézted | **Nem jelenik meg semmi.** |

Az `already_resolved` külön magyarázatot érdemel, mert szándékos: ez az az
eset, amikor kétszer koppintasz a gombra, vagy visszalépsz és újra elküldöd.
A kívánt állapot **már fennáll**. Egy piros sáv arról, hogy „ezt már
elintézted", pontosan olyan riasztás lenne, ami mindig szól és semmit nem
jelent — az F1-ben ugyanezért nem kapott jelzőt a Számok menüpont. Az ember a
tettét akarta, és a tett megvan; csendben átirányítunk.

A `--riado` egyetlen új használata a `calendar_failed` sávja. Ez az egyetlen
hely, ahol tényleg elmaradt valami, amit kértél. A `--riado` mostanáig az
állapotsáv elmaradt-csatorna sora volt; ez a második, és a jelentése ugyanaz:
**ami esedékes volt és nem történt meg.**

## Ami szándékosan kimarad

- **Megerősítő párbeszéd az elfogadás előtt.** JavaScript nélkül ez egy plusz
  oldal lenne két koppintással, és az elfogadás visszavonható — a
  visszavonás-sáv pont ezért van ott. Egy visszavonható művelethez a
  megerősítés súrlódás, nem védelem.
- **Optimista kijelzés.** Nincs JS; a lap az átirányítás után újraolvassa az
  igazságot az adatbázisból. Ez lassabb és becsületesebb.
- **Törlés.** A teendő nem törölhető, csak lezárható — a `declined` is egy
  válasz, nem egy eltüntetés.
- **Tömeges műveletek** („mind kész"). Kilenc teendőnél kilenc koppintás; egy
  gomb, ami kilencet zár le egyszerre, könnyebben csúszik el, mint amennyit
  segít.
- **A régi nyitott teendők elrejtése vagy archiválása.** Kísértő, mert a lista
  idővel nőni fog, de bármilyen küszöb kitalált volna („hét napnál régebbi
  már nem érdekes"), és pont azt tüntetné el, ami a legtöbbet mondja: hogy
  valamit nem zártál le. Ha a lista kényelmetlenül hosszúra nő, az maga az
  információ, és akkor lehet róla dönteni — nem előre.

## Fájlszerkezet

```
ÚJ
  src/delivery/http/routes/writes.ts     a négy űrlap-útvonal
  src/delivery/http/view/actions.ts      a Teendők és a Visszavonás sáv

MÓDOSUL
  src/infra/db/repositories/actions.ts   listAllOpen()
  src/delivery/http/server.ts            a form content-type parser + registerWriteRoutes
  src/delivery/http/routes/page-shell.ts a hibakód beolvasása és továbbadása
  src/delivery/http/routes/page.ts       a Ma oldal két új sávja
  src/delivery/http/view/today.ts        a hibasáv és a két új sáv beillesztése
  src/delivery/http/view/theme.ts        űrlapgomb, hibasáv, teendő-sor
```

A `view/actions.ts` — mint minden `view/*` modul az F1 óta — **már lekérdezett
adatot kap és sztringet ad vissza.** Repository-hoz nem ér, és így adatbázis
nélkül tesztelhető.

## Hibatűrés

Az F1 óta érvényes minta: **minden darab magában bukik.** A teendők
lekérdezése és a visszavonható írásoké külön `try/catch`-et kap, saját
`logger.warn`-nal — egy hibázó `listUndoable()` nem viheti el a teendőket, és
egyik sem viheti el a briefinget.

Az írási útvonalakon más a szabály, mert ott a hiba **az ember kérdésére adott
válasz**: a `ProposalError` a fenti táblázat szerint hibakóddá alakul és
átirányítás után megjelenik. Bármi más — nem várt kivétel — 500-at ad, mert
egy néma átirányítás azt állítaná, hogy sikerült.

## Ellenőrzés

- mind a négy írási útvonal token nélkül **401**, tokennel működik, és a
  százalék-kódolt alakjuk (`/%74eendo/...`) sem csúszik át — ez az F1 záró
  reviewjának valódi lelete volt, és minden új útvonalra megismételjük;
- a form content-type parser nélkül a POST 415 lenne: a teszt ezt a
  regressziót fogja meg, nem a parser létezését állítja;
- **GET-tel egyik írási útvonal sem elérhető** (405 vagy 404) — egy állapotot
  változtató GET-et egy előtöltő böngésző vagy egy link-ellenőrző magától
  elsütne;
- minden művelet után `303` és `Location: /`;
- a `calendar_failed` sávja `--riado`-t kap, a `not_found` és a `wrong_kind`
  nem, az `already_resolved` **semmit** — mind a négy külön teszttel, és a
  sávra szűkített állítással, nem az egész lapra menővel;
- kétszer elküldött „Kész" nem hibázik és nem ír kétszer;
- a naptár-javaslat részletei (kezdés, hely, jegyzet) megjelennek, escape-elve
  — a `proposal_json` a modulokból jön, nem ebből a kódból;
- nyitott teendő nélkül a Teendők sáv **nincs ott**; visszavonható írás nélkül
  a Visszavonás sáv **nincs ott**;
- a Teendők sáv a **nem mai** nyitott tételeket is mutatja, a saját dátumukkal
  — ez az a hiba, amit a spec írása közben mértem ki, és a teszt pontosan azt
  a fixtúrát használja, ami elbuktatná a `listOpen(ma)`-változatot;
- a modul címkéje a modul saját `title`-je, ismeretlen modulnál a nyers név;
- **minden új teszt bukjon el a javítatlan implementáció ellen.** Az F3-on a
  tizenkét feladatból tizenegy igényelt plusz javítási kört, szinte mindig
  azért, mert egy teszt nem látta a hibát, amit őrizni hivatott — leggyakrabban
  úgy, hogy egy állítást a lap egy másik szakasza is kielégített. Minden
  állítást szűkíteni kell a saját sávjára.

## A távollétben hozott döntések

Ezeket visszatéréskor érdemes átnézni; mindegyik megfordítható.

1. **Az F4 nem ad új írási képességet**, csak a meglévő négyet vezeti ki a
   felületre. Az előfizetés-szerkesztés kimaradt: nincs mögötte
   szolgáltatás-réteg, és külön darab lenne. Az egyetlen új olvasó-képesség a
   `listAllOpen()`, és azért, mert a `listOpen(ma)` ma üres listát adna.
2. **Az összes nyitott teendő látszik, nem csak a maiak**, dátum szerint
   csoportosítva. Küszöböt nem vezettem be a régiekre — bármelyik szám kitalált
   lenne, és pont a „nem zártad le" jelzést tüntetné el.
3. **A teendők a Ma oldalra kerülnek**, nem külön lapra. A menü négy helye
   tele van, és a teendők a mai naphoz tartoznak.
4. **Az `already_resolved` néma.** A kívánt állapot fennáll; egy riasztás
   róla mindig szólna és semmit nem jelentene.
5. **Nincs megerősítő párbeszéd az elfogadás előtt**, mert a művelet
   visszavonható, és a visszavonás ott van a lapon.
6. **A naptár-javaslat részletei megjelennek a gomb mellett** — kezdés, hely,
   jegyzet. Egy naptárba író gombhoz kevés a puszta cím.
7. **A `--riado` második használatot kap** (`calendar_failed`). A jelentése
   nem tágul: ami esedékes volt és nem történt meg.
