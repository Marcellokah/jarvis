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
