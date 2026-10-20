import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

export const assessmentRouter = Router();

assessmentRouter.get(
  "/analytics",
  requireAuth,
  requirePermission("assessment.view"),
  async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;

    const [examCount, publishedExams, marksAgg, attendanceTotal] =
      await Promise.all([
        prisma.examination.count({ where: { schoolId } }),
        prisma.examination.count({ where: { schoolId, published: true } }),
        prisma.examMark.groupBy({
          by: ["examinationId"],
          where: { schoolId },
          _avg: { score: true },
          _count: { id: true },
        }),
        prisma.attendanceRecord.count({ where: { schoolId } }),
      ]);

    const presentCount = await prisma.attendanceRecord.count({
      where: { schoolId, status: "PRESENT" },
    });

    const examAverages = await Promise.all(
      marksAgg.map(async (g) => {
        const exam = await prisma.examination.findUnique({
          where: { id: g.examinationId },
          select: { name: true, term: true },
        });
        return {
          examinationId: g.examinationId,
          name: exam?.name ?? "Exam",
          term: exam?.term,
          averageScore: Number(g._avg.score ?? 0),
          markCount: g._count.id,
        };
      }),
    );

    res.json({
      examinations: {
        total: examCount,
        published: publishedExams,
      },
      attendance: {
        totalRecords: attendanceTotal,
        presentRate:
          attendanceTotal > 0 ? presentCount / attendanceTotal : 0,
      },
      examAverages,
    });
  },
);
