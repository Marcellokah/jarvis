# Jarvis

Személyi asszisztens. Brief kérésre — terminálból, Telegramból vagy a
telefonról — és egy Telegram bot, amivel bármikor lehet beszélgetni róla.

**Havi költség: $0.** Nincs VPS, nincs domain, nincs metered API.

## Mit tud

| Modul | Mit ad |
|---|---|
| 📅 `DailySchedule` | Mai naptár, korai kezdés figyelmeztetés |
| 🥦 `HealthAndMealPrep` | Alvás/HRV alapú regeneráció, napi étkezések, kiolvasztás-emlékeztető |
| 💰 `FinanceAndSubs` | Megújuló előfizetések (T-7/T-3/T-1), kihasználatlan szolgáltatások |
| 🥾 `WeekendPlanner` | Túra/horgászat/kirándulás időjárás és szabad naptár alapján |
| 🎮 `GamingAndTech` | Árfigyelés minden boltra (Steam, GOG, Epic, Humble…) |
| 🛠️ `DevStandup` | Stabil release-ek, HN válogatás, napi ClaudeCode tipp |

Ki-be kapcsolás: [`config/config.ts`](config/config.ts), egy `enabled` mező modulonként.

## Gyors indulás

```bash
npm install
./scripts/set-secret.sh JARVIS_TOKEN     # openssl rand -hex 32
npm run seed
npm run brief                             # a brief a terminálban
npm start                                 # HTTP API + Telegram bot
```

Teljes telepítés (launchd, Tailscale): [`deploy/README.md`](deploy/README.md)
Az iPhone Shortcut: [`shortcuts/README.md`](shortcuts/README.md)

## Parancsok

```bash
npm run brief                      # brief a stdout-ra
npm run brief -- --format=md       # markdown
npm run brief -- --at=2026-09-04T06:20:00+02:00   # adott időpontra
npm run smoke                      # minden hitelesítés, titkok kiírása nélkül
npm test                           # a teljes csomag, hálózat nélkül
npm run typecheck
npm run import-health -- ~/Downloads/export.zip   # Apple Health export beolvasása
npm run analyze                    # mélyelemzés a teljes történetből (~3 perc)
```

### Kérdezni

A rendszer két helyen fogad kérdést, és mindkettő ugyanazt a magot használja:

- **A helyi oldal** — `http://127.0.0.1:8787/?token=<JARVIS_TOKEN>`. Az oldal
  ugyanaz mögött a token mögött van, mint az API: rajta van a briefing, minden
  elemzés, a számok és a teljes szál. A token egyszer kell — a szerver
  `HttpOnly`, `SameSite=Strict` sütire cseréli, és a címsorból is kikerül. Az
  oldalon fent a mai briefing, alatta a legutóbbi mélyelemzés területenként, a
  számok táblázatban, legalul a kérdés-mező.
- **Telegram** — bármilyen sima szöveges üzenet a botnak. A parancsok
  (`/brief`, `/uj`, `/modules`, `/undo`, `/used`) változatlanok.

A modell területenként a legutóbbi elemzés összegzését látja a keletkezés
dátumával, a friss statisztikákat, a mai briefinget és a szál előző fordulóit.
A két felület **külön szálat** visz: a telefonon és a gép előtt feltett kérdés
más helyzet.

A beszélgetéseket a 04:00-s takarítás 30 nap után nyesi. A tartós emlékezet nem
ez, hanem az `analyses` tábla.

### Amikor magától szól

Negyedóránként ellenőrzi, van-e miért megszólalnia, és Telegramon szól. Két
kapun kell átjutnia: az utolsó ilyen üzenet óta eltelt négy óra, és 07:00 és
22:00 között vagyunk. Ha bármelyik zár, semmit nem csinál — nem is olvas. A
négy óra a legutóbbi *ellenőrzés* óta is számít, nem csak a legutóbbi üzenet
óta: egy néma napon sem futnak a modulok negyedóránként.

Három dolog éri meg neki:

- **Időzaklató teendő** — kiolvasztási határidő a következő négy órán belül,
  vagy ma, illetve holnap megújuló előfizetés. Az előfizetés nem határidő: nap
  a pontossága, nem óra, és nem lehet „lekésni”.
- **Egészségi eltérés** — a HRV másfél szórásra a saját 90 napos alapvonalától,
  vagy a nyugalmi pulzus 30 naponta legalább 2 bpm-es emelkedése. Mindkettőnek
  át kell mennie ugyanazokon a mintaszám-kapukon, amiket a mélyelemzés használ.
- **Új elemzési megállapítás** — ami az utolsó értesítés óta és 24 óránál nem
  régebben született.

Egy üzenetben legfeljebb öt tétel megy ki, a sürgősek elöl: ez értesítés, nem
jelentés. Ami kimaradt, azt nem jegyzi föl elküldöttként, tehát megmarad a
következő alkalomra.

Amit egyszer elmondott, azt nem mondja újra: a kulcsok a `seen_items` táblába
kerülnek, és a 04:00-s takarítás nyesi őket, tehát három hét múlva egy még
mindig fennálló dolog újra felszínre kerülhet.

A megfogalmazás a modellé, de a döntés nem: hogy egyáltalán megszólaljon-e,
azt küszöbök döntik kódban. Ha a modell nem érhető el, a tételek egyszerű
felsorolásként mennek ki — egy elmaradt határidő rosszabb, mint egy csúnya
mondat.

A kiküldött üzenetek a `notifications` táblában maradnak, tehát utólag
megnézhető, mit mondott és mikor.

### Egészség-történet

Az iPhone Health appjából (Profil → Összes egészségügyi adat exportálása) kapott
zip évekre visszamenőleg tartalmaz mindent. Egy import beolvassa napi bontásban.

Havonta érdemes újrafuttatni. Biztonságos: a meglévő méréseket soha nem írja
felül, csak a hiányzó mezőket tölti ki, és ugyanaz a zip kétszer futtatva
ugyanazt az állapotot adja.

Ha fut a launchd agent, ne közben futtasd. Amikor az agent nyitva tartotta az
adatbázist, háromszor is előfordult, hogy a beolvasott értékek nem maradtak
meg — hogy pontosan miért, azt nem sikerült kideríteni, a kézenfekvő
magyarázat (hogy egy másik folyamat írásai elvesznének) mérésekkel nem
igazolódott. Az ok tehát nyitott, a veszteség viszont valós volt, ezért az
import induláskor inkább hibával leáll, ha mást is nyitva talál, és a végén
egy friss kapcsolattal ellenőrzi, hogy tényleg megmaradt-e minden — az az
ellenőrzés az igazi garancia. Állítsd le előtte, utána indítsd újra — a pontos
parancssor: [`deploy/README.md`](deploy/README.md).

A napi Shortcut ettől független — az a mai adatot hozza, az import a múltat.

### Mit küld a telefon, és mikor

A Shortcut **két kérést** küld, mert a mérések nem egyszerre válnak teljessé.

**A mai napra** — ami reggel már végleges: HRV, nyugalmi pulzus, az éjszaka
**nyers alvás-mintái**, VO2max, pulzus-visszatérés, séta-pulzus, és a
járás-metrikák napi átlagai.

**A tegnapi napra** — ami csak a nap végén teljes: lépésszám, távolság, aktív és
alap kalória, edzésperc, emelet, állás-idő, és az étkezés.

Ez nem finomítás. A telefon írása felülírja a meglévőt, az importé nem — így egy
reggel elküldött részösszeg (fél nyolckor kétezer lépés) **véglegesen rögzülne**,
és a havi import soha nem tudná tizenegyezerre javítani.

Az alvást a telefon **nem összegzi**: az óra fázisonként külön mintát ír, és
Shortcutban nincs mód összeadni őket. A nyers mintákat küldi, és a szerver
ugyanazzal a logikával számol belőlük, amivel az importot dolgozza fel —
beleértve az átfedő források feloldását, amit a telefon sosem tudna.

Amit a szerver nem ért — ismeretlen alvás-fázis, értelmezhetetlen dátum,
váratlan mértékegység —, azt a válasz `ignored` tömbje **megnevezi**, ahelyett
hogy elnyelné.

### Mélyelemzés

`npm run analyze` végigmegy a teljes történeten, és területenként külön elemzést
ad: fizikai fejlődés, regenerálódás, pénzügy, majd egy összegzés, ami a
kiszámolt összefüggéseket nézi.

A számokat kód számolja, nem a modell — gördülő átlagok, trendek, korrelációk,
mindegyik mellett a lefedettséggel. A modell ezekre mond véleményt. Ha a Groq
nem elérhető, a számok akkor is kiíródnak.

Nagyjából három percig tart: hívásonként egy perc szünet, mert az ingyenes szint
6 000 tokent enged percenként, és így minden terület a teljes keretet kapja.

Minden lefutás elmentődik, és a következő elemzés területenként az utolsó három
összegzést látja — ettől tud olyat mondani, hogy „harmadik hónapja jelzem".

`GET /api/morning-brief` query paraméterei:

- `?wait=0` — azonnali válasz a cache-ből, nem vár generálásra. Ha türelmetlen vagy.
- `?format=md` — markdown, ha valahol renderelve jelenítenéd meg.
- `?format=json` — teljes adat, benne a teendők azonosítói.
- `?force` — figyelmen kívül hagyja a cache-t, mindig újragenerál.
- Ha a Telegram bot is fut, ott a `/brief` ugyanezt adja, gombokkal.

## Hogyan marad ingyenes

A szintézis és a chat a **Groq ingyenes tierjén** fut. A szolgáltatási szerződése
tiltja, hogy a bemeneteden tanítson, hacsak kifejezetten nem engedélyezed — ezért
esett rá a választás egy egészség- és pénzügyi adatokat hordozó rendszerben.

Ha a Groq nem elérhető, rate limitel, vagy a szerződésen kívüli kimenetet ad, a
**template** renderelő veszi át — teljes tartalommal, LLM nélkül.

```
groq  →  template
 ingyenes   ingyenes, sosem bukik el
```

A fizetős `api` szintetizáló megvan, de **alapból ki van kapcsolva**, és a
`npm run smoke` ellenőrzi, hogy az is marad.

Az ingyenes tier 6 000 token/percet ad. Ezért megy a promptba előre kiszámolt,
tömör tény a nyers történet helyett — és ez amúgy is pontosabb, mert egy modell
nem számol megbízhatóan átlagot.

Az összes adatforrás ingyenes és kulcs nélküli: GitHub Releases, HN Algolia,
Open-Meteo, CheapShark, Telegram Bot API, iCloud CalDAV.

## Architektúra

```
Bemenetek: npm run brief · Telegram · GET /api/morning-brief
              │
              ▼
        BriefService ─→ registry → runner → modulok
              │
              ├─→ szintézis: groq → template
              └─→ renderer: ios-text | telegram-html | json

iPhone Shortcut ─→ POST /api/ingest/health   (Apple Health adat, külön útvonal)
```

- **`src/core/`** — a motor. Nem tud a HTTP-ről és a Telegramról.
- **`src/modules/`** — egy mappa érdeklődési körönként. Új modul: írd meg,
  vedd fel a [`src/modules/index.ts`](src/modules/index.ts) barrelbe, kapcsold be a configban.
- **`src/delivery/`** — vékony adapterek ugyanarra a `BriefService`-re.
- **`jarvis.md`** — nem dokumentáció: ez megy át rendszerpromptként.

Naptárba írni kizárólag explicit elfogadás után lehet, kizárólag a dedikált
`Jarvis` naptárba, és minden létrehozott esemény visszavonható.
