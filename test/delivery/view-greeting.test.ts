import { describe, it, expect } from "vitest";
import { greeting, highlight, greetingBand } from "../../src/delivery/http/view/greeting.ts";
import { STYLE } from "../../src/delivery/http/view/theme.ts";
import type { Metric } from "../../src/core/analysis/stats.ts";

const NINCS: Metric = { value: null, n: 0, coverage: 0, window: "28d" };
const csend = { hrvDeviation: null, todaySteps: null, steps28: NINCS };

describe("köszönés", () => {
  it("napszak szerint köszön, a határokat is beleértve", () => {
    // A határok azért vannak tesztelve percre, mert egy elcsúszott
    // egyenlőtlenség napi egy órán át rossz köszönést adna, és senki nem
    // venné észre.
    //
    // Négy sáv, nem hat: a korábbi "Szép napot" (10–12) és "Jó éjt" (22–04)
    // magyarul BÚCSÚ, nem köszönés — "szép napot [még hátra]" és "aludj jól"
    // azt mondja a beszélő MENET közben, nem érkezéskor. "Szia" tölti ki az
    // éjszakai rést, mert a magyarban nincs éjszakai KÖSZÖNÉS-forma (ld.
    // greeting.ts doc komment).
    const at = (hour: number) => greeting({ hour, name: "" });
    expect(at(4)).toContain("Jó reggelt");  // reggel 04-től
    expect(at(3)).toContain("Szia");        // 04 előtt még éjszaka
    expect(at(9)).toContain("Jó reggelt");  // 10 előtt még reggel
    expect(at(10)).toContain("Jó napot");   // nap 10-től
    expect(at(17)).toContain("Jó napot");   // 18 előtt még nap
    expect(at(18)).toContain("Jó estét");   // este 18-tól
    expect(at(21)).toContain("Jó estét");   // 22 előtt még este
    expect(at(22)).toContain("Szia");       // éjszaka 22-től
    expect(at(23)).toContain("Szia");
    expect(at(0)).toContain("Szia");
  });

  it("néven szólít, ha van név", () => {
    expect(greeting({ hour: 8, name: "Marcell" })).toContain("Marcell");
  });

  it("név nélkül nem hagy ott egy lógó vesszőt", () => {
    const g = greeting({ hour: 8, name: "" });
    expect(g).not.toContain(",");
    expect(g).toContain("Jó reggelt");
  });

  it("escape-eli a nevet", () => {
    // A konfigból jön, de a konfigot is ember írja.
    const g = greeting({ hour: 8, name: "<b>x</b>" });
    expect(g).not.toContain("<b>x</b>");
    expect(g).toContain("&lt;b&gt;");
  });
});

describe("a nap egy mondata", () => {
  it("a magas HRV-t a saját alapvonalához méri", () => {
    const s = highlight({ ...csend, hrvDeviation: { sigma: 1.42, n7: 6, n90: 84 } });
    expect(s).toContain("1,42");
    expect(s).toContain("fölött");
  });

  it("az alacsony HRV-t ugyanazon a hangon mondja", () => {
    // A lefelé tartó HRV információ, nem riasztás. A hangot a szín adja, nem
    // a szöveg — a `not.toContain("riado")` itt a sima magyar prózán soha
    // nem bukhatott volna el (ld. chart-sparkline.test.ts "nem használ
    // riasztó színt" post-mortemje ugyanerre a mintára); a valódi őr a
    // ".koszones" CSS-szabályokon fut lentebb, "a sáv stílusa létezik…".
    const s = highlight({ ...csend, hrvDeviation: { sigma: -1.3, n7: 6, n90: 84 } });
    expect(s).toContain("1,3");
    expect(s).toContain("alatt");
  });

  it("a küszöb alatti HRV-eltérésről hallgat", () => {
    expect(highlight({ ...csend, hrvDeviation: { sigma: 0.9, n7: 6, n90: 84 } })).toBeNull();
    expect(highlight({ ...csend, hrvDeviation: { sigma: -0.9, n7: 6, n90: 84 } })).toBeNull();
  });

  it("a küszöböt éppen elérő HRV-eltérésről már beszél", () => {
    // A >= határ pontos értéke: sigma == SIGMA (1) még kiváltja a mondatot.
    expect(highlight({ ...csend, hrvDeviation: { sigma: 1, n7: 6, n90: 84 } })).not.toBeNull();
  });

  it("kevés mérésből nem beszél HRV-ről", () => {
    // Két éjszakából számolt szórás nem állítás.
    expect(highlight({ ...csend, hrvDeviation: { sigma: 2.5, n7: 2, n90: 84 } })).toBeNull();
  });

  it("pontosan három éjszakából már beszél HRV-ről", () => {
    // A >= határ pontos értéke: n7 == MIN_HRV_NIGHTS (3) még elég a friss
    // ablakhoz. Ez a fixtúra egyszerre pinneli le a >= relációt (egy
    // elcsúszott > mutáns itt null-t adna) és magát a 3-as küszöböt (egy
    // MIN_HRV_NIGHTS = 6 mutáns szintén null-t adna).
    expect(highlight({ ...csend, hrvDeviation: { sigma: 1.5, n7: 3, n90: 84 } })).not.toBeNull();
  });

  it("vékony 90 napos alapból sem beszél HRV-ről, még elég friss éjszaka mellett is", () => {
    // n90 addig soha nem volt olvasva: a mondat "a saját 90 napos
    // alapvonalad"-at állít n7 erejéig, holott az alapvonal maga is vékony
    // lehet. A candidates.ts (core/notify) ugyanezt a védelmet duplázza a
    // saját MIN_N90-jével — ugyanaz az elv itt, MIN_HRV_N90 néven.
    expect(highlight({ ...csend, hrvDeviation: { sigma: 1.5, n7: 6, n90: 15 } })).toBeNull();
  });

  it("a kiugró lépésszámot a 28 napos átlaghoz méri", () => {
    const s = highlight({
      ...csend, todaySteps: 18000,
      steps28: { value: 10000, n: 28, coverage: 1, window: "28d" },
    });
    expect(s).toContain("18 000");
    expect(s).toContain("1,8");
  });

  it("a küszöb alatti lépésszámról hallgat", () => {
    expect(highlight({
      ...csend, todaySteps: 12000,
      steps28: { value: 10000, n: 28, coverage: 1, window: "28d" },
    })).toBeNull();
  });

  it("vékony 28 napos alapból nem beszél lépésről", () => {
    // Tizennégy napnál kevesebb mérésből az „átlagod" szó hazug.
    expect(highlight({
      ...csend, todaySteps: 30000,
      steps28: { value: 10000, n: 10, coverage: .35, window: "28d" },
    })).toBeNull();
  });

  it("pontosan tizennégy napos alapból már beszél lépésről", () => {
    // A >= határ pontos értéke: n == MIN_STEP_DAYS (14) még elég alap.
    expect(highlight({
      ...csend, todaySteps: 18000,
      steps28: { value: 10000, n: 14, coverage: .5, window: "28d" },
    })).not.toBeNull();
  });

  it("tizenhárom napos alapból még nem beszél lépésről", () => {
    // A "pontosan 14 nap" (fent) és a "10 nap" (lejjebb) fixtúra egyike sem
    // különbözteti meg a valódi MIN_STEP_DAYS = 14 küszöböt egy 14 → 11
    // mutánstól: 10 mindkettő alatt null-t ad, 14 mindkettő alatt nem-null-t.
    // 13 nap a kettő közötti rés — a valódi kódban még null, egy 11-es
    // mutánsban már nem az.
    expect(highlight({
      ...csend, todaySteps: 18000,
      steps28: { value: 10000, n: 13, coverage: .46, window: "28d" },
    })).toBeNull();
  });

  it("pontosan az 1,5-szörös aránynál már beszél lépésről", () => {
    // A >= határ pontos értéke: arány == STEP_RATIO (1,5) még kiváltja a
    // mondatot — egy elcsúszott > mutáns, és egy STEP_RATIO = 1,79 mutáns
    // is null-t adna itt.
    const s = highlight({
      ...csend, todaySteps: 15000,
      steps28: { value: 10000, n: 28, coverage: 1, window: "28d" },
    });
    expect(s).not.toBeNull();
    expect(s).toContain("1,5-szerese");
  });

  it("kerek arány esetén nem ír fölösleges tizedesjegyet", () => {
    // hu(arány, 1) mindig tizedesjegyet adott, tehát egy pontosan kétszeres
    // nap "2,0-szerese"-ként jelent meg — kerekítettnek tűnt, holott pontos
    // volt.
    const s = highlight({
      ...csend, todaySteps: 20000,
      steps28: { value: 10000, n: 28, coverage: 1, window: "28d" },
    });
    expect(s).toContain("2-szerese");
    expect(s).not.toContain("2,0-szerese");
  });

  it("nulla 28 napos átlagból hallgat, nem 'Infinity-szerese'-t mond", () => {
    // Egy 0-s átlaggal `todaySteps / mean` Infinity — a `mean > 0` őr nélkül
    // ez simán átment volna a >= STEP_RATIO próbán.
    expect(highlight({
      ...csend, todaySteps: 5000,
      steps28: { value: 0, n: 28, coverage: 1, window: "28d" },
    })).toBeNull();
  });

  it("a HRV előbbre való a lépésnél", () => {
    // A sorrend számít: egyszerre mindkettő igaz lehet, és egy mondat van.
    const s = highlight({
      hrvDeviation: { sigma: 1.42, n7: 6, n90: 84 },
      todaySteps: 18000,
      steps28: { value: 10000, n: 28, coverage: 1, window: "28d" },
    });
    expect(s).toContain("HRV");
    expect(s).not.toContain("lépés");
  });

  it("ha semmi nem emelkedik ki, hallgat", () => {
    // A csend is tartalom: egy kiemelés, ami minden nap megszólal, annyit ér,
    // mint egy jelző, ami mindig ég.
    expect(highlight(csend)).toBeNull();
  });
});

describe("a köszönés sávja", () => {
  it("mondat nélkül is megvan a köszönés", () => {
    // A köszönés soha nem múlik adaton.
    const html = greetingBand({ hour: 8, name: "Marcell" }, null);
    expect(html).toContain("Marcell");
    expect(html).not.toContain("mondat");
  });

  it("mérés nélkül sincs benne üres mondat-elem", () => {
    const html = greetingBand({ hour: 8, name: "" }, csend);
    expect(html).not.toContain('class="mondat"');
  });

  it("a mondat a köszönés alatt jelenik meg", () => {
    const html = greetingBand({ hour: 8, name: "M" },
      { ...csend, hrvDeviation: { sigma: 1.42, n7: 6, n90: 84 } });
    expect(html).toContain('class="mondat"');
    expect(html.indexOf("Jó reggelt")).toBeLessThan(html.indexOf("HRV"));
  });

  it("a mondatban a nevet nem escape-eli kétszer", () => {
    // greeting() már escape-elt HTML-t ad vissza; a sáv nem szabad, hogy
    // még egyszer lefuttassa rajta az escapeHtml-t, különben az "&lt;"
    // "&amp;lt;"-vé dupláz.
    const html = greetingBand({ hour: 8, name: "<b>x</b>" }, null);
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("&amp;lt;");
  });

  it("a sáv stílusa létezik, és nem használ riasztás-színt", () => {
    const rules = STYLE.split("\n").filter((l) => l.trimStart().startsWith(".koszones"));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.join("")).not.toContain("riado");
  });
});
