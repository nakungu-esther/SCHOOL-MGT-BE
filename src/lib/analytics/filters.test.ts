import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAnalyticsFilters } from "./filters";

describe("parseAnalyticsFilters", () => {
  it("accepts empty query", () => {
    const f = parseAnalyticsFilters({});
    assert.equal(f.academicYearId, undefined);
  });

  it("parses gender and term", () => {
    const f = parseAnalyticsFilters({ gender: "MALE", term: "Term 1" });
    assert.equal(f.gender, "MALE");
    assert.equal(f.term, "Term 1");
  });
});
