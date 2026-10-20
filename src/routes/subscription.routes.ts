import { Router } from "express";
import { z } from "zod";
import { writeAuditLog } from "../lib/audit-log";
import { prisma } from "../lib/prisma";
import {
  defaultTrialEndsAt,
  planByCode,
  SUBSCRIPTION_PLANS,
} from "../lib/subscription-plans";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requireRole } from "../middleware/rbac";

export const subscriptionRouter = Router();

subscriptionRouter.get("/plans", (_req, res) => {
  res.json({
    items: SUBSCRIPTION_PLANS.map((p) => ({
      code: p.code,
      name: p.name,
      monthlyPriceUgx: p.monthlyPriceUgx,
      studentLimit: p.studentLimit,
      description: p.description,
    })),
    note: "Illustrative pricing — live billing is not enabled.",
  });
});

subscriptionRouter.get(
  "/status",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    let sub = await prisma.schoolSubscription.findUnique({
      where: { schoolId },
    });

    if (!sub) {
      sub = await prisma.schoolSubscription.create({
        data: {
          schoolId,
          planCode: "STARTER",
          status: "TRIAL",
          trialEndsAt: defaultTrialEndsAt(),
        },
      });
    }

    const plan = planByCode(sub.planCode);
    const studentCount = await prisma.student.count({
      where: { schoolId, status: "ACTIVE" },
    });

    res.json({
      plan: {
        code: plan.code,
        name: plan.name,
        monthlyPriceUgx: plan.monthlyPriceUgx,
        studentLimit: plan.studentLimit,
      },
      status: sub.status,
      trialEndsAt: sub.trialEndsAt,
      selectedAt: sub.selectedAt,
      studentCount,
      limitEnforced: false,
    });
  },
);

const selectBody = z.object({
  planCode: z.enum(["STARTER", "GROWTH", "ENTERPRISE"]),
});

subscriptionRouter.post(
  "/select",
  requireAuth,
  requireRole("SCHOOL_ADMIN"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const parsed = selectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid plan selection" });
      return;
    }

    const plan = planByCode(parsed.data.planCode);
    const sub = await prisma.schoolSubscription.upsert({
      where: { schoolId },
      create: {
        schoolId,
        planCode: plan.code,
        status: "TRIAL",
        trialEndsAt: defaultTrialEndsAt(),
      },
      update: {
        planCode: plan.code,
        status: "TRIAL",
        trialEndsAt: defaultTrialEndsAt(),
      },
    });

    await writeAuditLog({
      schoolId,
      userId: req.auth!.user.id,
      action: "SUBSCRIPTION_PLAN_SELECTED",
      detail: { planCode: plan.code, planName: plan.name },
    });

    res.json({
      planCode: sub.planCode,
      status: sub.status,
      trialEndsAt: sub.trialEndsAt,
      message: "Plan recorded for trial — billing integration pending.",
    });
  },
);
