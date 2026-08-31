# Apple Shortcut — Apple Health adatok

> **A Shortcut dolga leszűkült: csak adatot küld.** Nincs briefing-lekérés és
> nincs iOS értesítés — a briefet a Macen kéred, amikor kell. Az Apple Health
> adatoknak viszont nincs más forrása, ezért a 2. lépés (POST az
> `/api/ingest/health`-re) marad.

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

## Ellenőrzés

Futtasd kézzel a Shortcutot. Ha nem jön sikeres válasz:

```bash
tailscale status                    # fut a tailnet?
npm run smoke                       # minden hitelesítés rendben?
tail -f data/jarvis.log             # mit lát a szerver?
```

A telefonon a Tailscale appnak futnia kell (always-on VPN profil ajánlott).
