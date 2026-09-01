# iOS Shortcut fájlok olvasása és generálása

Ez a jegyzet azért készült, hogy a Shortcutot ne kézzel kelljen összekattintani a
telefonon minden alkalommal, amikor a napi csatorna bővül. A visszafejtés egyszer
történt meg, egy valódi, működő Shortcut exportjából — ami itt le van írva, az
mind mért, nem feltételezett.

**Titok nem kerül ebbe a fájlba.** Az exportált `.shortcut` a HTTP-fejlécet
nyílt szövegben tárolja, tehát **a `JARVIS_TOKEN` benne van minden exportban**.
Ezért ilyen fájlt nem osztunk meg, és használat után törlünk.

## A fájlformátum

Egy `.shortcut` fájl **AEA1** — Apple Encrypted Archive. A profil `0`
(`hkdf_sha256_hmac__none__ecdsa_p256`): a `none` azt jelenti, hogy **nincs
titkosítva, csak aláírva**. Ezért olvasható, ha megvan az aláíró kulcs — ami
magában a fájlban van.

```
AEA1 fejléc
 └─ auth-adat: bplist { SigningCertificateChain: [leaf, intermediate, root] }
     └─ AA01 (Apple Archive)
         └─ Shortcut.wflow  (bináris plist)
```

### Kicsomagolás

1. A fejléc 8. bájtjától olvasd ki az auth-adat hosszát (`<I`), a 12. bájttól
   annyi bájt egy bplist.
2. Abból a `SigningCertificateChain[0]` a leaf tanúsítvány, DER-ben.
3. `openssl x509 -inform DER -pubkey -noout` → PEM publikus kulcs.
4. `aea decrypt -i <fájl> -o <ki>.aa -sign-pub <kulcs>.pem`
5. `aa extract -i <ki>.aa -d <könyvtár>` → `Shortcut.wflow`
6. `plistlib.load()` vagy `plutil -convert xml1`

### Visszacsomagolás

Ennyi az egész — a `shortcuts` CLI elvégzi a becsomagolást és az aláírást:

```bash
shortcuts sign -m anyone -i Shortcut.wflow -o Jarvis.shortcut
```

A `-m anyone` az, ami importálhatóvá teszi másik eszközön. Bizonyítottan
oda-vissza működik: egy nulláról írt `.wflow` aláírás után visszafejtve
bájtazonosan ugyanazt az akciólistát adta.

## A `.wflow` szerkezete

Felső szintű kulcsok: `WFWorkflowActions` (a lista, ami számít),
`WFWorkflowClientVersion`, `WFWorkflowMinimumClientVersion(String)`,
`WFWorkflowIcon`, `WFWorkflowTypes`, `WFWorkflowInputContentItemClasses`,
`WFWorkflowOutputContentItemClasses`, `WFWorkflowHasOutputFallback`,
`WFWorkflowHasShortcutInputVariables`, `WFWorkflowImportQuestions`,
`WFQuickActionSurfaces`.

Minden akció:

```python
{"WFWorkflowActionIdentifier": "...", "WFWorkflowActionParameters": {...}}
```

Az akciók **UUID-vel hivatkoznak egymás kimenetére**. Ez a kulcsa a
generálásnak: minden akciónak adsz egy UUID-t, és a rá hivatkozó akció ezt teszi
egy `ActionOutput` referenciába.

## Az akciótípusok, mért paraméterezéssel

### Health-minta lekérdezése

`is.workflow.actions.filter.health.quantity`

```python
{
  "UUID": <uuid>,
  "WFContentItemFilter": {
    "WFSerializationType": "WFContentPredicateTableTemplate",
    "Value": {
      "WFActionParameterFilterPrefix": 1,
      "WFContentPredicateBoundedDate": False,
      "WFActionParameterFilterTemplates": [
        {"Property": "Type", "Operator": 4, "Bounded": True, "Removable": False,
         "Values": {"Enumeration": {"Value": "<MEGJELENÍTETT NÉV>",
                                    "WFSerializationType": "WFStringSubstitutableState"}}},
        {"Property": "Start Date", "Operator": 1001, "Bounded": True, "Removable": False,
         "Values": {"Number": "1", "Unit": 16}},   # elmúlt 1 nap
      ],
    },
  },
  "WFContentItemLimitEnabled": True,     # csak ha egyetlen minta kell
  "WFContentItemLimitNumber": 1.0,
  "WFContentItemSortOrder": "Latest First",
  "WFContentItemSortProperty": "Start Date",
  "WFContentItemInputParameter": "Library",   # csak a lánc első ilyen akcióján
}
```

A **típus a Health app megjelenített neve**, nem a `HKQuantityTypeIdentifier`:
`"Sleep"`, `"Heart Rate Variability"`, `"Resting Heart Rate"`. A kimenet neve,
amire hivatkozni lehet: `"Health Samples"`.

### Tulajdonság kinyerése egy mintából

`is.workflow.actions.properties.health.quantity`

```python
{"UUID": <uuid>,
 "WFContentItemPropertyName": "Start Date",   # vagy "End Date"
 "WFInput": {"WFSerializationType": "WFTextTokenAttachment",
             "Value": {"Type": "ActionOutput", "OutputName": "Health Samples",
                       "OutputUUID": <a szűrő UUID-je>}}}
```

### Összegzés / átlag

`is.workflow.actions.statistics`

```python
{"UUID": <uuid>,
 "WFStatisticsOperation": "Sum",   # elhagyva: Average
 "Input": {"WFSerializationType": "WFTextTokenAttachment",
           "Value": {"Type": "ActionOutput", "OutputName": "Health Samples",
                     "OutputUUID": <a szűrő UUID-je>}}}
```

A kimenet neve a művelet neve (`"Sum"`, `"Average"`).

### Két dátum különbsége

`is.workflow.actions.gettimebetweendates` — `WFInput` a vég, `WFTimeUntilFromDate`
a kezdet, mindkettő `WFTextTokenString` egy `￼` helyőrzővel és
`attachmentsByRange: {"{0, 1}": {...ActionOutput...}}`. `WFTimeUntilUnit: "Hours"`.

### HTTP-kérés

`is.workflow.actions.downloadurl`

```python
{"UUID": <uuid>, "WFURL": "https://...", "WFHTTPMethod": "POST", "ShowHeaders": True,
 "WFHTTPHeaders": {"WFSerializationType": "WFDictionaryFieldValue",
   "Value": {"WFDictionaryFieldValueItems": [
     {"WFItemType": 0,
      "WFKey":   {"WFSerializationType": "WFTextTokenString", "Value": {"string": "Authorization"}},
      "WFValue": {"WFSerializationType": "WFTextTokenString", "Value": {"string": "Bearer ..."}}},
   ]}},
 "WFJSONValues": {"WFSerializationType": "WFDictionaryFieldValue",
   "Value": {"WFDictionaryFieldValueItems": [
     {"WFItemType": 3,     # 3 = szám; 0 = szöveg
      "WFKey":   {"WFSerializationType": "WFTextTokenString", "Value": {"string": "hrv"}},
      "WFValue": {"WFSerializationType": "WFTextTokenString",
                  "Value": {"string": "￼",
                            "attachmentsByRange": {"{0, 1}": {"Type": "ActionOutput",
                                                              "OutputName": "Health Samples",
                                                              "OutputUUID": <uuid>}}}}},
   ]}}}
```

### Ciklus a minták fölött

`is.workflow.actions.repeat.each` — ugyanaz a nyit/zár szerkezet, mint az
`If`-nél: `WFControlFlowMode` `0` nyit (`WFInput` a lista), `2` zár, és a kettőt
egy közös `GroupingIdentifier` köti össze. **A ciklus törzse a kettő KÖZÉ kerül.**

A törzsben az aktuális elemre hivatkozó token:

```python
{"WFSerializationType": "WFTextTokenAttachment",
 "Value": {"Type": "Variable", "VariableName": "Repeat Item"}}
```

> Ha a törzs a záró akció UTÁN áll, a szerkesztő csak a `Repeat Results`-t
> kínálja fel — a ciklus kimenetét. Ez fordítja meg csendben az egészet: a
> ciklus üresen fut le, a törzs pedig egyszer, rossz bemenettel.

### Dátum ISO 8601-re

`is.workflow.actions.format.date`

```python
{"UUID": <uuid>, "WFDate": <WFTextTokenString a dátum-akció kimenetére>,
 "WFDateFormatStyle": "ISO 8601", "WFISO8601IncludeTime": True}
```

`WFISO8601IncludeTime` alapból **hamis** — idő nélkül a szerver csak a napot
kapja meg, és az alvás-szakaszokból nem marad semmi. Mindig ki kell írni.

### Gyűjtés listaváltozóba

`is.workflow.actions.appendvariable` — `WFVariableName` a változó neve,
`WFInput` a hozzáfűzendő érték. A változóra később
`{"Type": "Variable", "VariableName": "<név>"}` attachmenttel lehet hivatkozni.

Tömb egy szótár-mezőben: `WFItemType: 2`, az érték pedig
`{"WFSerializationType": "WFArrayParameterState", "Value": [<elemek>]}`.

### Vezérlés

- `is.workflow.actions.conditional` — `WFControlFlowMode` `0` = If, `1` = Else, `2` = End If
- `is.workflow.actions.delay`
- `is.workflow.actions.nothing` — a szerkesztőben elválasztóként jelenik meg
- `is.workflow.actions.notification`

### Tailscale (iOS)

```
io.tailscale.ipn.ios.GetStatusIntent
io.tailscale.ipn.ios.ConnectIntent
io.tailscale.ipn.ios.DisconnectIntent
```

Paraméter csak az `UUID` és egy `AppIntentDescriptor`
(`BundleIdentifier: io.tailscale.ipn.ios`, `TeamIdentifier: W5364U7YZB`).

**A várakozás a `Connect` UTÁN kell, nem előtte.** Az intent akkor tér vissza,
amikor a kérést leadta, nem amikor az alagút és a MagicDNS feláll. Fordított
sorrendben a POST a névfeloldáson bukik el — „A server with the specified
hostname could not be found" —, és a hiba úgy néz ki, mintha a szerver lenne
lekapcsolva. Hat másodperc bőven elég; kézzel előre felcsatlakozva a Shortcut
azért ment, mert a várakozásnak akkor nem volt dolga.

> **A macOS-en exportált fájlban `io.tailscale.ipn.macsys` szerepel.** Az a
> változat iOS-en „nincs telepítve az app" hibát ad. Generáláskor mindig az
> `ios` alakot kell írni.

## A `Sum` minden forrást összead — mérve

2026-09-01-én az esti futás **21 401 lépést** küldött, miközben a Health app
6645-öt mutatott ugyanarra a napra; aktív kalóriából 1684-et a valós 856 helyett,
és 16,4 km-t 6645 lépésre. A `Find Health Samples` a **nyers mintákat** adja
vissza, forrásonként külön — az óra és a telefon ugyanazt a sétát is rögzíti —,
a `Calculate Statistics: Sum` pedig mindet összeadja.

Ez pontosan az a probléma, amit az import már megold: a rollup forrásonként
gyűjt, és a legnagyobb egyetlen forrást választja. A Shortcut ezt magától nem
tudja, forrás-szűrés nélkül pedig a halmozódó típusokat **nem szabad** `Sum`-mal
küldeni.

Az átlagolt típusok (`Average`) érintetlenek: egy duplikált minta az átlagot alig
mozdítja, nem sokszorozza.

## Amit a Shortcut nem tud, és ezért a szerver dolga

**Az alvás összegzését.** Az óra fázisonként külön mintát ír, tehát egy éjszaka
sok mintából áll. A `Calculate Statistics` a minták **értékén** dolgozik, alvásnál
viszont az érték a fázis neve, nem időtartam — összeadni tehát nincs mit. A
`limit 1, Latest First` megoldás pedig az utolsó szakasz hosszát adná az egész
éjszaka helyett: egy hétórás éjszakára 0,3 órát. Nem hiányzó adat, hanem
magabiztosan rossz.

Ezért küldi a telefon a **nyers alvás-mintákat**, és a szerver számol belőlük —
ugyanazzal a logikával, ami az importban már fut, beleértve az átfedő források
feloldását, amit a Shortcut sosem fog tudni.
