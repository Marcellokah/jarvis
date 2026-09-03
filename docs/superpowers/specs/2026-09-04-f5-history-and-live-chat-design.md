# F5 — Elemzés-előzmény és újratöltés nélküli beszélgetés

**Állapot:** a tulajdonos távollétében írva, előzetes felhatalmazással
(„Mehet az F5 is… Dönts, és jelöld meg"). A front-end kiépítés ötödik és
utolsó darabja (F1 váz ✓ · F2 diagram ✓ · F3 területi oldalak ✓ · F4 írás ✓ ·
**F5 előzmény és beszélgetés**).

A távollétben hozott döntések a spec végén, egy helyen.

## Miért

Két dolog maradt, és mindkettő ugyanarról szól: **a rendszer tud valamit, amit
a felület eldob.**

**Az elemzés-előzményt.** Az `analyses` tábla minden futás minden elemzését
megtartja, és az `AnalysisRepo`-nak van rá metódusa (`recent(domain, n)`). A
területi oldalak mégis kizárólag a legfrissebbet mutatják. Ma hat elemzés van
— a fizikaiból és a regenerációsból kettő-kettő —, és a régebbiek
elérhetetlenek. Egy elemzés akkor ér a legtöbbet, ha látszik, mihez képest
mondja, amit mond: „a HRV javul" önmagában állítás, a két hete írt előző
elemzés mellett viszont bizonyíték.

**A beszélgetés folytonosságát.** A `/kerdes` lap már ma is JavaScripttel
küld — `fetch("/api/chat")` —, és a válasz megérkezésekor **`location.reload()`-ot
hív.** Az egész lap újraépül: a görgetési pozíció elveszik, a briefing, a
mérések és a diagramok mind újra lekérdeződnek, és a beszélgetés fonala
elszakad egy villanásra. A szerver közben már a kezében tartja a választ.

Egyik sem új képesség. Mindkettő olyan adat, ami megvan, és amit a felület
kidob.

## Hatókör

**Beletartozik:** a korábbi elemzések megjelenítése a területi oldalakon és a
hubon; a chat-válasz beillesztése a fonálba újratöltés nélkül.

**Nem tartozik bele:** új elemzési domain (az S8 hozza a táplálkozásit);
beszélgetés-előzmény lapozása; a Telegram-oldal bármely része.

## A JavaScript-kérdés, kimondva

A projekt kemény szabálya, hogy **ezen az oldalon nincs kliensoldali
JavaScript**, és ez az F1 óta így van. Az F5 mégis „újratöltés nélküli
chat"-et ígér, ami első hallásra pont ezt sérti. Nem sérti, és érdemes
kimondani, miért:

A szabálynak **két örökölt kivétele van** — a token-takarító a fejlécben és a
kérdés-űrlap küldője —, és a kimondott elv az, hogy **ez a szám nem nő.** Az
F5 nem növeli: a `/kerdes` lap scriptje már létezik, már `fetch`-el, és már
kezeli a hibát. Az F5 **egyetlen sorát cseréli le** — a `location.reload()`-ot
—, arra, hogy a választ beteszi a fonálba.

Ez szűkítés, nem tágítás: kevesebb hálózati kérés, kevesebb újraszámolt
adat, ugyanannyi script-felület. Semmilyen új lapra nem kerül JavaScript, és
az **elemzés-előzmény kifejezetten JS nélkül** készül (lásd lentebb).

## Elemzés-előzmény

**Natív `<details>`, nulla JavaScripttel.** A HTML-nek van összecsukható
eleme; egy JS-es harmonika ugyanezt adná, több kóddal és rosszabb
billentyűzet-eléréssel.

Minden területi oldal elemzés-sávja alá kerül egy `<details>`, benne a
domain **korábbi** elemzései — a legfrissebb már a sávban van —, egyenként a
dátumukkal és a saját `summary` mezőjükkel. A `summary` pontosan erre való: a
következő futás is ezt olvassa vissza, egy bekezdés az egész.

- **A `<summary>` felirata megmondja, hányan vannak**: „3 korábbi elemzés".
  Egy „Korábbiak" felirat nem árulja el, hogy érdemes-e kinyitni.
- **Ha nincs korábbi, a `<details>` nincs ott.** Nem üres, nem letiltott —
  nincs. Ugyanaz a szabály, mint mindenütt.
- Legfeljebb **öt** korábbi jelenik meg. A hatodiktól a lista már nem
  előzmény, hanem archívum, és annak külön hely kell — ez az F5 hatókörén
  kívül van, és a spec ezt kimondja, hogy ne látsszon feledékenységnek.
- A hubon ugyanez, az `synthesis` domainre.

A `AnalysisRepo.recent(domain, n)` már létezik és a legfrissebbel kezd, tehát
a sávban lévőt az első elem elhagyásával kapjuk meg — nincs új lekérdezés,
nincs új repository-metódus. **Az F5 egyetlen sor SQL-t sem ír.**

## Újratöltés nélküli beszélgetés

Ma: `fetch` → `location.reload()`. Ezután: `fetch` → a válasz bekerül a
fonálba, a mezőbe lehet írni tovább.

**A markdown a szerveren renderelődik, nem a böngészőben.** A válasz
markdown, a lap markdownként mutatja, és a szervernek már van renderelője
(`renderMarkdown`), ami escape-el is. Egy második, kliensoldali renderelő
ugyanannak a munkának a megkettőzése lenne, új kóddal, ami eltérhet — és
pont a modell által írt szövegre.

Ezért a `POST /api/chat` válasza egy mezővel bővül:

```jsonc
{
  "answer": "…",   // változatlan: a nyers markdown
  "html": "…"      // ÚJ: ugyanaz renderMarkdown-on átvezetve
}
```

Az `answer` marad, mert a válasz szerződése nem törhet el. Ellenőriztem: az
`/api/chat`-et **kizárólag a lap saját scriptje hívja** — a Telegram a saját
útján megy (`delivery/telegram/responses.ts`), a Shortcut nem hívja. A
bővítés tehát senkit nem érint.

A script a beszélgetés-fonál végére fűz két blokkot, ugyanabban az alakban,
amit a szerver ad egy újratöltésnél:

1. a kérdés `Te` felirattal — **escape-elve**, mert amit az ember gépel, az
   nem HTML;
2. a válasz `Jarvis` felirattal, a szervertől kapott `html`-lel.

Utána a mező kiürül, újra írható, és a fókusz visszakerül rá — a
folytonosság maga a funkció.

**Hiba esetén a mai viselkedés marad**, változtatás nélkül: a gomb „Újra"
lesz, a hibaszöveg a doboz mellé kerül, a mező újra írható, és a fenti
tartalom érintetlen. Ez az ág ma is helyes, és nincs okunk hozzányúlni.

**Ami JS nélkül is működik:** a fonál a szerverről jön, tehát scriptet nem
futtató böngészőben az űrlap sima POST-ként… **nem működik**, mert nincs
`action`. Ez ma is így van, és az F5 nem rontja tovább — de mivel az F4-ben
épp most tanultuk meg, hogyan kell egy űrlapot JS nélkül elküldeni, a spec
kimondja: ez tudatos maradás, nem feledékenység. A chat-válasz 90 másodpercig
is eltarthat, és egy 90 másodpercig üres böngészőablak rosszabb, mint egy
gomb, ami közben azt mondja, dolgozik.

## Fájlszerkezet

```
MÓDOSUL
  src/delivery/http/view/area/frame.ts   analysisBand előzmény-blokkja
  src/delivery/http/view/area/hub.ts     ugyanaz a synthesis-re
  src/delivery/http/routes/areas.ts      a korábbi elemzések átadása
  src/delivery/http/routes/page.ts       az /api/chat válasz html mezője
  src/delivery/http/view/ask.ts          a script: reload helyett beillesztés
  src/delivery/http/view/theme.ts        a <details> és a fonál stílusa
```

Nincs új fájl, nincs új útvonal, nincs új repository-metódus. Az F5 a
legkisebb darab az ötből, és ez rendben van: a többi már megépítette, amire
támaszkodik.

## Hibatűrés

A területi oldalak mintája változatlan: a korábbi elemzések lekérdezése
**ugyanabba a `try/catch`-be** kerül, mint a legfrissebbé — egy forrás, egy
hiba, egy `logger.warn`. Ha elszáll, az elemzés-sáv és az előzménye együtt
marad el, a lap többi része áll.

A chat scriptje már ma is elkap mindent; az egyetlen új hibaág az, ha a
válaszban **nincs** `html` mező (régi szerver, félbeszakadt telepítés). Akkor
a script visszaesik a mai viselkedésre, `location.reload()`-ra — a válasz
megvan, csak a lapon keresztül jön elő. Kimarad-e valami? Nem: az
újratöltés a szerver igazságát mutatja.

## Ellenőrzés

- korábbi elemzés nélkül **nincs `<details>`** — sem üresen, sem letiltva;
- egy korábbival egy tétel, hattal öt, és a `<summary>` felirata a valódi
  darabszámot mondja;
- a `<details>` a domain SAJÁT korábbi elemzéseit mutatja, nem a másikét — a
  teszt fixtúrája két domaint tölt fel, hogy a keresztbe-szivárgás kiderüljön;
- a legfrissebb elemzés **nem** jelenik meg kétszer (a sávban és a listában
  is);
- a modell írta szöveg escape-elve jelenik meg az előzményben is;
- a `POST /api/chat` válasza `answer` ÉS `html` mezőt is ad, és a `html` a
  szerver `renderMarkdown`-jának a kimenete — a teszt olyan markdownt küld,
  aminek a renderelt alakja felismerhetően más (`**félkövér**`);
- a `html` escape-eli a modell által írt HTML-t;
- a script a kérdést `textContent`-tel teszi be, a választ `innerHTML`-lel —
  a teszt a script SZÖVEGÉBEN állítja ezt, mert kliensoldali futtatás nélkül
  ez az, ami ellenőrizhető, és a spec ezt kimondja, hogy ne látsszon többnek;
- `location.reload()` már csak a `html` hiányának ágán szerepel;
- **minden új teszt bukjon el a javítatlan implementáció ellen.** Az F3-on
  tizenkét feladatból tizenegy, az F4-en négyből négy igényelt plusz kört,
  szinte mindig azért, mert egy teszt nem látta a hibát, amit őrizni hivatott
  — háromszor úgy, hogy maga a TERV tesztje volt tautologikus. Minden
  állítást a saját sávjára kell szűkíteni, lusta, jobbról lehorgonyzott
  kivonattal.

## A távollétben hozott döntések

Mindegyik megfordítható.

1. **Az „újratöltés nélküli chat" nem növeli a JS-felületet**, egyetlen sort
   cserél a már meglévő scriptben. Ha ezt szűknek találod, a másik irány egy
   teljes JS-mentes chat lenne — de az 90 másodperces üres ablakot jelentene.
2. **A markdown a szerveren renderelődik**, és a válasz egy `html` mezővel
   bővül. A kliensoldali renderelő megkettőzné a munkát, épp a modell által
   írt szövegen.
3. **Az elemzés-előzmény natív `<details>`**, nulla JavaScripttel.
4. **Legfeljebb öt korábbi elemzés.** A hatodiktól archívum, és az külön
   hely — nem az F5-é.
5. **A `<summary>` felirata a darabszámot mondja**, nem egy semleges
   „Korábbiak"-at.
6. **Az űrlap JS nélkül továbbra sem küld** — tudatos maradás, mert a 90
   másodperces válaszidő alatt egy néma böngészőablak rosszabb, mint egy
   gomb, ami mondja, hogy dolgozik.
