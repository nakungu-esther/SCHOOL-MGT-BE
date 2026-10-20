import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  announcementVisibleToRole,
  hasExplicitStudentLink,
} from "./portal-access";

describe("announcementVisibleToRole", () => {
  it("allows admin to see all audiences", () => {
    assert.equal(announcementVisibleToRole("PARENT", "SCHOOL_ADMIN"), true);
    assert.equal(announcementVisibleToRole("STUDENT", "SCHOOL_ADMIN"), true);
  });

  it("restricts parent and student audiences", () => {
    assert.equal(announcementVisibleToRole("ALL", "PARENT"), true);
    assert.equal(announcementVisibleToRole("PARENT", "PARENT"), true);
    assert.equal(announcementVisibleToRole("STUDENT", "PARENT"), false);

    assert.equal(announcementVisibleToRole("ALL", "STUDENT"), true);
    assert.equal(announcementVisibleToRole("STUDENT", "STUDENT"), true);
    assert.equal(announcementVisibleToRole("PARENT", "STUDENT"), false);
  });
});

describe("hasExplicitStudentLink", () => {
  const links = [
    { userId: "u1", studentId: "s1" },
    { userId: "u1", studentId: "s2" },
  ];

  it("grants access only for linked students", () => {
    assert.equal(hasExplicitStudentLink(links, "u1", "s1"), true);
    assert.equal(hasExplicitStudentLink(links, "u1", "s3"), false);
    assert.equal(hasExplicitStudentLink(links, "u2", "s1"), false);
  });
});
