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
    const at = (hour: number) => greeting({ hour, name: "" });
    expect(at(4)).toContain("Jó reggelt");   // hajnal 04-től
    expect(at(3)).toContain("Jó éjt");       // 04 előtt még éjszaka
    expect(at(7)).toContain("Jó reggelt");
    expect(at(10)).toContain("Szép napot");  // délelőtt
    expect(at(9)).toContain("Jó reggelt");   // 10 előtt még reggel
    expect(at(12)).toContain("Jó napot");    // délután
    expect(at(11)).toContain("Szép napot");  // 12 előtt még délelőtt
    expect(at(18)).toContain("Szép estét");
    expect(at(17)).toContain("Jó napot");    // 18 előtt még délután
    expect(at(22)).toContain("Jó éjt");
    expect(at(21)).toContain("Szép estét");  // 22 előtt még este
    expect(at(23)).toContain("Jó éjt");
    expect(at(0)).toContain("Jó éjt");
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
    // A lefelé tartó HRV információ, nem riasztás.
    const s = highlight({ ...csend, hrvDeviation: { sigma: -1.3, n7: 6, n90: 84 } });
    expect(s).toContain("1,3");
    expect(s).toContain("alatt");
    expect(s).not.toContain("riado");
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
