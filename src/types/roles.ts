import type { Role } from "@prisma/client";

export type { Role };

export type Permission =
  | "school.manage"
  | "students.view"
  | "students.manage"
  | "finance.view"
  | "finance.manage"
  | "classes.view"
  | "classes.manage"
  | "attendance.view"
  | "attendance.manage"
  | "assessment.view"
  | "assessment.manage"
  | "parent.portal"
  | "student.portal"
  | "reports.view";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SCHOOL_ADMIN: [
    "school.manage",
    "students.view",
    "students.manage",
    "finance.view",
    "finance.manage",
    "classes.view",
    "classes.manage",
    "attendance.view",
    "attendance.manage",
    "assessment.view",
    "assessment.manage",
    "reports.view",
  ],
  TEACHER: [
    "classes.view",
    "classes.manage",
    "students.view",
    "attendance.view",
    "attendance.manage",
    "assessment.view",
    "assessment.manage",
    "reports.view",
  ],
  BURSAR: ["finance.view", "finance.manage", "students.view", "reports.view"],
  PARENT: ["parent.portal", "students.view"],
  STUDENT: ["student.portal"],
};

export function permissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}
