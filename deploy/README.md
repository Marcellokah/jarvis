# Telepítés — $0/hó

Minden lépés ingyenes. Nincs VPS, nincs domain, nincs metered API.

## 1. Titkok a Kulcskarikába

```bash
./scripts/set-secret.sh JARVIS_TOKEN            # openssl rand -hex 32
./scripts/set-secret.sh CLAUDE_CODE_OAUTH_TOKEN # claude setup-token eredménye
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

## 2. Ingyenes próza (opcionális, de érdemes)

```bash
claude setup-token                                  # kiír egy sk-ant-oat01-… tokent
./scripts/set-secret.sh CLAUDE_CODE_OAUTH_TOKEN     # ezt tedd el
```

A `setup-token` **nem menti el magától** a tokent — csak kiírja. A Jarvis a
Kulcskarikából olvassa, és `CLAUDE_CODE_OAUTH_TOKEN` néven adja át a
gyerekfolyamatnak; így a launchd alól induló szerver is be tud jelentkezni,
pedig sem shell profilt, sem lemezre írt CLI-loginat nem örököl.

Nélküle a brief a **template** renderelővel készül — teljes tartalommal, csak
kevésbé folyékony szöveggel. Semmi nem törik el.

> A `claude auth status` bármilyen nem-üres tokenre `loggedIn: true`-t mond, a
> lejártra is. Egy visszavont token tehát átmegy az ellenőrzésen és csak a
> szintézisnél bukik el — ott viszont a fallback lánc elkapja.

## 3. Naptár

Hozz létre a Naptár appban egy **`Jarvis`** nevű naptárat. A rendszer kizárólag
ide ír, és ha nincs meg, inkább hibát jelez, mint hogy a valódi naptáradba írjon.

## 4. Indítás launchd alatt

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
véletlen szignál nem veheti el a holnap reggeli briefinget. Csak a `bootout`
állítja le tényleg.

Két eset lép ki 0-val, mert ott az újraindítás sem segítene — ilyenkor a
launchd békén hagyja:

- már fut egy másik példány (a lock miatt),
- a 8787-es port foglalt.

> **LaunchAgent, nem LaunchDaemon.** A daemon root-ként fut, nem látja sem a
> login Kulcskarikát, sem a Claude Code hitelesítést.

## 5. Ébresztés 07:15-re

A pre-warm 07:20-kor fut, de alvó gép nem futtat cront:

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 07:15:00
pmset -g sched          # ellenőrzés
```

> ⚠️ **Lecsukott fedél, akkumulátorról a gép így is alszik.** Ha ez a
> jellemző eset, hagyd nyitva/tápon, vagy vidd át a rendszert egy mindig ébren
> lévő gépre — a `node:sqlite` és a környezetből jövő konfiguráció miatt ez
> átírás nélkül megy (pl. Oracle Cloud Always Free ARM instance).

## 6. Elérés a telefonról — Tailscale

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

Az iPhone-on legyen fent a Tailscale app, **ugyanazzal a fiókkal** belépve
(különben nem látja a gépet), always-on VPN profillal.

## 7. Ellenőrzés

```bash
npm run smoke
curl -sH "Authorization: Bearer $(security find-generic-password -s jarvis -a JARVIS_TOKEN -w)" \
  https://jarvis.<tailnet>.ts.net/api/morning-brief
```

## Napi működés

| Idő | Mi történik |
|---|---|
| 07:15 | `pmset` felébreszti a gépet |
| 07:20 | pre-warm: modulok lefutnak, brief elkészül és eltárolódik |
| 07:30 | a Shortcut POST-olja az egészség-adatot, majd lekéri a briefet |
| 08:00 | ellenőrzés: jelentkezett-e ma a telefon. Ha nem, Telegram-riasztás |
| 04:00 | takarítás: lejárt cache és 21 napnál régebbi `seen_items` törlése |

Minden HTTP kérés bekerül a `data/jarvis.log`-ba (`msg: "request"`), a `/healthz`
kivételével — az `debug` szinten megy, hogy ne temesse maga alá azt az egy kérést,
ami reggelente számít. Az utolsó hitelesített `/api/*` hívás a `client_contact`
táblában is rögzül; erre épül a 08:00-s ellenőrzés.

A riasztás kikapcsolása, amíg a Shortcut még nincs kész:
`config/config.ts` → `schedule.contactAlert: false`.
