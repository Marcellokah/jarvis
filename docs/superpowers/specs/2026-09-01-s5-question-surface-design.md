# S5 — Kérdés-felület

**Dátum:** 2026-09-01
**Állapot:** elfogadott, implementálásra vár
**Előzmény:** S1+S4 (Groq-szintézis), S2 (adatalap), S3 (aggregáció és mélyelemzés)

## Kiindulás

Az ág az `s3-aggregation`-ről indul, nem a `main`-ről: ez a munka az S3
elemzéseire és az `aggregate()`-re épül, és az S3 pull requestje még nyitva van.

## Cél

Kérdezni lehessen a rendszertől — a hét év történetéről, az S3 elemzéseiről és a
mai napról —, két helyről: egy helyi weboldalról és Telegramról.

## Amit már tud, és amit nem

Ezt mérni kellett, mert a kiindulás nem az volt, aminek látszott.

**Már megvan:**

- A `groqChat` **be van kötve** (`src/app.ts`), és a Telegram sima szöveges
  üzenetei már ide futnak (`bot.on("message:text")`). Chatet nem kell építeni.
- A `conversations` tábla a 002-es migrációban létezik, és pontosan a megfelelő
  alakú: `chat_id`, `role` (CHECK: `user` | `assistant`), `content`,
  `created_at`, indexszel. **Soha senki nem használta.**
- A szerver a `127.0.0.1:8787`-en figyel, a bearer-hitelesítés az `/api/*`
  útvonalakat védi.

**Ami hiányzik:**

- A chat kontextusa **kizárólag a mai brief markdownja**
  (`ask(question, briefMarkdown, signal)`). Az S3 elemzéseit és a
  statisztikákat nem látja — vagyis épp arról nem tud beszélni, amiért az S3
  megépült.
- **Nincs emlékezet.** Minden kérdés tiszta lappal indul; visszakérdezni nem
  lehet.
- **Nincs `POST /api/chat`** és nincs semmilyen HTML-felület.

**Halott ág, amit ez a munka takarít el:** a `claudeChat` a `src/core/chat.ts`-ben
senkinek nem hívja. A `groqChat` váltotta le; a régi maradt.

## Felépítés — egy mag, két ajtó

### 1. A kontextus összeállítása

Új modul: `src/core/ask/context.ts`. Összerakja, amit a modell lát:

| Rész | Honnan | Kb. token |
|---|---|---|
| A rendszerprompt | `jarvis.md`, **minden** hívásban | ~2 300 |
| Területenként a legutóbbi elemzés összegzése | `analyses.latestPerDomain()` | ~600 |
| A friss statisztikák, megnyirbálva | `aggregate()` a repókból | ~1 100 |
| A mai briefing | `briefs.cached()` | ~350 |
| A szál utolsó fordulói (**2 forduló**) | `conversations.recent()` | ~250–650 |
| **Bemenet, legrosszabb eset** | | **~5 000** |
| A válasz | `config.groq.chatMaxTokens` | 800 |
| **Összesen, prompt + completion** | | **~5 800** |

**Kétszer javítva, és ez a második javítás a lényeg.** Az eredeti táblázat
~2 900-at mondott, és kihagyta a `jarvis.md`-t (~2 300 token, minden hívásban).
Az első javítás visszatette, de **továbbra is csak a bemenetet** hasonlította a
plafonhoz — pedig a Groq ingyenes szintjének 6 000 token/perce a promptot **és a
választ együtt** méri. Ugyanaz az alul-jelentés, egy nagyságrenddel kisebben.

A mérés: egy kérdés ~4 300 bemeneti token üres szállal, és 5 100–6 300 egy
hatfordulós szállal — vagyis a szál maga 750–1 950 hat fordulóra, fordulónként
125–325 token. Ebből:

| Mélység | Bemenet | + 800 válasz | Belefér? |
|---|---|---|---|
| 6 | 5 100–6 300 | 5 900–7 100 | nem |
| 4 | 4 850–5 650 | 5 650–6 450 | nem |
| 3 | 4 725–5 325 | 5 525–6 125 | nem |
| **2** | **4 600–5 000** | **5 400–5 800** | **igen, 200 tartalékkal** |

Ezért `config.groq.chatHistoryDepth` = **2**: az utolsó váltás, vagyis az előző
kérdés és a rá adott válasz. Egy követő kérdéshez („és tavaly?") pont ez kell.

**Ez nem kemény korlát, és ezt ki kell mondani.** A fordulónkénti 125–325 mért
átlag, nem plafon: egy szándékosan maximális forduló — 2 000 karakteres kérdés
plusz egy teljes 800 tokenes válasz — önmagában ~1 400 token, és ezt 1-nél nagyobb
mélységnél semmilyen aritmetika nem korlátozza. Az az eset egy Groq 429, amit
mindkét ajtó **kimond** (a lap 502-vel, a Telegram „⚠️ Nem sikerült válaszolni"
üzenettel), nem pedig csendben csonkolt válasz.

Egy kérdés tehát belefér; kettő ugyanabban a percben nem biztos, és ezt a hibát
ki kell mondani, nem elnyelni. Ugyanezért olvas a lap és a kérdés is
`briefs.cached()`-et és nem `briefs.get()`-et: egy brief-generálás önmagában egy
teljes Groq hívás lenne ugyanabban a percben, olyasmiért, amit senki nem kért.

Egy alul-jelentett keret pontosan az a magabiztosan téves szöveg, ami ellen ez a
projekt épült — és ez a táblázat kétszer volt az, mielőtt összeállt a számtan.

Minden elemzés-összegzés mellé megy a keletkezése ideje. Egy három hónapja
készült pénzügyi megállapítás nem ugyanaz, mint egy mai, és a modellnek látnia
kell a különbséget — különben frissként hivatkozik rá.

**A statisztikák ugyanabból az `aggregate()`-ből jönnek, amit az S3 használ.**
Nem másolat és nem közelítés: a kérdésre adott válasz ugyanarra a bizonyítékra
támaszkodik, mint az elemzés, különben a kettő ellentmondhat egymásnak.

**De nem a teljes `Metrics` megy át.** Az S3 záró review-ja megmérte: a
`physical.byMonth` 2019 óta minden hónapot visz, önmagában ~4 985 karakter, és a
teljes fizikai szelet ~2 000 token. A négy szelet együtt szétfeszítené a keretet
azelőtt, hogy a kérdés sorra kerülne.

A kontextus ezért **nyírt nézetet** küld: a `byMonth`-ból az utolsó tizenkét
hónap, a lefedettségek két tizedesre kerekítve, és a JSON behúzás nélkül. A
nyírás a `context.ts` dolga és tesztelt — nem az `aggregate()`-et változtatjuk
meg, mert az elemzésnek továbbra is a teljes kép kell.

Az elhagyott részekről a prompt szól egy sorban („a havi bontásból az utolsó
tizenkét hónap látszik"), különben a modell a hiányt adathiánynak olvassa, és
arról mond véleményt.

### 2. Az emlékezet

`src/infra/db/repositories/conversations.ts` — `append(chatId, role, content, now)`,
`recent(chatId, n)`, `prune(before)`.

A `chat_id` a szál azonosítója: Telegramon a Telegram chat-azonosító, a weben egy
rögzített `"web"`. Ettől a két felület **külön szálat** visz, ami szándékos: a
telefonon feltett kérdés és a gép előtt feltett kérdés más helyzet.

A `prune` a meglévő 04:00-s takarításba kerül, a `seen` mellé. Egy beszélgetés
nem őrizendő örökre; a tartós emlékezet az `analyses` tábla dolga.

### 3. A kérdés-mag

A `ChatService.ask` szignatúrája megváltozik:

```ts
ask(chatId: string, question: string, signal: AbortSignal): Promise<string>
```

A `briefMarkdown` paraméter eltűnik — a kontextust a mag maga állítja össze. A
hívás: előzmény betöltése → kontextus → Groq → a kérdés és a válasz elmentése.

**A mentés csak sikeres válasz után történik**, mindkét fordulóé egyszerre. Egy
elszállt hívás nem hagyhat maga után egy kérdést válasz nélkül a szálban: a
következő kérdésnél az úgy nézne ki, mintha a modell nem felelt volna, és a
modell erre magyarázatot kezdene gyártani.

### 4. A weboldal

`GET /` — kiszolgáló-oldalon renderelt HTML, **build lépés és új függőség
nélkül**. Fentről lefelé:

1. A mai briefing, a teendőkkel
2. A legutóbbi elemzés területenként, a keletkezés dátumával
3. A számok táblázatban — gördülő átlagok, trendek, lefedettség
4. A kérdés-mező és a szál

**Markdown → HTML, könyvtár nélkül.** Ez a felület egyetlen érdemi kockázata, és
azért vállalható, mert a megjelenítendő markdown **a saját promptjaink terméke**,
ismert szerkezettel: `#`–`###` címsorok, `-` felsorolás, `- [ ]` teendő,
`**félkövér**`, `` `kód` ``, üres sorral elválasztott bekezdés. Egy ~60 soros
részhalmaz-renderelő elég rá, és tesztelhető.

Amit a renderelő **nem** ismer, azt szó szerint, escape-elve írja ki — nem
próbálja kitalálni. Egy félreértelmezett formátum rosszabb, mint egy csúnya sor.
Minden beírt szöveg escape-elve megy ki; a modell válasza sem kivétel.

### 5. Hitelesítés

A szerver a `127.0.0.1`-en figyel, tehát csak erről a gépről érhető el. A bearer
token marad, mert a `tailscale serve` beállítás nem lett visszavonva, és a
védelem nem függhet attól, hogy épp mi van bekapcsolva.

`GET /` **ugyanaz mögött a token mögött van, mint az `/api/*`.** A záró review
mondta ki, miért nem elég a `127.0.0.1`: a `deploy/README.md` dokumentál egy
`tailscale serve`-et, ami a teljes origint kiajánlja, és a lapon rajta van a
briefing, minden elemzés, a számok és a teljes szál — egyetlen válaszban több,
mint amennyit bármelyik API-végpont kiad.

Egy sima navigációra a böngésző nem tud `Authorization` fejlécet tenni, ezért az
első látogatás `?token=`-nel jön. Azt a szerver egyszer fogadja el, és rögtön
`HttpOnly`, `SameSite=Strict` sütire cseréli; onnantól a süti a bizonyíték.
Hitelesítés nélkül 401. A `Secure` flag szándékosan marad le: a szerver
`127.0.0.1`-en sima http-t is kiszolgál, ott egy Secure süti sosem jönne vissza.

A böngészőoldali script a `?token=`-t továbbra is leszedi a címsorról, és
`sessionStorage`-ba teszi a `POST /api/chat` bearer fejléchez.

**A `POST /api/chat` a sütit is elfogadja**, nem csak a bearer fejlécet. A
`sessionStorage` a böngésző munkamenetével együtt meghal, a süti harminc napig
él — enélkül egy visszatérő látogató 200-as lapot kapott volna a sütitől és 401-et
minden kérdésre, és csak a token újbóli bemásolása segített volna. CSRF-felületet
nem nyit: a süti `SameSite=Strict` (idegen oldal nem tudja rácsatoltatni a
böngészővel) és `HttpOnly` (script nem olvassa ki). A többi `/api/*` útvonal
marad bearer-only — azokat Shortcut vagy script hívja, ami fejlécet küld, sütit
soha.

### 6. Telegram

A `bot.on("message:text")` ág **átkötése**, nem újraírása: ugyanaz a mag, a
`chat_id` a Telegram chat-azonosítója. A parancsok (`/brief`, `/uj`, `/modules`,
`/undo`, `/used`) változatlanok.

## Hibakezelés

Ugyanaz a gerinc, mint a projekt többi részén:

- **Ha a Groq elérhetetlen vagy 429-et ad**, az oldal ugyanúgy megjelenik —
  briefing, elemzések, számok —, csak a válasz hiányzik, és az oldal kiírja,
  miért. A tartalom sosem függ a modelltől.
- **Ha nincs elemzés még** (az `analyses` tábla üres), a kontextus ezt közli, és
  a modellnek meg kell mondania, hogy erről még nem tud nyilatkozni. Nem
  következtet a nyers számokból elemzést.
- **Ha a brief nem áll elő**, a kérdés attól még megválaszolható a történetből.

## Tesztelés

- `conversations` repó: szálak elkülönülnek, a sorrend a legutóbbi felé nő, a
  `prune` a határon helyesen vág.
- A kontextus-összeállítás: az elemzés-összegzések dátummal érkeznek; üres
  `analyses` esetén a kimondott hiány; a token-keret betartása.
- A kérdés-mag a meglévő `fixtureFetcher`-rel, hálózat nélkül: sikeres válasz
  után **két** sor kerül a szálba, elszállt hívás után **egy sem**.
- A markdown-renderelő: az ismert elemek, és hogy az ismeretlen bemenet
  escape-elve jelenik meg. Egy `<script>`-et tartalmazó modell-válasz nem
  futhat le.
- A HTTP-útvonalak a meglévő `buildTestApp` harnesszel.

## Amit az S5 nem csinál

- Nem ír adatot LLM-en keresztül. Ez a régi webes specből marad, és továbbra is
  helyes: a modell olvas és beszél, nem módosít.
- Nem küld proaktív értesítést — az az S6.
- Nincs bejelentkező felület, élő frissítés, offline működés.
- Nem ad az LLM-nek adatbázis-lekérdező eszközt. A kontextus előre összeállított
  marad, ahogy az S3-ban is.

## Takarítás, ami ide tartozik

- A `claudeChat` és a hozzá tartozó `ClaudeChatOptions` törlése a
  `src/core/chat.ts`-ből. A `groqChat` váltotta le; a holt ág fenntartása azt
  sugallja, hogy van visszaút, ami nincs.
