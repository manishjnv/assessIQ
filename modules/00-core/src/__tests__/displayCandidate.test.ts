import { describe, it, expect } from "vitest";
import {
  displayCandidate,
  ERASED_CANDIDATE_LABEL,
} from "../displayCandidate.js";

describe("displayCandidate()", () => {
  it("non-erased row with name + email → returns name, email, isErased=false", () => {
    const result = displayCandidate({
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
      erased_at: null,
    });
    expect(result).toEqual({
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
      isErased: false,
    });
  });

  it("non-erased row with name=null, email set → returns email as name", () => {
    const result = displayCandidate({
      id: "u2",
      name: null,
      email: "bob@example.com",
      erased_at: null,
    });
    expect(result).toEqual({
      id: "u2",
      name: "bob@example.com",
      email: "bob@example.com",
      isErased: false,
    });
  });

  it("non-erased row with both null → returns 'Unknown'", () => {
    const result = displayCandidate({
      id: "u3",
      name: null,
      email: null,
      erased_at: null,
    });
    expect(result).toEqual({
      id: "u3",
      name: "Unknown",
      email: null,
      isErased: false,
    });
  });

  it("erased row with tombstone strings → returns 'Erased candidate', email=null, isErased=true", () => {
    const result = displayCandidate({
      id: "u4",
      name: "deleted_user_abc123",
      email: "deleted+abc123@erased.assessiq.local",
      erased_at: "2026-05-30T10:00:00.000Z",
    });
    expect(result).toEqual({
      id: "u4",
      name: ERASED_CANDIDATE_LABEL,
      email: null,
      isErased: true,
    });
    expect(result.name).toBe("Erased candidate");
  });

  it("erased_at as Date object → still treated as erased", () => {
    const result = displayCandidate({
      id: "u5",
      name: "deleted_user_def456",
      email: "deleted+def456@erased.assessiq.local",
      erased_at: new Date("2026-05-30T10:00:00.000Z"),
    });
    expect(result).toEqual({
      id: "u5",
      name: ERASED_CANDIDATE_LABEL,
      email: null,
      isErased: true,
    });
  });
});
