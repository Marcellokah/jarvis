# S1 + S4 — Leépítés és Groq

**Dátum:** 2026-08-31
**Állapot:** jóváhagyott terv, implementáció előtt
**Előzmény:** a projekt gyökeres átalakítása. Ez az első a hat alrendszerből.

## A fordulat

A rendszer eddig egy őrizetlen reggeli értesítés köré épült: a Mac 07:15-kor
ébredt, 07:20-kor briefet gyártott, a telefon 07:30-kor lekérte. Ez élesben
megbukott — egy lecsukott MacBook akkumulátorról 11 másodperces DarkWake-et ad,
aztán visszaalszik.

Az új felállás:

- **A Mac a fő kezelőfelület**, és **kézzel indítod** — munkába érve vagy este.
- **A telefon adatforrás marad** (az Apple Health adatoknak nincs más forrása).
- **A hangsúly az elemzésre kerül**, nem a szabály-alapú napi verdiktre.

Ez a spec ebből a legelső két lépést fedi: a fölöslegessé vált gépezet
kivezetését, és a háttér-LLM lecserélését.

## Hat alrendszer, ez az első

| | Alrendszer | LLM? |
|---|---|---|
| **S1** | **Leépítés** — automatizáció, ébresztés, pre-warm, kapcsolat-riasztás | nem |
| **S4** | **Groq bekötése** a szintetizáló és a chat mögé | igen |
| S2 | Adatalap — teljes health metrika-kör, történeti előfizetés-napló, fizikai mutatók | nem |
| S3 | Aggregáció — gördülő átlagok, eltérések, hó/hó különbségek | nem |
| S5 | Kérdés-felület — az elemző motor | igen |
| S6 | Proaktív értesítés | részben |

Az S1 és az S4 egy specben van, mert együtt adnak működő rendszert: a leépítés
után a Groq az, ami a briefet írja.

---

## S1 — Leépítés

### Ami eltűnik

| Elem | Miért |
|---|---|
| `pmset repeat wakeorpoweron` | Nincs mire ébredni. Kézzel visszavonandó: `sudo pmset repeat cancel` |
| A 07:20-as pre-warm cron | Kézzel indítod; a 15–25 másodperces generálás egy manuális eszköznél elfogadható |
| A 08:00-s kapcsolat-ellenőrzés, a riasztás és a `contacts` repo | Egy őrizetlen reggel őre volt. Most te indítod — ha nem jön válasz, azonnal látod |

A `client_contact` **tábla marad**, csak a kód kerül ki belőle. Egy `DROP TABLE`
migráció nagyobb kockázat, mint egy üres tábla, és semmit nem nyerünk vele.

A **kérés-log marad.** Az automatizációtól függetlenül hasznos: megmutatja, mi
és mikor hívta az API-t.

Pontosan: a szerver `onResponse` hookja **továbbra is logol minden kérést**, de
a `contacts.record(...)` hívás kikerül belőle. A hook két dolgot csinált; az
egyik marad, a másik megy.

### Ami marad, és miért

- **A LaunchAgent, `RunAtLoad`-dal.** Amíg a Mac be van kapcsolva, fut a bot és a
  HTTP API. Nem ébreszt gépet és nem gyárt magától briefet — csak elérhető.
  Ez az, ami a Telegram proaktív csatornát egyáltalán lehetővé teszi.
- **Az éjszakai takarítás** (lejárt `module_cache`, régi `seen_items`). A folyamat
  saját higiéniája, nem automatizáció.
- **Tailscale és az ingest végpont.** A telefon továbbra is küldi az egészség-adatot.
- **A Shortcut, leszűkítve:** csak adatot küld. Nincs brief-lekérés, nincs iOS
  értesítés.
- **A Telegram bot** változatlanul.
- **A napi brief változatlanul.** Tartalma és szerkezete marad; csak a
  szintetizáló cserélődik. A diagnosztika javítása az S3 trend-kontextusán
  keresztül jön, nem a brief lebontásával — nem rombolunk le olyat, aminek a
  pótlása még nincs kész.

---

## S4 — Groq

### Miért Groq

A háttér-LLM ma a **céges Claude fiók** tokenjén fut. Ez független attól, hogy
mennyibe kerül (a `claude -p` az előfizetéses ülőhelyre megy, nincs mért hívás):
egy magánprojekt nem a munkáltató erőforrásán kellene hogy fusson, és a token
egy magángépen ül.

A Groq az egyetlen ingyenes tier, ami átmegy az adatkezelési szűrőn. A
szolgáltatási szerződése szó szerint:

> „Groq is **not permitted** to use Inputs or Outputs for training or
> fine-tuning any AI Model Services or other models, unless explicitly granted
> permission or instructed by Customer."

Nem opt-out: alapból tiltott. Az adatot nem tárolja a szolgáltatás nyújtásán
túl, a Customer Data „Confidential Information", megszűnéskor 30 napon belül
törli. *(A Gemini ingyenes tierje EU-n kívül tanít a promptokon, a Mistral
Experiment tierje alapból opt-in — mindkettő kizárva.)*

### Bekötés

```
lánc:  groq → template          (ma: claude-code → template)
```

- **Nincs új futásidejű függőség.** A Groq OpenAI-kompatibilis REST-et ad; a
  meglévő `createFetcher` hívja. Nem kell SDK.
- `GROQ_API_KEY` a login Kulcskarikába, a többi titok mellé, `set-secret.sh`-val.
- A `claude-code` szintetizáló **kódja marad**, csak nem az alapértelmezett
  láncban. A `SYNTHESIS_CHAIN` env-vel bármikor előhívható összehasonlításra.
- Az `api` (fizetős Anthropic) továbbra is tiltva marad.
- A chat ugyanezen a szolgáltatón megy: egy Groq kliens, két fogyasztó
  (`Synthesizer` és `ChatService`).

### A modellt mérés dönti el, nem tipp

Három jelölt fér az ingyenes tierbe: **Llama 3.3 70B**, **Kimi K2**,
**GPT-OSS 120B**. Hogy melyik ír jobban magyarul és tartja a `jarvis.md`
kimeneti szerződését, arról nem tippelünk: ugyanazon a valódi briefen mind a
három lefut, és a mai `claude-code` kimenet kerül mellé referenciának.

Értékelési szempontok, ebben a sorrendben:

1. **Formátum-hűség** — pontosan egy `#` cím, a `## ` szekciócímek szó szerint a
   modul `title` mezői, a teendők `- [ ] ` prefixszel. Ezen bukik el a legtöbb
   kisebb modell, és ez az, amit a renderer feltételez.
2. **Ténypontosság** — nem talál ki számot, nem hagy el javasolt időpontot.
   *(A `claude-code` egy mérésben elhagyta a naptár-javaslat idősávját — ez a
   referencia sem hibátlan.)*
3. **Magyar minőség** — a persona szerinti tömör, sallangmentes hangnem.
4. **Késleltetés.**

### Hibakezelés

A lánc védi a briefet, ahogy eddig. A Groq-ág lefokozódik **template**-re, ha:

- a szolgáltató nem elérhető vagy hibát ad,
- rate limitel (429),
- a kimenet nem a szerződés szerinti (nem `#` karakterrel kezdődik).

A harmadikat a meglévő kimenet-ellenőrzés már kikényszeríti. A `template`
renderelő soha nem bukik el, tehát a brief mindig elkészül.

### Költség-őr

A `npm run smoke` ma összemos két állítást: „nincs fizetős szintetizáló" és
„nincs API kulcs egyáltalán". A Groq kulcs jelenléte az utóbbit elbuktatná,
pedig a brief továbbra is ingyenes. A két állítás szétválik:

- **`cost: brief never metered`** — a szintézis lánca nem tartalmaz fizetős
  elemet. Ez marad kőbe vésve.
- **`cost: llm provider`** — melyik szolgáltató szolgálja ki, és milyen
  konstrukcióban. Jelentés, nem tiltás.

---

## Rendszerszintű alapelv, ami itt születik

**A számokat kód számolja, a modell értelmez.**

Az ingyenes tier 6 000 token/perc. Egy LLM-hívás állapotmentes: a teljes
promptnak egyetlen kérésben kell megérkeznie, tehát egy 20 000 tokenes prompt
nem darabolható fel „és várunk öt percet" alapon — nem időzítési kérdés, hanem
méret.

De a limit csak felhívja a figyelmet arra, ami amúgy is igaz:

| | Tokenek |
|---|---|
| 365 nap nyers `health_snapshots` | ~7 300 |
| Ugyanez előre kiszámolva (7/30/90 napos átlagok, eltérések, 6 mutatóra) | ~200 |

Harmincötszörös különbség — és a rövidebb a **pontosabb**, mert egy modell 365
sorból nem számol megbízhatóan átlagot, egy `AVG()` viszont igen.

Ebből a szabály, ami az S3-at és az S5-öt is vezetni fogja:

| Adat fajtája | Hogyan jut a modellhez |
|---|---|
| **Számok** — alvás, HRV, pulzus, költés, testsúly | SQL aggregáció; a modell kész tényeket kap |
| **Szöveg** — jegyzetek, korábbi beszélgetések, régi briefek | Több menetes összefoglalás (map-reduce), a menetek közti várakozás fér bele a limitbe |

### Ha a limit később szűk lesz

Két kijárat, dokumentálva, hogy ne kelljen újra levezetni:

- **Groq Developer tier** — bankkártya a fiókban, a limitek nagyjából
  tízszeresükre nőnek, és csak az ingyenes küszöb fölött fizetsz. A kártya
  megadása a döntés, nem a költés.
- **Fizetős modell egyetlen hívásra** — egy havi mélyelemzés Sonnet 5-tel,
  ~20 000 token bemenettel, néhány cent, 1 millió tokenes kontextussal.

Egyelőre az ingyenes tier marad. Ha nem válik be, ezek egyikére állunk át.

---

## Tesztelés

Hálózat nélkül, a meglévő mintát követve. A `createFetcher` mögé fixture-válaszok
kerülnek, és a **lánc viselkedését** ellenőrizzük, nem a Groq-ot:

- Sikeres válasz → a `groq` szintetizáló adja a briefet, nincs lefokozás
- 429 → lefokozás `template`-re, a demotion oka a logban
- Hálózati hiba → lefokozás `template`-re
- Szerződésen kívüli kimenet (nem `#`-kel kezd) → lefokozás `template`-re
- Hiányzó `GROQ_API_KEY` → a `available()` hamis, a lánc a `template`-re megy,
  és a `smoke` beszédesen jelenti
- A pre-warm és a kapcsolat-ellenőrzés eltűnése: a `startScheduler` már csak a
  takarítást ütemezi, és ezt teszt rögzíti

## Amit ez a spec nem fed

- **Az egészség-metrikák bővítése** (S2). Ma hat mező érkezik; a cél „szinte az
  összes érdemi health data". Ez adatmodell-munka, külön spec.
- **A történeti adatmodell** (S2). A `subscriptions` ma csak a jelen állapotot
  ismeri, tehát hó/hó különbség nem számolható. Fizikai mutatókra nincs tábla.
- **Az aggregációs réteg** (S3). A `baseline()` metódus létezik, és soha senki
  nem hívta meg.
- **A kérdés-felület** (S5). A 2026-08-31-i weboldal-spec és -terv részben
  érvényét veszti: az iOS értesítéses, tailnetes, süti-hitelesítéses rész
  tárgytalan. A weboldal maga megmarad, de `localhost`-on, és az S5 keretében
  kap új specet — ott lesz a kérdés-felület otthona.
- **A proaktív értesítés tartalma és ritmusa** (S6).
