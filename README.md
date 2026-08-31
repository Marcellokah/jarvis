# Jarvis

Személyi asszisztens. Reggel 07:30-kor egy értesítés, ami felkészít a napra —
és egy Telegram bot, amivel bármikor lehet beszélgetni róla.

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

Teljes telepítés (launchd, ébresztés, Tailscale): [`deploy/README.md`](deploy/README.md)
Az iPhone Shortcut: [`shortcuts/README.md`](shortcuts/README.md)

## Parancsok

```bash
npm run brief                      # brief a stdout-ra
npm run brief -- --format=md       # markdown
npm run brief -- --at=2026-09-04T06:20:00+02:00   # adott időpontra
npm run smoke                      # minden hitelesítés, titkok kiírása nélkül
npm test                           # 140 teszt, hálózat nélkül
npm run typecheck
```

## Hogyan marad ingyenes

A szintézis a **Claude Code előfizetésen** fut (`claude -p`), nem metered API-n.
Ha a CLI nincs bejelentkezve vagy elérhetetlen, a **template** renderelő veszi
át — teljes tartalommal, LLM nélkül. Ezért a 07:30-as értesítés soha nem marad el.

```
claude-code  →  template
   ingyenes     ingyenes, sosem bukik el
```

A fizetős `api` szintetizáló megvan, de **alapból ki van kapcsolva**, és a
`npm run smoke` ellenőrzi, hogy az is marad.

Az összes adatforrás ingyenes és kulcs nélküli: GitHub Releases, HN Algolia,
Open-Meteo, CheapShark, Telegram Bot API, iCloud CalDAV.

## Architektúra

```
iPhone Shortcut ─┐
                 ├─→ BriefService ─→ registry → runner → modulok
Telegram ────────┘         │
                           ├─→ szintézis: claude-code → template
                           └─→ renderer: ios-text | telegram-html | json
```

- **`src/core/`** — a motor. Nem tud a HTTP-ről és a Telegramról.
- **`src/modules/`** — egy mappa érdeklődési körönként. Új modul: írd meg,
  vedd fel a [`src/modules/index.ts`](src/modules/index.ts) barrelbe, kapcsold be a configban.
- **`src/delivery/`** — vékony adapterek ugyanarra a `BriefService`-re.
- **`jarvis.md`** — nem dokumentáció: ez megy át rendszerpromptként.

Naptárba írni kizárólag explicit elfogadás után lehet, kizárólag a dedikált
`Jarvis` naptárba, és minden létrehozott esemény visszavonható.
