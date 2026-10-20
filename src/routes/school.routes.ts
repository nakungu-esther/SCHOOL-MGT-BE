import { Router } from "express";
import { writeAuditLog } from "../lib/audit-log";
import { prisma } from "../lib/prisma";
import { schoolSettingsSchema } from "../lib/school-settings-schema";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const settingsSelect = {
  id: true,
  name: true,
  slug: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  country: true,
  phone: true,
  contactEmail: true,
  timezone: true,
  motto: true,
  academicYear: true,
  term: true,
  currency: true,
  updatedAt: true,
} as const;

export const schoolRouter = Router();

async function getSettings(req: AuthedRequest, res: import("express").Response) {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;

  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: settingsSelect,
  });
  if (!school) {
    res.status(404).json({ error: "School not found" });
    return;
  }
  res.json(school);
}

async function updateSettings(req: AuthedRequest, res: import("express").Response) {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;

  const parsed = schoolSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid settings",
      details: parsed.error.flatten(),
    });
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const school = await prisma.school.update({
    where: { id: schoolId },
    data: parsed.data,
    select: settingsSelect,
  });

  void writeAuditLog({
    schoolId,
    userId: req.auth!.user.id,
    action: "SCHOOL_SETTINGS_UPDATED",
    detail: { fields: Object.keys(parsed.data) },
  });

  res.json(school);
}

schoolRouter.get(
  "/settings",
  requireAuth,
  requirePermission("school.manage"),
  getSettings,
);

schoolRo