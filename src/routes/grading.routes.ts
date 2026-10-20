import { Router } from "express";
import { z } from "zod";
import { DEFAULT_BANDS, getGradeBands } from "../lib/grading";
import { prisma } from "../lib/prisma";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePermission, requireRole } from "../middleware/rbac";

export const gradingRouter = Router();

gradingRouter.get(
  "/bands",
  requireAuth,
  requirePermission("assessment.view"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const bands = await getGradeBands(schoolId);
    const persisted = await prisma.gradeBand.count({ where: { schoolId } });
    res.json({ bands, usingDefaults: persisted === 0 });
  },
);

const bandsSchema = z.object({
  bands: z.array(
    z.object({
      label: z.string().min(1).max(8),
      minPercent: z.number().min(0).max(100),
      maxPercent: z.number().min(0).max(100),
      sortOrder: z.number().int(),
    }),
  ),
});

gradingRouter.put(
  "/bands",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    const parsed = bandsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid grade bands" });
      return;
    }
    if (parsed.data.bands.length === 0) {
      res.status(400).json({ error: "At least one band required" });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.gradeBand.deleteMany({ where: { schoolId } });
      await tx.gradeBand.createMany({
        data: parsed.data.bands.map((b) => ({
          schoolId,
          label: b.label,
          minPercent: b.minPercent,
          maxPercent: b.maxPercent,
          sortOrder: b.sortOrder,
        })),
      });
    });

    res.json({ ok: true, bands: parsed.data.bands });
  },
);

gradingRouter.post(
  "/bands/reset-defaults",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    await prisma.gradeBand.deleteMany({ where: { schoolId } });
    res.json({ bands: DEFAULT_BANDS, usingDefaults: true });
  },
);
