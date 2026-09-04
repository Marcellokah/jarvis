# A1 — Az egészség-ügynök

**Állapot:** a tulajdonossal együtt tervezve, 2026-09-04. A mérés lefutott, az
eredményei ebben a specben vannak; a modellválasztás a mérés következménye.

## Miért

A tulajdonos mondata, ami ezt a darabot elindította:

> Összességében nekem nincs szükségem arra, hogy statisztikákat lássak
> összeszedve, hát erre megnyitom az otp meg health app-ot. Nekem hasznos
> ajánlásokra van szükségem, amik mondjuk elkerülik az én figyelmem.
> Jelenleg az app egy aranyos excel táblázat.

Ez jogos, és a gyökere nem hanyagság, hanem egy tudatos tervezési elv, ami
visszaütött. Az eddigi rendszer két szabályra épült:

1. A számokat kód számolja, a modell csak véleményez.
2. Küszöb dönti el, hogy megszólaljon-e, nem a modell.

Mindkettő a bizalomért volt — és együtt pontosan azt csinálják, amit a
tulajdonos excel-táblázatnak nevez. A modell soha nem gondolkodhat; csak
formába önti, amit a küszöbök már eldöntöttek. Egy küszöb pedig csak azt
találja meg, amit előre megfogalmaztunk.

## Mit kell tudnia

Négy fajta megszólalás, mind a tulajdonos által megjelölve:

1. **Előrejelzi a mai napodat** — több forrás összekapcsolása egy mai
   cselekvéssé. „Tegnap 6,5 órát aludtál, a HRV-d alacsony, és ma három
   meeting van 14 óráig. Az elmúlt négy hasonló napból hármon kihagytad az
   esti edzést — ha ma edzeni akarsz, tedd ebédszünetbe."
2. **Észreveszi, ami elromít** — megváltoztatható ok és javaslat, nem
   korreláció-jelentés.
3. **Rákérdez, ha nem érti** — beismeri a határait, és a hiányzó tudást
   kéri, nem kitalálja.
4. **Megcáfolja, amit hiszel** — számon tartja, mit gondolsz, és mer
   ellentmondani.

Az első három ebben a darabban készül el. **A negyedik nem**: ahhoz a
rendszernek tudnia kell, mit hiszel, és az a C darab (tudás rólad) — amit
viszont ez a darab kezd el gyűjteni, mert a `kerdezz` válaszai pontosan ilyen
tudás. A negyedik archetípus tehát nem elejtve van, hanem sorban áll.

## Amit a mérés megállapított

A `scripts/eval-agent.ts` lefuttatta a hurkot három valódi feladaton, három
lokális modellen, a valódi adatbázison. Ami kiderült, az alakítja az egész
tervet.

**A formátumtartás megoldott probléma.** 32 lépés, **0 érvénytelen JSON** a két
qwen modellnél. Az Ollama JSON-séma kényszerítése működik, és egy 8B is
elbírja. Ez volt a legnagyobb kockázat a menüs hurokban, és nem valósult meg.

**A navigáció is jó.** A lépéssorok emberi módon haladtak: lefedettség → heti
ritmus → eltérések → a nap → hasonló napok. A „nézz körül, mielőtt
következtetsz" utasítás tartotta magát.

**A záró ítélet nem megbízható.** Ez a lényegi eredmény. A `qwen3.5:9b` a T3
feladaton — ahol a helyes válasz ismert, mert a HRV 203,6 ms a mérési mód
váltásából ered, nem élettani eseményből — hét lépés után ezt mondta:

> „Ez valószínűleg a 2026-09-01-i TraditionalStrengthTraining (54,7 perc)
> utáni kiváló regenerációt jelzi."

Kitalált okság, magabiztos hangon, öt valódi lépésre hivatkozva. **Több
információtól magabiztosabban tévedett**: az első, szűkebb menüs futásnál még
nem mondott semmit; a bővített menüvel meggyőzően hamisat mondott.

**A hivatkozás-kényszer nem véd.** A `támaszkodik: [1,2,3,4,5]` mezőt tényleg
kitöltötte, a hivatkozott lépéseket tényleg lefuttatta, és az idézett adatok
igazak. Csak az oksági kapcsolat kitalált. **A hivatkozás azt bizonyítja, hogy
megnézte — nem azt, hogy a következtetés belőle fakad.**

**A kisebb modell viselkedett helyesebben.** A `qwen3:8b` kétszer is
visszakérdezett ahelyett, hogy magyarázatot gyártott volna. Ez a helyes válasz
volt, és a gyorsabb modell adta.

**A hardver kilőtte a nagyobb modellt.** A `gemma4:12b` 2000+ tokent generált
egyetlen lépésválasztáshoz, 11,5 tok/s-mal; 11 perc alatt egyetlen érvényes
JSON-t sem adott ki. A gép közben felforrósodott. 16 GB-os M1 Pro-n a 12B
osztály nem játszik.

### A modellválasztás következménye

A mérés tehát azt mondja: a hurok mechanikája áll, az ítélet minősége nem.
Ezért az agy **`claude-opus-5`** az Anthropic API-n, nem lokális modell.

- A megbukott képességet veszi meg, nem többet.
- A workload mérve: nyomozásonként ~$0,23, napi egy nyomozás plusz brief
  mellett **~$8/hó**; prompt cachinggel ~$5 alatt. A hurok append-only, tehát
  a prefix soha nem változik visszamenőleg — ez a cache legjobb esete.
- Az Anthropic API alapértelmezésben nem tanít a bemeneteken, ami ugyanaz a
  kikötés, ami miatt a Groq lett a szintézis szolgáltatója.
- **Nem céges előfizetés.** Saját, mért API-kulcs. A `claude-code`
  szintetizáló ezért lett kivezetve (`f46cfab`).

A `$0/hó` alapelv ezzel megszűnik. Helyére **mért plafon** lép, és ez is
tesztben áll, nem kommentben — lásd az Ellenőrzés szakaszt.

## A menüs hurok

A modell nem ír SQL-t és nem kap szabad eszközhozzáférést. Minden körben
**egyet választ egy zárt kérdés-készletből**, paraméterekkel, JSON-ben. A kód
végrehajtja, és az eredményt visszaadja.

```
cél  ─→  ┌─────────────────────────────────────┐
         │ a modell EGY kérdést választ (JSON) │ ←──┐
         └──────────────┬──────────────────────┘    │
                        ▼                           │
              a kód végrehajtja                     │ max 10 kör
                        ▼                           │
              a megfigyelés visszamegy  ────────────┘
                        │
                        ▼
         kesz(megállapítás)  ·  kerdezz(szöveg)  ·  kifutott
```

Miért ez, és nem szabad eszközhurok: a mérés szerint a lépésválasztás már egy
8B-nek is megy, tehát a szabadság nem hoz többletet ott, ahol a kockázatot
növelné. A zárt készlet cserébe **tesztelhető** — minden eleme önmagában, valódi
adaton —, és a modell választása naplózható, visszanézhető.

## A kérdés-készlet

| Kérdés | Mit ad vissza |
|---|---|
| `elteresek(mutato, ablak_nap)` | mely napok lógnak ki, z-értékkel |
| `nap(datum)` | egy nap teljes képe, minden mérés viszonyítással |
| `napok(tol, ig)` | egy tartomány egyben — nem naponként külön kérdés |
| `hasonlo_napok(datum, mutato, k)` | a k legközelebbi nap ugyanabban a jellemzőben |
| `mi_lett_utana(datum, napok)` | a rákövetkező napok kimenetei |
| `ritmus(mutato, bontas)` | hét napjai vagy hónapok szerinti bontás |
| `naptar(tol, ig)` | események — a külső ok |
| `edzesek(tol, ig)` | típus, hossz, kalória |
| `lefedettseg(mutato)` | hány mérés, mikortól, **és hol vannak szünetek** |
| `kerdezz(szoveg)` | visszakérdez a tulajdonosnak — zárja a nyomozást |
| `kesz(megallapitas, tamaszkodik)` | kimondja a megállapítást — zárja a nyomozást |

A számolást a meglévő [`stats.ts`](../../../src/core/analysis/stats.ts)
primitívjei végzik (`mean`, `stdDev`, `pearson`, `windowed`, `shiftDay`) —
ebben a darabban nem születik új statisztika.

Két elem a mérés közvetlen tanulsága:

**A `napok(tol, ig)` azért van, mert a `qwen3.5:9b` kifutott a lépéskeretből**
úgy, hogy három egymást követő napot három külön `nap()` hívással kérdezett le.
Egy tartomány-lekérdezés ugyanazt egy lépésben adja.

**A `lefedettseg` megnevezi a szüneteket** — a jelenlegi megszakítatlan sorozat
kezdetét és az azt megelőző utolsó mérést. E nélkül egy mérési rendszerváltás
láthatatlan, és a modellnek nincs módja *felfedezni*, hogy nincs adata.

## A három védelem az ítélet ellen

Ez a spec lényege. A mérés megmutatta, hogy a hurok jó és a zárás rossz; a
három védelem mind a zárásra irányul, és mind **kódban** van, nem promptban.

### 1. Kötelező cáfolat-lépés

A `kesz` nem fogadható el, amíg a modell le nem futtatott egy lépést, ami a
**saját hipotézisét próbálja megdönteni**. A `kesz` hívásnak meg kell neveznie,
melyik lépés volt ez (`cafolat: <lépésszám>`), és a kód elutasítja a zárást, ha
nincs ilyen — a modell ilyenkor visszakapja a hurokba, hogy előbb cáfoljon.

A megbukott T3-on ez így nézett volna ki: a hipotézis „az edzés utáni
regeneráció", a cáfolat `hasonlo_napok` a többi erősítő edzés utáni napra — ahol
a HRV ~60 volt. A hipotézis meghal, mielőtt kimondaná.

### 2. Viszonyítással címkézett adat

A `nap()` nem `hrv=203.59`-et ad vissza, hanem
`hrv=203.59 (+9,7σ a 90 napos alapvonaltól, minden idők maximuma)`.

A `qwen3.5:9b` a T1-en ránézett a 203,59-re, és az indoklásában **„HRV normális"**
-t írt. Ha a szám a viszonyítással együtt érkezik, ezt nem tudja megtenni. Ez az
eredeti architektúra ösztöne — „a számokat kód számolja" —, de a helyes szinten:
a kód nem azt dönti el, *mi érdekes*, hanem **felcímkézi, amit a modell lát**.

### 3. Mintaszám-küszöbök a kérdés-készletben

A mérés alatt a `ritmus` kiadott olyan sorokat, hogy `szombat: 4.4 (n=2)` —
két mérésből vont átlagot. Minden kérdés, ami átlagot vagy trendet ad vissza,
hordozza a rendszer meglévő küszöbeit
([`candidates.ts`](../../../src/core/notify/candidates.ts) `MIN_N7`/`MIN_N90`,
`config.analysis.minCorrelationN`), és a küszöb alatti bontást **megnevezi
elégtelenként**, nem adja ki számként.

## Hatókör

**Benne:**

- A hurok, a kérdés-készlet és a három védelem.
- Egyetlen terület: **egészség**. Ott van 2719 nap valódi adat, tehát nem kell
  előbb betöltő felületet építeni.
- Egy belépési pont: `npm run investigate`, parancssorra.
- Az `investigations` tábla: a nyomozás menete, a megállapítás, a cáfolat.

**Kimarad, szándékosan:**

- **Felület.** A Ma oldalra és a Telegramra csak akkor kerül ki, ha a
  parancssorban bizonyított. Egy nyomozás 4–6 lépés és percek — ez háttérmunka,
  nem interaktív válasz.
- **A többi terület** — pénzügy, gaming. Azok előbb valódi adatot igényelnek
  (B darab), nem ügynököt.
- **A meal prep és a kiolvasztás kivezetése** (E darab), a beszélgetésből
  tanulás (C darab), a proaktív megszólalás átalakítása (D darab).

## Fájlszerkezet

```
src/core/agent/
  loop.ts          a hurok: kör, leállás, a cáfolat-kényszer
  questions.ts     a kérdés-készlet: típus, séma, végrehajtás
  annotate.ts      a viszonyítással címkézés (2. védelem)
  prompt.ts        a rendszerprompt és a menü szövege
src/infra/anthropic.ts        az API-kliens, cachinggel
src/infra/db/migrations/009_investigations.sql
src/infra/db/repositories/investigations.ts
scripts/investigate.ts        a belépési pont
```

A `scripts/eval-agent.ts` marad, mint mérőeszköz — a kérdés-készlet valódi
implementációja átveszi a benne kikísérletezett alakot, de tesztekkel.

## Hibatűrés

**Nincs template fallback.** Ez szándékos eltérés a brief filozófiájától, és
ki kell mondani: ha az API nem elérhető, a nyomozás **nem fut le**, és ezt
megmondja. Egy elmaradt megállapítás jobb, mint egy hamis. A briefnél fordítva
igaz — ott egy csúnya mondat jobb, mint egy elmaradt határidő —, mert ott a
tartalom a modulokból jön, itt viszont maga a következtetés a termék.

**A hurok mindig terminál.** Legfeljebb 10 kör, utána `kifutott` állapotban
zárul, és a részeredmény elmentődik. Egy félbeszakadt nyomozás látható marad,
nem tűnik el.

**Az érvénytelen lépés nem öli meg a nyomozást.** Ismeretlen kérdésnév vagy
rossz paraméter esetén a hiba megy vissza megfigyelésként, és a modell
javíthat. A mérésen ez nem fordult elő egyszer sem, de a kód nem építhet erre.

**Költség-plafon.** Nyomozásonként token-plafon, és ha a hurok elérné,
`kifutott`-tal zárul. A `$0` helyére ez lép.

## Ellenőrzés

- **A kérdés-készlet minden eleme** külön teszt, valódi adatbázis-fixture-rel:
  a visszaadott alak, a mintaszám-küszöb, az üres eset.
- **A hurok scriptelt modellel tesztelhető** — a modell válaszait előre
  megadjuk, API nélkül. Ez azért kötelező, mert a `npm test` hálózat nélkül fut
  végig, és ez a darab nem törheti meg.
- **A cáfolat-kényszer saját teszt**: egy `kesz` cáfolat nélkül visszakerül a
  hurokba; egy `kesz` érvényes cáfolattal átmegy.
- **A címkézés saját teszt**: a 203,59-es HRV valóban `+9,7σ`-val és „minden
  idők maximuma" jelöléssel érkezik.
- **A költség-őr átírása.** A `npm run smoke` ma azt állítja, hogy „a lánc
  végig ingyenes", a [`cost-guard.test.ts`](../../../test/core/cost-guard.test.ts)
  pedig azt rögzíti, hogy nincs fizetős szintetizáló. Ezek **tudatosan**
  módosulnak: az új állítás az, hogy a brief továbbra sem mért, az ügynök
  viszont igen — és van rá plafon. A tesztnek ezt kell őriznie, hogy egy
  későbbi szerkesztés ne tudja észrevétlenül a briefet is fizetőssé tenni.
- **Regresszió a T3-ra.** A mérés három feladata beépül: a HRV-rejtélyre adott
  válasz nem állíthat edzés-eredetű okot. Ez az egyetlen teszt, ahol tudjuk a
  helyes választ, és ezért ez a legértékesebb.

## Nyitott kérdések

1. **Mi indítja a nyomozást?** Ebben a darabban kézi (`npm run investigate`).
   Hogy éjszakai ütemezett futás legyen-e, és milyen célt kapjon magától, a D
   darab kérdése.
2. **Elég-e a cáfolat-lépés?** A mérés a lokális modell hibáját mutatta ki; hogy
   az `claude-opus-5` ugyanezt a hibát elköveti-e, csak az implementáció során
   derül ki. A T3 regressziós teszt pont ezért van.
3. **Mekkora a valódi havi költség?** A ~$8 becslés a mért token-alakból jön,
   nem éles futásból. Az első hónap után mérni kell.
