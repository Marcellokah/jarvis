import { describe, it, expect } from "vitest";
import { memoryDb } from "../helpers.ts";
import { createWorkoutRepo } from "../../src/infra/db/repositories/workouts.ts";

const w = (date: string, type: string, min: number, kcal: number | null) => ({
  date, type, startedAt: `${date}T06:00:00.000Z`,
  durationMin: min, energyKcal: kcal, source: "teszt",
});

describe("WorkoutRepo.byType", () => {
  it("típusonként összesít, alkalomszám szerint csökkenően", () => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([
      w("2026-01-01", "Walking", 30, 120),
      w("2026-01-02", "Walking", 45, 180),
      w("2026-01-03", "Cycling", 60, 400),
    ]);
    const totals = repo.byType();
    expect(totals.map((t) => t.type)).toEqual(["Walking", "Cycling"]);
    expect(totals[0]!.sessions).toBe(2);
    expect(totals[0]!.minutes).toBe(75);
    expect(totals[0]!.kcal).toBe(300);
    expect(totals[0]!.lastDate).toBe("2026-01-02");
    db.close();
  });

  it("a kalóriát nem hordozó típusra null-t ad, nem nullát", () => {
    // 0 kcal azt állítaná, hogy megmértük és nulla volt. Az energy_kcal
    // nullázható, és a séta gyakran nem hoz kalóriát — a különbség valódi.
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([w("2026-01-01", "Cooldown", 10, null), w("2026-01-02", "Cooldown", 12, null)]);
    const only = repo.byType()[0]!;
    expect(only.kcal).toBeNull();
    expect(only.kcalFrom).toBe(0);
    db.close();
  });

  it("részleges kalóriánál megmondja, hány alkalomból jön az összeg", () => {
    // Egy 400 kcal-s összeg két alkalomból és tízből nagyon más állítás.
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save([
      w("2026-01-01", "Hiking", 60, 400),
      w("2026-01-02", "Hiking", 60, null),
      w("2026-01-03", "Hiking", 60, null),
    ]);
    const only = repo.byType()[0]!;
    expect(only.sessions).toBe(3);
    expect(only.kcal).toBe(400);
    expect(only.kcalFrom).toBe(1);
    db.close();
  });

  it("üres táblára üres listát ad", () => {
    const db = memoryDb();
    expect(createWorkoutRepo(db).byType()).toEqual([]);
    db.close();
  });
});

describe("WorkoutRepo.page", () => {
  const seed = (n: number) => {
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    repo.save(Array.from({ length: n }, (_, i) =>
      w(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, `T${i}`, 30, null)));
    return { db, repo };
  };

  it("a legújabbat adja elöl, és megmondja az összlétszámot", () => {
    const { db, repo } = seed(120);
    const first = repo.page(0, 50);
    expect(first.rows).toHaveLength(50);
    expect(first.total).toBe(120);
    expect(first.rows[0]!.date >= first.rows[49]!.date).toBe(true);
    db.close();
  });

  it("a tartományon túli eltolásra üres lapot ad, nem esik szét", () => {
    const { db, repo } = seed(10);
    const past = repo.page(500, 50);
    expect(past.rows).toEqual([]);
    expect(past.total).toBe(10);
    db.close();
  });

  it("negatív eltolást és nulla méretet is épen kezel", () => {
    // Ezek nem a felhasználótól jönnek, hanem egy elszámolt hívótól. A negatív eltolás
    // felével a kifelé látszó viselkedést rögzítjük, amit ma maga az SQLite ad meg; a
    // nulla méret fele az, ami ténylegesen a JS-beli korlátozást gyakorolja.
    const { db, repo } = seed(10);
    expect(repo.page(-5, 50).rows).toHaveLength(10);
    expect(repo.page(0, 0).rows).toHaveLength(1);
    db.close();
  });

  it("a kimeneti sorrend teljes a (date, startedAt, type) kulcs szerint", () => {
    // A lapozott olvasás nem teljes rendezés fölött szabadon adhat lapokként más
    // elrendezést, és akkor a lapváltásnál egy edzés kimarad, egy másik kétszer jön
    // vissza. A kimeneti sorrend ellenőrzése fogja meg ezt, a lapok összefésülése nem.
    const db = memoryDb();
    const repo = createWorkoutRepo(db);
    // Típusokat nem alfabetikus sorrendben szúrjuk be, hogy a hiányzó tie-break
    // rowid/insertion-order visszaesés nélkül nem lenne látható.
    const types = ["Walking", "Cycling", "Cooldown", "CoreTraining"];
    const rows = Array.from({ length: 120 }, (_, i) => {
      const dayNum = (i % 30) + 1;
      const typeIdx = Math.floor(i / 30);
      return w(
        `2026-01-${String(dayNum).padStart(2, "0")}`,
        types[typeIdx]!, 30, null,
      );
    });
    repo.save(rows);

    const result = repo.page(0, 120);
    expect(result.rows).toHaveLength(120);
    expect(result.total).toBe(120);

    // Assert strict monotonicity: each adjacent pair must satisfy (date DESC, startedAt DESC, type ASC).
    for (let i = 0; i < result.rows.length - 1; i++) {
      const curr = result.rows[i]!;
      const next = result.rows[i + 1]!;

      // Date descending
      if (curr.date !== next.date) {
        expect(curr.date > next.date).toBe(true);
      } else {
        // Same date: startedAt must be descending
        if (curr.startedAt !== next.startedAt) {
          expect(curr.startedAt > next.startedAt).toBe(true);
        } else {
          // Same startedAt: type must be ascending
          expect(curr.type <= next.type).toBe(true);
        }
      }
    }

    db.close();
  });
});
