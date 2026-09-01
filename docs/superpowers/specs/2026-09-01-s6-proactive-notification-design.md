# S6 — Proaktív értesítés

**Dátum:** 2026-09-01
**Állapot:** elfogadott, implementálásra vár
**Előzmény:** S1+S4 (Groq-szintézis), S2 (adatalap), S3 (aggregáció), S5 (kérdés-felület) — mind a `main`-en

## Cél

Legyen olyan, amiről Jarvis **magától szól**, Telegramon: időzaklató teendő,
egészségi eltérés, új elemzési megállapítás. Kérdezni eddig is lehetett; ez az
első rész, ahol a rendszer kezdeményez.

## Kiindulás

Az ág a `main`-ről indul. Kiinduló állapot: 385 teszt / 40 fájl, typecheck
tiszta.

## Amit már tud, és amit nem

**Már megvan:**

- **A küldés célja.** A `TELEGRAM_ALLOWED_CHAT_ID` beállított titok, a bot fut.
- **Az ismétlés-szűrés.** A `SeenStore` (`filterNew` / `record` / `prune`)
  pontosan erre készült, és a 04:00-s takarítás már nyesi.
- **Az ütemező.** A `runNightlyCleanup` kiszervezésével az S5-ben tesztelhetővé
  vált; a cron mintája adott.
- **A küszöbökhöz szükséges számok.** Az S3 `aggregate()`-je adja a HRV
  eltérését a saját alapvonalától, mintaszám-kapukkal együtt.

**Ami hiányzik:**

- A bot csak **válaszol**; kifelé nem kezdeményez.
- Semmi nem dönti el, hogy valami elég fontos-e a megszólaláshoz.

## Amit mérni kellett

Két dolog, ami a tervet alakította:

**Az ütemezett munka a gyakorlatban lefut.** A 04:00-s takarítás mindkét
vizsgált éjjel elsült (2026-08-31 04:38 és 2026-09-01 04:00). A reggeli
automatizálás nem azért bukott meg, mert a cron nem sül el, hanem mert a
**lezárt, akkumulátoros gép** felébresztése 11 másodperces DarkWake-et adott.
Amíg a gép ébren van, az ütemező működik.

**Ébredés-detektálás nem kell.** Ha az ütemező néhány percenként ellenőriz,
alvás közben egyszerűen nem fut — és az ébredés utáni első tick maga az
ébredés-esemény. Ez egy teljes modult spórol meg.

## Felépítés

### 1. A tick és a két kapu

Új cron az ütemezőben, **15 percenként**. Két kaput kell átjutnia:

1. **Eltelt-e négy óra** az utolsó proaktív üzenet óta.
2. **Csendes órán kívül vagyunk-e** — 22:00 és 07:00 között nem szólal meg. A
   négyórás korlát ezt nem fedné le: egy éjjel egyig fennmaradt gép különben
   kapna egy értesítést hajnali egykor.

Ha bármelyik kapu zár, **nem történik semmi** — se lekérdezés, se hívás.

### 2. A jelöltek — a döntés kódban

`src/core/notify/candidates.ts`, tiszta függvény. Bemenetből jelöltek listája:

```ts
interface Candidate {
  /** Stable identity for deduplication — never contains a timestamp. */
  key: string;
  kind: "deadline" | "health" | "analysis";
  urgency: "now" | "soon";
  /** Hungarian, one line, already carrying its own evidence. */
  text: string;
}
```

Három forrás:

- **Időzaklató teendő** — a `HealthAndMealPrep` kiolvasztási határidői és a
  `FinanceAndSubs` megújuló előfizetései. Jelölt lesz belőle, ha a határidő a
  következő négy órán belül jár le, vagy már lejárt.
- **Egészségi eltérés** — az `aggregate()` kimenetéből, küszöbökkel. A HRV
  eltérése a saját 90 napos alapvonalától akkor jelölt, ha eléri a másfél
  szórást **és** átmegy az S3 mintaszám-kapuin (`n7 >= 3`, `n90 >= 20`). A
  nyugalmi pulzus trendje akkor, ha 30 napra vetítve legalább 2 bpm-mel romlik,
  365 napos ablakon.
- **Új elemzési megállapítás** — az `analyses` táblában az utolsó értesítés óta
  született sor összegzése.

**Ami nem éri el a küszöböt, az nem gyenge jelölt, hanem nem jelölt.** Ez
ugyanaz a szabály, amit az S3 az összefüggéseknél már betart, és ugyanazért:
egy magabiztos értesítés egy alig létező jelről rosszabb, mint a csend.

**Minden jelölt szövege magával hozza a bizonyítékát** — hány napból, mekkora
lefedettséggel. Egy értesítés, ami nem mondja meg, min alapul, nem
ellenőrizhető.

### 3. A drága és az olcsó réteg

A jelölt-keresés **kétszintű**, és ez nem optimalizálás, hanem helyesség:

- **Olcsó, minden ticken:** az egészségi eltérés és az új elemzés — mindkettő
  adatbázis-olvasás.
- **Drága, csak ha a kapuk már átengedtek:** a modulfuttatás, ami a
  határidőkhöz kell. Így a modulok legfeljebb négyóránként futnak, nem
  negyedóránként.

**A modulokat egyenként kell futtatni** (`BriefService.runOne`), és **soha nem
a briefen keresztül**. A `get` és a `generate` szintézist indít, ami egy
Groq-hívás — az S5-ben pontosan ez a csapda ejtett meg minket egyszer már. Az
értesítésnek a modulok nyers kimenete kell, nem megírt szöveg.

### 4. Ismétlés-szűrés

A `SeenStore` a `"notify"` modulnév alatt. A jelöltek kulcsai mennek bele,
`filterNew` szűr, és a **sikeres kiküldés után** jön a `record` — egy el nem
küldött üzenet nem számít elmondottnak.

A kulcs sosem tartalmaz időbélyeget, különben minden tick új kulcsot gyártana és
a szűrés semmit nem érne. A meglévő 04:00-s `prune` gondoskodik róla, hogy egy
hónap múlva egy még mindig fennálló dolog újra felszínre kerülhessen.

### 5. A szöveg

A modell **csak a már eldöntött jelölteket fogalmazza meg**, röviden, magyarul.
Nem dönthet arról, hogy valami elég fontos-e — azt a küszöbök döntötték el
felette.

Ha a Groq nem érhető el vagy hibázik, egy template küldi ki ugyanazokat a
jelölteket tömör felsorolásként. **Az értesítés nem maradhat el amiatt, hogy a
megfogalmazás nem sikerült** — egy csúnya mondat jobb, mint egy elmulasztott
kiolvasztási határidő. Ugyanaz a gerinc, mint a briefnél.

Token-keret: a jelöltek rövidek, a prompt néhány száz token, a válasz legfeljebb
300. Egy értesítés négyóránként nem közelíti a 6 000/perc plafont.

### 6. A kiküldés

A `bot.api.sendMessage(allowedChatId, ...)`. A bot ma csak válaszol; ehhez a
`buildBot` egy kifelé küldő függvényt is ad vissza, amit a `main.ts` átad az
ütemezőnek. Ha nincs Telegram-token, az egész tick kimarad, naplózva — a
rendszer többi része ettől változatlanul működik.

### 7. A napló, ami a kaput is tartja

Nincs a projektben kulcs-érték tár, és a `module_cache` nem alkalmas rá: annak
lejárati szemantikája van, és a 04:00-s takarítás törli a lejárt sorait — a
négyórás kapu csendben kinyílna tőle.

Ezért új migráció, `007_notifications.sql`:

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at  TEXT NOT NULL,
  kinds    TEXT NOT NULL,   -- a kiküldött jelöltek fajtái, vesszővel
  keys     TEXT NOT NULL,   -- a jelöltek kulcsai, ahogy a SeenStore-ba mentek
  text     TEXT NOT NULL    -- amit ténylegesen kiküldtünk
);
CREATE INDEX IF NOT EXISTS notifications_time ON notifications (sent_at DESC);
```

Ez a tábla három dolgot old meg egyszerre: a négyórás kaput (`MAX(sent_at)`), az
„utolsó értesítés óta született elemzés" kérdését, és azt, hogy utólag
megnézhető legyen, mit küldött ki a rendszer és mikor. A sor **a sikeres
kiküldés után** keletkezik, ugyanabban a lépésben, mint a `SeenStore.record`.

Ha ez a két írás elválna egymástól, két rossz állapot nyílna meg: egy elküldött
üzenet, ami újra ki fog menni, vagy egy el nem küldött, ami már elmondottnak
számít. Egy tranzakcióban mennek.

## Hibakezelés

- **Egy jelölt-forrás bukása nem viszi a többit.** Ha a modulfuttatás elszáll, a
  meglévő egészségi és elemzési jelöltek kimennek, és a hiba naplóba kerül.
- **Ha a kiküldés nem sikerül**, a `record` nem fut le, tehát a következő
  alkalommal újra próbálja. Ez szándékos: az elmaradt üzenetet meg kell
  ismételni, a feleslegeset nem.
- **Ha nincs jelölt, nincs üzenet.** A rendszer nem jelentkezik be azzal, hogy
  nincs mit mondania.

## Tesztelés

- A két kapu: a négyórás korlát és a csendes órák mindkét oldala, fix órával.
- `candidates()` tiszta, tehát a súlypont itt van: a küszöb alatti bemenet nem
  ad jelöltet, a fölötte lévő ad, és a jelölt szövege tartalmazza a mintaszámot.
- **Kötelező eset:** a kulcs nem tartalmaz időbélyeget — ugyanaz a helyzet
  kétszer ugyanazt a kulcsot adja. Enélkül a szűrés csendben hatástalan lenne.
- **Kötelező eset:** a jelölt-keresés nem hív szintézist. Egy számláló
  `BriefService`-szel bizonyítva, ne feltételezve.
- A kiküldés a meglévő `fixtureFetcher` mintájára, hálózat nélkül; sikertelen
  küldés után **sem** a `SeenStore`, **sem** a `notifications` tábla nem
  változik, és a két írás egy tranzakcióban történik.

## Amit az S6 nem csinál

- Nem nyúl a napi briefhez, a modulokhoz és a kérdés-felülethez.
- Nem vezet be új értesítési csatornát.
- **Nem ír adatot**, se a kód, se a modell.
- Nem ébreszti a gépet. Ha alszik, az értesítés az ébredés utáni első tickre
  csúszik — ez a döntés, nem hiányosság.
