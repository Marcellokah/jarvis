# F6 — A reggeli pillanat

**Állapot:** a tulajdonos távollétében írva, előzetes felhatalmazással
(„szabad kezet adok neked… Csak hozzá tegyél a projekthez, ne vegyél el" és
„egy igazi dopamin bombát akarok látni minden reggel amikor megnyitom,
személyre szabott köszönéssel").

A távollétben hozott döntések a spec végén.

## Miért

Az F1–F5 megépítette a műszert. Ez a darab arról szól, milyen érzés
megnyitni.

Ma a Ma oldal a dátummal kezd, és az első két mondata — amit egy reggeli
megnyitásnál látsz — jellemzően ez:

> Ma még nem készült briefing.
> Ma még nincs adat. A legutóbbi nap: 2026. szeptember 2., szerda.

Ez igaz, és az igazság fontosabb, mint a hangulat. De **az igazság és a
hangulat itt nem áll szemben egymással**: a rendszer 2718 napnyi adatot ismer
rólad, és ebből reggel hétkor pontosan semmit nem mond, amíg a reggeli futás
be nem esik.

## Amit a „dopamin bomba" ebben a projektben jelenthet — és amit nem

Ez a projekt egy dolgot nem tesz: **nem gyárt jó érzést adat nélkül.** Konfetti,
„Szuper napod volt!" és háromjegyű pontszám nincs, mert egyik sem mérés. Az
első hard hiba, amit ez a rendszer megélt, egy magabiztosan rossz szám volt,
és az egész felület azóta arról szól, hogy a mért és a nem mért közti határ
látszódjon.

Az öröm forrása tehát nem a díszítés, hanem az, hogy **a rendszer észrevesz
rólad valami igazat.** Két dolog kell hozzá:

1. **Nevezzen a nevemen, és tudja, hány óra van.**
2. **Mondjon egy dolgot, ami ma tényleg kiemelkedik** — és hallgasson, ha nincs
   ilyen.

A második fele legalább olyan fontos, mint az első. Egy kiemelés, ami minden
nap megszólal, pontosan annyit ér, mint egy jelző, ami mindig ég — az F1 óta
ez a projekt egyik alapszabálya.

## 1. Köszönés

A Ma oldal legelső eleme, az állapotsáv fölött.

- **Napszak szerint**: hajnal (04–07), reggel (07–10), délelőtt (10–12),
  délután (12–18), este (18–22), éjszaka (22–04). A határok a `Clock`-ból
  jövő időből, Europe/Budapest szerint.
- **Néven szólít**, ha van név: „Jó reggelt, Marcell." Ha nincs, ugyanaz név
  nélkül: „Jó reggelt." A név a `config/config.ts`-ben él, mert az a
  kapcsolótábla — és **üres alapértékkel**, hogy a repó ne hordozzon személyes
  adatot. A tulajdonos írja bele.
- **Nem változik naponta véletlenszerűen.** Egy rotáló üdvözlés-készlet
  játéknak indul és zajjá válik; a napszak már elég változatosság, és az
  legalább jelent valamit.

## 2. A nap egy mondata

Egy mondat, ami **ma** igaz, mérésből, viszonyítással.

Sorrendben az első illeszkedő szabály nyer. Ha egyik sem illeszkedik, **a sáv
nincs ott** — nem üres, nem „ma minden rendben", egyszerűen nincs.

| # | Feltétel | A mondat |
|---|---|---|
| 1 | `hrvDeviation.sigma ≥ 1` és `n7 ≥ 3` | „A HRV-d **{sigma} szórással** a saját 90 napos alapvonalad fölött van." |
| 2 | `hrvDeviation.sigma ≤ −1` és `n7 ≥ 3` | „A HRV-d **{sigma} szórással** a saját 90 napos alapvonalad alatt van." |
| 3 | a mai lépés ≥ 1,5× a 28 napos átlag, és a 28 napos átlag legalább 14 napból | „Ma **{lépés} lépés** — a 28 napos átlagod **{arány}-szerese**." |

**Három szabály, nem négy.** A tervezés közben volt egy negyedik is — a mai
edzésperc a 28 napos napi átlaghoz mérve —, de kiderült, hogy a `Metrics`-ben
nincs 28 napos edzésperc-átlag: a `loadRatio` a 28/365 arány, nem az alap. Egy
negyedik szabályhoz vagy új mutatót kellett volna számolni, vagy a meglévőt
másnak nevezni. Három jó szabály többet ér, mint négy, amiből az egyik
kitalált.

Mind a három **viszonyítással** beszél. Egy „10 608 lépés" önmagában szám;
„a 28 napos átlagod 1,7-szerese" az, amitől valaki elmosolyodik — vagy
elgondolkodik.

A 2. szabály szándékosan **ugyanolyan hangon** szól, mint az 1.: a lefelé
tartó HRV információ, nem riasztás. `--riado` itt nem jelenik meg; ez a szín
az elmaradt csatornáé és a naptár-hibáé marad.

A küszöbök (`1` szórás, `1,5×`) és a mintaszám-minimumok (`n7 ≥ 3`,
`14 nap`) **kimondottan konzervatívak**. Egy kiemelés, ami minden nap
megszólal, elveszti az értékét; jobb, ha a legtöbb napon csend van.

## 3. Kontraszt

A szekciócímek (`h2`) ma `--vaz` színnel mennek a sötét alapon, és a
képernyőképeken alig olvashatók — a „TEENDŐK" felirat halványabb, mint a
tartalma. Ez nem az „ami nincs mérve, annak nincs színe" szabály hatálya
alá esik: **a cím nem adat, hanem szerkezet**, és a szerkezetnek látszania
kell. A `h2` a `--vaz` helyett a `--szoveg` halványabb változatát kapja, és a
címkék betűköze marad.

Ez az egyetlen szín-változtatás a darabban, és nem érinti sem a `--jel`, sem
a `--riado` jelentését.

## Hatókör

**Beletartozik:** a köszönés, a nap egy mondata, a `config.owner.name`, és a
szekciócímek kontrasztja.

**Nem tartozik bele:** animáció-bővítés (a mozgás-szótár az F1-ben le van
zárva); pontszám vagy „streak"-számláló; a többi oldal (a köszönés a Ma
oldalé, mert az a reggeli belépő).

## Fájlszerkezet

```
ÚJ
  src/delivery/http/view/greeting.ts     a köszönés és a nap egy mondata

MÓDOSUL
  config/config.ts                       owner.name, üres alapértékkel
  src/delivery/http/routes/page-shell.ts a köszönés adatai a ShellInputs-ba
  src/delivery/http/view/today.ts        a két új sáv legelöl
  src/delivery/http/view/theme.ts        a köszönés stílusa + h2 kontraszt
```

## Hibatűrés

A `greeting.ts` tiszta függvény: dátumot és már kiszámolt `Metrics`-et kap,
sztringet ad vissza. **A Ma oldal ezzel először hív `metrics()`-et** — eddig
csak a Számok és a négy területi oldal tette. Ez egy teljes aggregátum
oldalletöltésenként, ugyanaz a költség, amit azok az oldalak ma is fizetnek;
a saját `try/catch`-e mögött van, tehát ha elszáll, a köszönés megmarad és
csak a mondat marad el. Ha a `Metrics` nem érhető el (a lekérdezése ma is saját
`try/catch` mögött van), a köszönés attól még megjelenik — csak a nap egy
mondata marad el. **A köszönés soha nem múlik adaton**, mert a napszak és a
név mindig megvan.

## Ellenőrzés

- a hat napszak-határ mindegyike a helyes köszönést adja, és a határokon
  (04:00, 07:00, 10:00, 12:00, 18:00, 22:00) is — a teszt mind a hat átmenetet
  a percére állítja;
- név nélkül a köszönés vessző és név nélkül áll, nem „Jó reggelt, ."-tal;
- a név escape-elve jelenik meg (konfigból jön, de akkor is);
- **a három kiemelés-szabály mindegyike a saját feltételére szólal meg**, és a
  sorrend számít: HRV-eltérés esetén a lépés-szabály nem szólal meg;
- **egyik szabály sem szólal meg a mintaszám-küszöb alatt** — a teszt olyan
  fixtúrát ad, ami az értékben átmenne, de a mintaszámban nem;
- ha egyik szabály sem illeszkedik, **a mondat sávja nincs ott** — se üresen,
  se „ma minden rendben"-nel;
- a lefelé tartó HRV mondata `--riado` nélkül jelenik meg;
- a `Metrics` hiányában a köszönés megvan és a mondat elmarad;
- a `h2` kontrasztja megváltozott, és a `--riado` egyetlen új szabályban sem
  szerepel;
- **minden új teszt bukjon el a javítatlan implementáció ellen.** Az F3–S8
  alatt huszonkét feladatból huszonegy igényelt plusz javítási kört, és
  **nyolc esetben maga a TERV tesztje volt tautologikus vagy
  kielégíthetetlen.** Ha egy előírt teszt nem tud elbukni, javítsd és írd meg.

## A távollétben hozott döntések

1. **A név a `config/config.ts`-ben él, üres alapértékkel.** A repó privát, de
   a személyes adat akkor sem tartozik a kódba; a tulajdonos írja bele.
   Enélkül a köszönés név nélkül működik.
2. **Három kiemelés-szabály, konzervatív küszöbökkel**, és csend, ha egyik sem
   illeszkedik. A másik irány — mindennap mondani valamit — pontosan az a
   „mindig ég" jelző, amit ez a projekt sehol nem enged meg.
3. **A lefelé tartó HRV nem riasztás.** Ugyanaz a hang, ugyanaz a szín; a
   `--riado` marad az elmaradt csatornáé és a naptár-hibáé.
4. **Nincs pontszám és nincs streak-számláló.** Egyik sem mérés, és mindkettő
   arra csábít, hogy a szám kedvéért cselekedj.
5. **A köszönés csak a Ma oldalon van.** Az a reggeli belépő; a másik hét
   lapon egy ismételt üdvözlés zajjá válna.
6. **A `h2` kontrasztja nő.** A cím szerkezet, nem adat — a „ami nincs mérve,
   annak nincs színe" szabály rá nem vonatkozik.
