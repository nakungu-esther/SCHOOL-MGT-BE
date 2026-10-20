import { prisma } from "./prisma";

export async function academicReportSummary(schoolId: string) {
  const examinations = await prisma.examination.findMany({
    where: { schoolId },
    include: {
      schoolClass: { select: { name: true } },
      academicYear: { select: { name: true } },
      _count: { select: { marks: true, papers: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const markAgg = await prisma.examMark.groupBy({
    by: ["examinationId"],
    where: { schoolId },
    _count: { id: true },
    _avg: { score: true },
  });
  const avgByExam = new Map(
    markAgg.map((row) => [
      row.examinationId,
      { count: row._count.id, average: Number(row._avg.score ?? 0) },
    ]),
  );

  return {
    examinations: examinations.map((exam) => {
      const stats = avgByExam.get(exam.id);
      return {
        id: exam.id,
        name: exam.name,
        term: exam.term,
        className: exam.schoolClass.name,
        academicYear: exam.academicYear.name,
        published: exam.published,
        paperCount: exam._count.papers,
        marksRecorded: stats?.count ?? exam._count.marks,
        averageScore: stats?.average ?? null,
      };
    }),
  };
}

export async function attendanceReportSummary(schoolId: string) {
  const grouped = await prisma.attendanceRecord.groupBy({
    by: ["status"],
    where: { schoolId },
    _count: { id: true },
  });

  const totals: Record<string, number> = {
    PRESENT: 0,
    ABSENT: 0,
    LATE: 0,
    EXCUSED: 0,
  };
  let total = 0;
  for (const row of grouped) {
    totals[row.status] = row._count.id;
    total += row._count.id;
  }

  return { totals, totalRecords: total };
}

export async function financeReportSummary(schoolId: string) {
  const [invoices, payments] = await Promise.all([
    prisma.invoice.findMany({
      where: { schoolId },
      include: { student: { select: { fullName: true, admissionNo: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.invoicePayment.aggregate({
      where: { schoolId },
      _sum: { amount: true },
      _count: { id: true },
    }),
  ]);

  let billed = 0;
  let paidOnInvoices = 0;
  let outstanding = 0;

  const rows = invoices.map((inv) => {
    const total = Number(inv.amountTotal);
    const paid = Number(inv.amountPaid);
    const balance = Math.max(0, total - paid);
    billed += total;
    paidOnInvoices += paid;
    if (inv.status !== "VOID" && inv.status !== "PAID") {
      outstanding += balance;
    }
    return {
      invoiceNo: inv.invoiceNo,
      studentName: inv.student.fullName,
      admissionNo: inv.student.admissionNo,
      status: inv.status,
      amountTotal: total,
      amountPaid: paid,
      balance,
    };
  });

  return {
    summary: {
      invoiceCount: invoices.length,
      billed,
      collected: Number(payments._sum.amount ?? 0),
      paidOnInvoices,
      outstanding,
      paymentCount: payments._count.id,
    },
    invoices: rows,
  };
}
