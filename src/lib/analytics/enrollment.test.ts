import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pct } from "./kpi";

describe("analytics kpi pct", () => {
  it("returns null when denominator is zero", () => {
    assert.equal(pct(5, 0), null);
  });
  it("computes percentage", () => {
    assert.equal(pct(1, 4), 25);
  });
});
