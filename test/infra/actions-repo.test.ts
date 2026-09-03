import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createActionRepo } from "../../src/infra/db/repositories/actions.ts";

const NOW = new Date("2026-09-03T08:00:00.000Z");

/** One checkbox action for a given day, through the repo's own writer. */
const seed = (repo: ReturnType<typeof createActionRepo>, date: string, text: string) =>
  repo.replaceForDate(date, [{
    module: "Teszt",
    action: { id: `${date}-${text}`, kind: "checkbox", text },
  }], NOW);

describe("ActionRepo.listAllOpen", () => {
  it("a más napra szóló nyitott teendőt is visszaadja", () => {
    // Ez a feladat egyetlen oka. A listOpen(ma) a valódi adatbázison ma üres
    // listát ad: a kilenc nyitott teendő egyike sem a mai napra szól, mert a
    // modulok naponta a SAJÁT napjuk teendőit cserélik le, a többi napé pedig
    // nyitva marad, amíg valaki le nem zárja.
    const db = memoryDb();
    const repo = createActionRepo(db);
    seed(repo, "2026-08-30", "régi");
    seed(repo, "2026-09-04", "jövőbeli");

    expect(repo.listOpen("2026-09-03")).toHaveLength(0);
    expect(repo.listAllOpen().map((a) => a.text).sort()).toEqual(["jövőbeli", "régi"]);
    db.close();
  });

  it("a legfrissebb napot adja elöl", () => {
    const db = memoryDb();
    const repo = createActionRepo(db);
    seed(repo, "2026-08-30", "régi");
    seed(repo, "2026-09-04", "jövőbeli");
    expect(repo.listAllOpen().map((a) => a.date)).toEqual(["2026-09-04", "2026-08-30"]);
    db.close();
  });

  it("a lezárt teendőt nem adja vissza", () => {
    // A `declined` is válasz, nem eltüntetés — de a nyitottak közé nem való.
    const db = memoryDb();
    const repo = createActionRepo(db);
    const [nyitott] = seed(repo, "2026-09-03", "nyitott");
    seed(repo, "2026-09-02", "lezart");
    const lezart = repo.listAllOpen().find((a) => a.text === "lezart")!;
    repo.setStatus(lezart.id, "declined", NOW);
    expect(repo.listAllOpen().map((a) => a.id)).toEqual([nyitott!.id]);
    db.close();
  });

  it("üres táblára üres listát ad", () => {
    const db = memoryDb();
    expect(createActionRepo(db).listAllOpen()).toEqual([]);
    db.close();
  });

  it("a naptár-javaslatot a saját javaslatával adja vissza", () => {
    // A proposal_json a modulokból jön; ha nem parse-olódik vissza, a Ma
    // oldal egy naptárba író gombot mutatna a javaslat részletei nélkül.
    const db = memoryDb();
    const repo = createActionRepo(db);
    repo.replaceForDate("2026-09-05", [{
      module: "WeekendPlanner",
      action: {
        id: "p1", kind: "proposal", text: "Kirándulás",
        proposal: {
          title: "Kirándulás", start: "2026-09-05T09:00:00+02:00",
          end: "2026-09-05T12:00:00+02:00", location: "Szentendre",
        },
      },
    }], NOW);
    const only = repo.listAllOpen()[0]!;
    expect(only.kind).toBe("proposal");
    expect(only.proposal?.location).toBe("Szentendre");
    db.close();
  });
});
