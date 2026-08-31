# Apple Shortcut — reggeli briefing 07:30-kor

Egyetlen Shortcut, egyetlen Automation. A Shortcut előbb feltölti az éjszakai
Apple Watch adatot, majd lekéri a briefinget — így a szöveg már a mai
regenerációs adatot tükrözi.

## Miért egy Shortcut, két lépéssel?

A szintézis 10–40 másodperc. A Shortcuts ennyit nem vár ki megbízhatóan, ezért:

1. **07:20** — a szerver magától elkészíti a briefet (pre-warm).
2. **07:30** — a Shortcut elküldi az egészség-adatot; ez a háttérben azonnal
   újragenerálást indít.
3. A rögtön ezután következő `GET` ehhez a már futó generáláshoz csatlakozik,
   nem indít másodikat — és ha az bármiért nem készül el időben, az utolsó jó
   briefet kapja vissza. **Sosem lóg be.**

## A Shortcut lépései

Beállítások → Parancsok → új parancs. A `<TAILNET>` helyére a saját MagicDNS
neved kerül, a `<TOKEN>` helyére a `JARVIS_TOKEN`.

A teljes hosztnevet a `tailscale status` **nem** írja ki (csak a rövid gépnevet):

```bash
tailscale status --json | python3 -c "import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))"
```

### 1. Egészség-adatok kiolvasása

Négy **Egészségügyi minta lekérése** (Find Health Samples) blokk. Mindegyiknél
`Rendezés: Kezdés dátuma`, `Sorrend: Csökkenő`, `Határ: 1`:

| Típus | Változó neve |
|---|---|
| Alvási elemzés (Sleep Analysis) | `alvas` |
| Szívritmus-változékonyság (HRV SDNN) | `hrv` |
| Nyugalmi pulzus (Resting Heart Rate) | `rhr` |
| Aktív energia (Active Energy) — `Összeg`, `ma` | `mozgas` |

### 2. Adatok elküldése

**Tartalom lekérése URL-ből** (Get Contents of URL):

- **URL:** `https://jarvis.<TAILNET>.ts.net/api/ingest/health`
- **Metódus:** `POST`
- **Fejlécek:**
  - `Authorization` → `Bearer <TOKEN>`
  - `Content-Type` → `application/json`
- **Törzs:** `JSON`
  | Kulcs | Típus | Érték |
  |---|---|---|
  | `sleepH` | Szám | `alvas` (órában) |
  | `hrv` | Szám | `hrv` |
  | `rhr` | Szám | `rhr` |
  | `moveKcal` | Szám | `mozgas` |

  Minden mező opcionális — ha az óra egy éjszakát kihagyott, a brief attól még
  megjön.

### 3. Briefing lekérése

Még egy **Tartalom lekérése URL-ből**:

- **URL:** `https://jarvis.<TAILNET>.ts.net/api/morning-brief?format=text&wait=45`
- **Metódus:** `GET`
- **Fejléc:** `Authorization` → `Bearer <TOKEN>`

> `format=text` a fontos: az iOS értesítés **nem rendereli a markdownt**, a
> `##` és a `**` csak zaj lenne benne. A szerver `☐` karakterre cseréli a
> teendőket, és kiszedi a formázást.

### 4. Megjelenítés

**Értesítés megjelenítése** (Show Notification) az előző lépés eredményével.
Cím: `Jarvis`. Kapcsold be a `Hang` opciót, ha ébresztőnek is szánod.

## Automation

Parancsok → **Automatizálás** → `+` → **Napszak** → `07:30` → **Naponta** →
`Futtatás azonnal` + `Értesítés kikapcsolva` (különben dupla értesítést kapsz).

## Ellenőrzés

Futtasd kézzel a Shortcutot. Ha nem jön válasz:

```bash
tailscale status                    # fut a tailnet?
npm run smoke                       # minden hitelesítés rendben?
tail -f data/jarvis.log             # mit lát a szerver?
```

A telefonon a Tailscale appnak futnia kell (always-on VPN profil ajánlott).

## Tippek

- `?wait=0` — azonnali válasz a cache-ből, nem vár generálásra. Ha türelmetlen vagy.
- `?format=md` — markdown, ha valahol renderelve jelenítenéd meg.
- `?format=json` — teljes adat, benne a teendők azonosítói.
- Ha a Telegram bot is fut, ott a `/brief` ugyanezt adja, gombokkal.
