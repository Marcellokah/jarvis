# Telepítés — $0/hó

Minden lépés ingyenes. Nincs VPS, nincs domain, nincs metered API.

## 1. Titkok a Kulcskarikába

```bash
./scripts/set-secret.sh JARVIS_TOKEN            # openssl rand -hex 32
./scripts/set-secret.sh GROQ_API_KEY            # console.groq.com → API Keys
./scripts/set-secret.sh TELEGRAM_BOT_TOKEN      # @BotFather → /newbot
./scripts/set-secret.sh ICLOUD_USERNAME         # az Apple ID email címed
./scripts/set-secret.sh ICLOUD_APP_PASSWORD     # appleid.apple.com → app-specific
```

A chat azonosítót nem kell külön megkeresned — a bot token eltárolása után:

```bash
npm run telegram:setup
```

Kiírja a bot nevét (ezzel ellenőrzi a tokent is), és a neked írt üzenetek
alapján megmutatja a chat azonosítódat. Így nem kell idegen botnak
(pl. `@userinfobot`) megmutatnod a profilodat egy szám kedvéért.

```bash
./scripts/set-secret.sh TELEGRAM_ALLOWED_CHAT_ID
```

> ⚠️ A chat azonosító nélkül **bárki**, aki megtalálja a botot, lekérdezheti a
> naptáradat és a pénzügyeidet.

> **iCloud felhasználónév:** az Apple ID email címed. Ha ez egy nem-Apple cím
> (pl. Gmail) és 401-et kapsz, próbáld az `@icloud.com` aliasodat helyette.
> A `npm run smoke` azonnal megmondja, melyik megy.

A `security add-generic-password` **sikeres esetben semmit nem ír ki**, és üres
vagy félremásolt értékre is `exit 0`-t ad — a hiba csak később, 401-ként derülne
ki. A `set-secret.sh` visszaolvassa és összeveti, amit írt.

## 2. Naptár

Hozz létre a Naptár appban egy **`Jarvis`** nevű naptárat. A rendszer kizárólag
ide ír, és ha nincs meg, inkább hibát jelez, mint hogy a valódi naptáradba írjon.

## 3. Indítás launchd alatt

```bash
cp deploy/local.jarvis.agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.jarvis.agent.plist
launchctl kickstart -k gui/$(id -u)/local.jarvis.agent
```

Ellenőrzés:

```bash
launchctl print gui/$(id -u)/local.jarvis.agent | head -20
tail -f data/jarvis.log
```

Leállítás — **mindig így**, ne `kill`-lel:

```bash
launchctl bootout gui/$(id -u)/local.jarvis.agent
```

A `kill`/SIGTERM szándékosan 143-mal lép ki, amire a launchd újraindítja: egy
véletlen szignál nem veheti el a Telegram botot és a HTTP API-t. Csak a
`bootout` állítja le tényleg.

Két eset lép ki 0-val, mert ott az újraindítás sem segítene — ilyenkor a
launchd békén hagyja:

- már fut egy másik példány (a lock miatt),
- a 8787-es port foglalt.

> **LaunchAgent, nem LaunchDaemon.** A daemon root-ként fut, nem látja sem a
> login Kulcskarikát, sem a Claude Code hitelesítést.

Ha korábban beállítottad az ébresztést, vond vissza:

```bash
sudo pmset repeat cancel
```

**Health-történet import közben az agent nem futhat.** Az agent tartja nyitva
az adatbázist; egy külön folyamat (az import script) írásai emiatt nem
maradnak meg — pár másodpercig látszanak, aztán eltűnnek. Az import ezt
induláskor felismeri, és inkább rögtön visszautasítja magát, mint hogy
csendben eldobja a beolvasott adatot. Állítsd le az agentet, futtasd le az
importot, utána indítsd újra:

```bash
launchctl bootout gui/$(id -u)/local.jarvis.agent
npm run import-health -- ~/Downloads/export.zip
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.jarvis.agent.plist
```

## 4. Elérés a telefonról — Tailscale

```bash
brew install --cask tailscale-app     # a cask neve `tailscale-app`, nem `tailscale`
tailscale up                          # böngészős bejelentkezés
tailscale set --hostname=jarvis       # innen lesz `jarvis.<tailnet>.ts.net`
```

Ezután **kapcsold be a HTTPS-t a tailnetben** — enélkül a következő parancs
némán, végtelenül várna a tanúsítványra:

> [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns) →
> **HTTPS Certificates** → *Enable HTTPS*

`tailscale status --json` a `CertDomains` mezőben visszaigazolja: `None` =
még ki van kapcsolva.

```bash
tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

> A `serve` CLI szintaxisa megváltozott. A régi `serve --bg https / <cél>`
> alak ma hibát ad; a séma és az útvonal elmarad, csak a cél URL kell.

Ez valódi HTTPS-t ad a stabil MagicDNS néven (`jarvis.<tailnet>.ts.net`),
**nyitott port, router-beállítás és publikus IP nélkül**. A Fastify csak
`127.0.0.1`-en figyel; a tailnet a határ, de a bearer token attól még kell.

> **A `serve` a teljes origint kiajánlja, a nyitólapot is.** A `GET /` ezért
> ugyanaz mögött a token mögött van, mint az `/api/*`: rajta van a briefing,
> minden elemzés, a számok és a teljes beszélgetés — egyetlen válaszban több,
> mint amennyit bármelyik API-végpont kiad. A védelem nem függhet attól, hogy
> a `serve` épp be van-e kapcsolva.

Az oldalt először a tokennel nyisd meg:

```
https://jarvis.<tailnet>.ts.net/?token=<JARVIS_TOKEN>
```

Ez egyszer fogadja el a query paramétert, és rögtön `HttpOnly`,
`SameSite=Strict` sütire cseréli. A további megnyitásokhoz (könyvjelző, frissítés)
nem kell újra a token, és nem is marad benne a címsorban.

Az iPhone-on legyen fent a Tailscale app, **ugyanazzal a fiókkal** belépve
(különben nem látja a gépet), always-on VPN profillal.

## 5. Ellenőrzés

```bash
npm run smoke
curl -sH "Authorization: Bearer $(security find-generic-password -s jarvis -a JARVIS_TOKEN -w)" \
  https://jarvis.<tailnet>.ts.net/api/morning-brief
```

## Napi működés

Nincs ütemezett brief. Te indítod, amikor kell:

| Ahogy kéred | Mi történik |
|---|---|
| `npm run brief` | A brief a terminálon, 15–25 másodperc alatt |
| Telegram `/brief` | Ugyanaz, gombokkal |
| `GET /api/morning-brief` | Ugyanaz, a telefonról vagy scriptből |

| Idő | Mi történik magától |
|---|---|
| 04:00 | Takarítás: lejárt cache és 21 napnál régebbi `seen_items` |

A launchd agent továbbra is fut, amíg a Mac be van kapcsolva — ettől elérhető a
Telegram bot és a HTTP API. **Nem ébreszti fel a gépet, és nem gyárt magától
briefet.**

Minden HTTP kérés bekerül a `data/jarvis.log`-ba (`msg: "request"`), a `/healthz`
kivételével — az `debug` szinten megy, hogy ne temesse maga alá az API-hívásokat.

A log **csak az útvonalat** írja ki, a query stringet nem. A `/?token=…` első
megnyitás különben plaintextben tenné lemezre a bearer tokent, pont abban a
fájlban, amit ez a leírás `tail -f`-fel néz.
