import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";

export const dashboardRouter = Router();

dashboardRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;

  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: {
      id: true,
      name: true,
      slug: true,
      academicYear: true,
      term: true,
      currency: true,
      addressLine1: true,
      city: true,
      country: true,
      contactEmail: true,
    },
  });

  if (!school) {
    res.status(404).json({ error: "School not found" });
    return;
  }

  const [
    students,
    staff,
    teachers,
    paymentAgg,
    recentStudents,
  ] = await Promise.all([
    prisma.student.count({
      where: { schoolId, status: "ACTIVE" },
    }),
    prisma.staff.count({
      where: { schoolId, active: true },
    }),
    prisma.staff.count({
      where: { schoolId, active: true, kind: "TEACHER" },
    }),
    prisma.invoicePayment.aggregate({
      where: { schoolId },
      _count: { id: true },
      _sum: { amount: true },
    }),
    prisma.student.findMany({
      where: { schoolId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        admissionNo: true,
        fullName: true,
        className: true,
        status: true,
        createdAt: true,
      },
    }),
  ]);

  const settingsComplete = Boolean(
    school.addressLine1 &&
      school.city &&
      school.country &&
      school.contactEmail &&
      school.academicYear &&
      school.term,
  );

  res.json({
    schoolId: school.id,
    schoolName: school.name,
    slug: school.slug,
    academicYear: school.academicYear,
    term: school.term,
    currency: school.currency,
    stats: {
      students,
      staff,
      teachers,
      paymentsCount: paymentAgg._count.id,
      paymentsTotal: Number(paymentAgg._sum.amount ?? 0),
    },
    recentStudents: recentStudents.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
    })),
    onboarding: {
      settingsComplete,
      hasStudents: students > 0,
      steps: [
        {
          id: "settings",
          label: "Complete school settings",
          done: settingsComplete,
          path: "/dashboard/settings",
        },
        {
          id: "students",
          label: "Admit your first student",
          done: students > 0,
          path: "/dashboard/students",
        },
      ],
    },
    role: req.auth!.role,
  });
});

dashboardRouter.get("/charts", requireAuth, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;

  const role = req.auth!.role;
  const canFinance = role === "SCHOOL_ADMIN" || role === "BURSAR";

  const [
    genderGroups,
    enrollmentByMonth,
    attendanceByStatus,
    paymentMethods,
    classCounts,
    examCount,
    invoiceAgg,
  ] = await Promise.all([
    prisma.student.groupBy({
      by: ["gender"],
      where: { schoolId, status: "ACTIVE" },
      _count: { id: true },
    }),
    prisma.$queryRaw<{ month: string; count: bigint }[]>`
      SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
             COUNT(*)::bigint AS count
      FROM students
      WHERE school_id = ${schoolId}::uuid
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    `,
    prisma.attendanceRecord.groupBy({
      by: ["status"],
      where: { schoolId },
      _count: { id: true },
    }),
    canFinance
      ? prisma.invoicePayment.groupBy({
          by: ["method"],
          where: { schoolId },
          _sum: { amount: true },
        })
      : Promise.resolve([]),
    prisma.student.groupBy({
      by: ["className"],
      where: { schoolId, status: "ACTIVE" },
      _count: { id: true },
    }),
    prisma.examination.count({ where: { schoolId } }),
    canFinance
      ? prisma.invoice.findMany({ where: { schoolId }, select: { amountTotal: true, amountPaid: true, status: true } })
      : Promise.resolve([]),
  ]);

  let billed = 0;
  let collected = 0;
  let outstanding = 0;
  for (const inv of invoiceAgg) {
    const t = Number(inv.amountTotal);
    const p = Number(inv.amountPaid);
    billed += t;
    collected += p;
    if (inv.status !== "VOID" && inv.status !== "PAID") {
      outstanding += Math.max(0, t - p);
    }
  }

  res.json({
    genderDistribution: genderGroups.map((g) => ({
      gender: g.gender,
      count: g._count.id,
    })),
    enrollmentTrend: enrollmentByMonth
      .map((r) => ({ month: r.month, count: Number(r.count) }))
      .reverse(),
    attendanceByStatus: attendanceByStatus.map((a) => ({
      status: a.status,
      count: a._count.id,
    })),
    studentsByClass: classCounts.map((c) => ({
      className: c.className,
      count: c._count.id,
    })),
    finance: canFinance
      ? {
          billed,
          collected,
          outstanding,
          collectionRate: billed > 0 ? (collected / billed) * 100 : null,
        }
      : null,
    paymentMethods: paymentMethods.map((m) => ({
      method: m.method,
      total: Number(m._sum.amount ?? 0),
    })),
    upcomingExaminations: examCount,
  });
});
