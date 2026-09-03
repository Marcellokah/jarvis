import { describe, it, expect } from "vitest";
import { todayBody, type TodayData } from "../../src/delivery/http/view/today.ts";

const base: TodayData = {
  briefMarkdown: "## Nap\n- [ ] Ebéd kivétele",
  readings: [],
  lastSeen: null,
  writtenAge: null,
  hibaKod: undefined,
  actions: { napok: [], undoable: [] },
};

// This module is `renderPage`'s successor for the "/" page's brief block —
// `page.test.ts`'s old `describe("renderPage")` tested this exact rendering
// through the now-deleted whole-document function. Testing `todayBody`
// directly here is the direct, not just equivalent, replacement: it is the
// same code, just no longer reached through `renderPage`.
describe("todayBody", () => {
  it("renders the brief's markdown, task checkboxes included", () => {
    expect(todayBody(base)).toContain(
      `<li class="task"><input type="checkbox" disabled> Ebéd kivétele</li>`,
    );
  });

  it("says so when there is no brief", () => {
    expect(todayBody({ ...base, briefMarkdown: null })).toContain("Ma még nem készült briefing");
  });

  it("treats an empty-after-trim brief as no brief at all", () => {
    // Missing data must look missing: an empty "Briefing" section with
    // nothing under it reads as a brief that said nothing, not as one that
    // never ran. `routes/page.ts` already filters this case before it
    // reaches here, but `todayBody` carries its own guard too — this pins
    // that guard down directly, rather than only through the route.
    expect(todayBody({ ...base, briefMarkdown: "   " })).toContain("Ma még nem készült briefing");
  });
});
