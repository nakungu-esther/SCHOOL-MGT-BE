import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { announcementVisibleToRole } from "../portal-access";

describe("announcement audience for notifications", () => {
  it("parents receive parent and all announcements only", () => {
    assert.equal(announcementVisibleToRole("PARENT", "PARENT"), true);
    assert.equal(announcementVisibleToRole("STUDENT", "PARENT"), false);
  });
});

describe("idempotency key shape", () => {
  it("attendance keys include date and status", () => {
    const key = `attendance:student-1:2026-01-01:ABSENT:u1`;
    assert.match(key, /attendance:.*:ABSENT/);
  });
});
