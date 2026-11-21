import { describe, expect, it } from "vitest";
import { DRAFT_LIMITS, clearDraft, listDrafts, loadDraft, saveDraft } from "./drafts";

describe("draft persistence", () => {
  it("round-trips, clears and isolates sessions", () => {
    saveDraft("s1", "hello");
    saveDraft("s2", "world");
    expect(loadDraft("s1")).toBe("hello");
    expect(loadDraft("s2")).toBe("world");
    saveDraft("s1", "");
    expect(loadDraft("s1")).toBe("");
    clearDraft("s2");
    expect(loadDraft("s2")).toBe("");
  });

  it("bounds the draft size and the session count", () => {
    saveDraft("big", "x".repeat(DRAFT_LIMITS.MAX_DRAFT_BYTES + 100));
    expect(loadDraft("big").length).toBe(DRAFT_LIMITS.MAX_DRAFT_BYTES);
    for (let index = 0; index < 25; index += 1) saveDraft(`s${index}`, `draft ${index}`);
    expect(listDrafts().length).toBeLessThanOrEqual(DRAFT_LIMITS.MAX_SESSIONS);
  });

  it("survives corrupted storage", () => {
    window.localStorage.setItem("omp-console.drafts.v1", "{not json");
    expect(loadDraft("s1")).toBe("");
    saveDraft("s1", "ok");
    expect(loadDraft("s1")).toBe("ok");
  });
});
