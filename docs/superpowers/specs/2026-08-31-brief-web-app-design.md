# Reggeli briefing mint weboldal

**Dátum:** 2026-08-31
**Állapot:** jóváhagyott terv, implementáció előtt

## Miért

A 07:30-as iOS értesítés a gyakorlatban használhatatlannak bizonyult: a brief
250 szó körüli, az értesítés csonkolja, és a `Show Notification` blokkra
**nem lehet linket akasztani** — a koppintás a Parancsok appot nyitja meg.
Interakció (teendő kipipálása, naptár-javaslat elfogadása, visszakérdezés)
szerkezetileg lehetetlen rajta.

A rendszernek már van interaktív felülete — a Telegram bot —, de az chat-buborék
marad. A briefingnek saját, tervezett felület kell.

## Nem cél

- Telegram push (a `/brief` parancs megvan)
- Offline működés, service worker
- Élő frissítés
- Bejelentkező felület
- **Bármilyen adatírás LLM-en keresztül**

## A három felület

| Felület | Szerep |
|---|---|
| iOS értesítés | Ébresztés és a kritikus teendők. 2–3 sor |
| Weboldal | A briefing otthona. Kezdőképernyőről egy koppintás |
| Telegram | Változatlan, de a chat-szálat megosztja az oldallal |

Reggeli folyamat:

```
07:20  pre-warm                                  (változatlan)
07:30  Shortcut: POST egészség-adat
       → GET /api/morning-brief?format=short
       → rövid értesítés
majd   koppintás a kezdőképernyő-ikonra → GET /brief
```

Az értesítés dolga az ébresztés és a cselekvést igénylő tételek átadása —
nem a tartalom szállítása. Ez szándékos: a weboldalhoz kell a tailnet, az
értesítéshez nem, tehát hálózat nélkül is nálad marad a lényeg.

## Végpontok

| Metódus | Útvonal | Mit ad |
|---|---|---|
| `GET` | `/brief` | HTML oldal. Süti hiányában `?token=` fogadható |
| `GET` | `/api/morning-brief?format=short` | Értesítés-méretű összefoglaló, sima szöveg |
| `POST` | `/api/chat` | `{ question }` → `{ answer }`, előzménnyel |
| `POST` | `/api/ingest/health` | kiegészül a `note` mezővel |

Már létező, változatlanul használt végpontok: `/api/actions/:id/done`,
`/accept`, `/decline`, `/api/calendar/writes/:uid/undo`.

## `format=short`

200 karakter alatt, hogy az iOS egészben mutassa. Tartalma sorrendben:

1. A regenerációs sor, ha van
2. **Minden nyitott teendő** `☐` prefixszel
3. Egy záró sor a többiről: `N megújuló előfizetés · +M szekció`

A `toSummary(markdown, actions)` a `core/renderer.ts`-be kerül, a meglévő
`toPlainText` és `toTelegramHtml` mellé.

## A weboldal

Szerver-oldalon renderelt HTML, build-lépés nélkül, minden beágyazva. A tailnet
a határ, de az oldal önhordó marad.

- Szekciók kártyaként, `critical` elöl — a `BriefService` már így rendezi
- Checkbox → `POST /api/actions/:id/done`
- `[Elfogadom]` / `[Elvetem]` → `/accept` · `/decline`
- Chat mező → `POST /api/chat`, látható „gondolkodik" állapottal
- Jegyzet mező → `POST /api/ingest/health` a `note` mezővel
- Frissítés → `?force=true`
- Sötét felület alapból; `apple-mobile-web-app-capable`, ikon, `theme-color`

Az oldal a gyorsítótárból olvas (`wait=0`), tehát azonnal nyílik — a 07:20-as
pre-warm már elkészítette.

## Hitelesítés

Egy böngészőoldal nem tud magától bearer fejlécet küldeni.

1. `GET /brief?token=<JARVIS_TOKEN>` — egyszer, kézzel
2. A szerver `HttpOnly; Secure; SameSite=Strict` sütit állít, hosszú élettartammal
3. A kezdőképernyő-ikon ezután token nélküli URL-t nyit
4. Az `/api/*` hívások a sütivel mennek

A `bearerAuth` mindkét hordozót elfogadja — ugyanaz a titok. A tailnet marad a
külső határ, a token a belső.

## Chat és előzmény

A `ChatService.ask(kérdés, briefMarkdown, signal)` ma **állapotmentes**: minden
kérdés magában áll, csak a mai brief a kontextus. Ezért „részletezd a pénzügyi
részt" működik, de „és a másikat?" elveszti a fonalat.

A `conversations` tábla a 002-es migrációból **létezik, de senki nem használja**
(`chat_id`, `role`, `content`, `created_at`). Ez kap gazdát:

- `chat_id` a felület azonosítója; a weboldal és a Telegram **ugyanazt** használja,
  így a szál közös a két felület között
- Előzmény-ablak: a mai nap, legfeljebb 20 forduló
- A 04:00-s takarítás viszi a régit, a `seen_items` mellett

## A jegyzet, és a határ

Új `note` oszlop a napi `health_snapshots` soron. Szabad szöveg, a felhasználó
írja, szó szerint tárolódik, és ténymezőként megy át a szintetizálónak.

**A chat magyaráz, a strukturált vezérlők írnak.** Egy LLM nem írhatja felül a
mért adatokat szabad szövegből: a `baseline()` a korábbi napok mért értékeiből
számol, tehát egy félreértett mondat nemcsak a mai briefet rontaná el, hanem a
holnapi kiindulópontot is.

Ha a jegyzet azt mondja, „jól aludtam", az bekerül a szövegbe — de a `sleepH`
üres marad. Ugyanaz az elv, mint a naptárnál: valódi adatot csak explicit,
strukturált művelet ír.

## Érintett fájlok

| Fájl | Változás |
|---|---|
| `src/core/renderer.ts` | `toHtml()`, `toSummary()` |
| `src/core/chat.ts` | előzmény paraméter |
| `src/delivery/http/routes/page.ts` | **új** — `GET /brief` |
| `src/delivery/http/routes/chat.ts` | **új** — `POST /api/chat` |
| `src/delivery/http/auth.ts` | süti is, nem csak bearer |
| `src/delivery/http/routes/brief.ts` | `format=short` |
| `src/delivery/http/routes/ingest.ts` | `note` mező |
| `src/infra/db/migrations/004_note_and_conversations.sql` | `health_snapshots.note` |
| `src/infra/db/repositories/conversations.ts` | **új** — előzmény-tár |
| `src/modules/health-mealprep/index.ts` | a jegyzet megjelenítése |
| `src/infra/scheduler.ts` | `conversations` takarítása |

A `core/` a rendereren és a chaten túl nem változik. A `BriefService` érintetlen:
a weboldal ugyanolyan vékony adapter, mint a Telegram és a HTTP API.

## Tesztelés

Hálózat nélkül, a meglévő `buildTestApp` harnesszel:

- `toSummary` — teendők bekerülnek, hossz a korlát alatt, hiányzó regeneráció kimarad
- `toHtml` — szekciók, checkboxok, javaslat-gombok; HTML-escape
- Süti-hitelesítés — `?token=` sütit állít; süti nélkül 401; rossz süti 401
- `POST /api/chat` — előzményt kap, választ ad; nem elérhető CLI esetén beszédes hiba
- Előzmény-tár — mai napra szűr, 20 fordulónál levág, takarítás töröl
- `note` — eltárolódik, megjelenik a brief adatában, **nem írja felül a mért mezőket**

## Kockázatok

- **Az oldalhoz kell a Tailscale.** Ezért marad az értesítésben a teljes teendő-lista.
- **A chat 5–15 másodperc** (haiku, CLI-n át). Látható várakozó állapot nélkül halottnak tűnik.
- **A jegyzet bekerül az LLM promptjába**, tehát formálja a brief hangnemét. Ez a cél, de legyen tudatos.

## A chat modellje: telepítési döntés, nem tervezési

A `ChatService` interfész mögött ma a `claude-code` fut. Hogy éles üzemben mi lesz
mögötte — személyes Anthropic API kulcs Haiku 4.5-tel, lokális modell az
Oracle gépen, vagy továbbra is `claude -p` —, az **konfiguráció**, nem
architektúra. Ez a munka egyik változatot sem köti be; a weboldal az interfészt
hívja.

### A cost guard szétválasztása

A `npm run smoke` ma összemossa két különböző dolgot:

```
✓ cost: no paid synthesizer      chain = claude-code → template
✓ cost: ANTHROPIC_API_KEY unset
```

Ha a chat egyszer API kulcsot használ, a második ellenőrzés elbukik — pedig a
szintézis attól még ingyenes maradna. A két állítás szét kell hogy váljon:

- **`cost: no paid synthesizer`** — a szintézis lánca nem tartalmaz fizetős elemet.
  Ez marad kőbe vésve; a napi brief soha nem kerülhet pénzbe.
- **`cost: chat provider`** — melyik szolgáltató szolgálja ki a chatet, és
  fizetős-e. Jelentés, nem tiltás: a chat használat-arányos és a felhasználó
  indítja, szemben a napi automatikus brieffel.

## Host-függetlenség

A terv egyetlen eleme sem függ attól, hol fut a szerver. A tervezett Oracle Cloud
ARM migráció (külön spec) ezt a munkát nem érinti, és fordítva.

## Ami ezután jön, és mi nem ennek a része

Egy elemzési réteg (`baseline()` bekötése, több napos trendek, a szintetizáló
promptjának kibővítése előzménnyel) **külön spec és külön terv**. A `jarvis.md`
felhasználói profilja kéri („Elemzés: Kimutatások rendszeres bekérése"), és ma
semmi nem szolgálja ki, de nem ennek a munkának a része.

Egy kapcsolódás mégis van, és a terv számoljon vele: az elemzési réteg a `note`
mezőt és a chat előzményét is fel fogja használni. Egyik sem igényel most
előrehozott munkát — csak ne szülessen olyan döntés, ami később útban lenne.
