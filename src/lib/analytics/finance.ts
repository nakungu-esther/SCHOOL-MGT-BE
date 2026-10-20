import { prisma } from "../prisma";
import {
  type AnalyticsFilters,
  buildStudentScope,
  resolveAnalyticsPeriod,
} from "./filters";
import { formatMoney, formatPct, kpi, pct } from "./kpi";

function sumDecimal(values: { toString(): string }[]): number {
  let t = 0;
  for (const v of values) t += Number(v);
  return Math.round(t * 100) / 100;
}

export async function financeAnalytics(schoolId: string, filters: AnalyticsFilters) {
  const period = await resolveAnalyticsPeriod(schoolId, filters);
  const { studentIds } = await buildStudentScope(schoolId, filters);
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { currency: true },
  });
  const currency = school?.currency ?? "USD";

  if (studentIds.length === 0) {
    return emptyFinance(currency);
  }

  const invDate =
    period.from || period.to
      ? {
          createdAt: {
            ...(period.from ? { gte: period.from } : {}),
            ...(period.to ? { lte: period.to } : {}),
          },
        }
      : {};

  const payDate =
    period.from || period.to
      ? {
          paidAt: {
            ...(period.from ? { gte: period.from } : {}),
            ...(period.to ? { lte: period.to } : {}),
          },
        }
      : {};

  const [invoices, payments, methods] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        schoolId,
        studentId: { in: studentIds },
        status: { not: "VOID" },
        ...invDate,
      },
      select: {
        amountTotal: true,
        amountPaid: true,
        status: true,
        dueDate: true,
        invoiceNo: true,
        student: { select: { fullName: true } },
      },
      take: 500,
    }),
    prisma.invoicePayment.findMany({
      where: {
        schoolId,
        invoice: { studentId: { in: studentIds } },
        ...payDate,
      },
      select: { amount: true, paidAt: true },
      take: 5000,
    }),
    prisma.invoicePayment.groupBy({
      by: ["method"],
      where: {
        schoolId,
        invoice: { studentId: { in: studentIds } },
        ...payDate,
      },
      _sum: { amount: true },
    }),
  ]);

  let billed = 0;
  let paidOnInv = 0;
  let outstanding = 0;
  let overdue = 0;
  const now = new Date();
  const aging = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };

  for (const inv of invoices) {
    const total = Number(inv.amountTotal);
    const paid = Number(inv.amountPaid);
    const bal = Math.max(0, total - paid);
    billed += total;
    paidOnInv += paid;
    if (inv.status !== "PAID") {
      outstanding += bal;
      if (inv.dueDate && inv.dueDate < now) overdue += 1;
      const days = inv.dueDate
        ? Math.floor((now.getTime() - inv.dueDate.getTime()) / 86400000)
        : 0;
      if (bal <= 0) continue;
      if (days <= 0) aging.current += bal;
      else if (days <= 30) aging.d30 += bal;
      else if (days <= 60) aging.d60 += bal;
      else if (days <= 90) aging.d90 += bal;
      else aging.d90plus += bal;
    }
  }

  const collected = sumDecimal(payments.map((p) => p.amount));
  const collectionRate = pct(collected, billed);

  const monthly = new Map<string, number>();
  for (const p of payments) {
    const m = p.paidAt.toISOString().slice(0, 7);
    monthly.set(m, (monthly.get(m) ?? 0) + Number(p.amount));
  }

  const topOutstanding = invoices
    .map((inv) => ({
      invoiceNo: inv.invoiceNo,
      student: inv.student.fullName,
      balance: Math.max(0, Number(inv.amountTotal) - Number(inv.amountPaid)),
      status: inv.status,
    }))
    .filter((r) => r.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 20);

  return {
    currency,
    kpis: [
      kpi("billed", "Total invoiced", "Invoice totals in period.", formatMoney(billed, currency), billed),
      kpi("collected", "Payments collected", "Confirmed payments in period.", formatMoney(collected, currency), collected),
      kpi("outstanding", "Outstanding", "Unpaid invoice balances.", formatMoney(outstanding, currency), outstanding),
      kpi("collectionRate", "Collection rate", "Collected vs invoiced in period.", formatPct(collectionRate), collectionRate),
      kpi("overdue", "Overdue invoices", "Past due date and not paid.", String(overdue), overdue),
    ],
    charts: {
      monthly: [...monthly.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 })),
      aging: [
        { bucket: "Current", amount: Math.round(aging.current * 100) / 100 },
        { bucket: "1–30 days", amount: Math.round(aging.d30 * 100) / 100 },
        { bucket: "31–60 days", amount: Math.round(aging.d60 * 100) / 100 },
        { bucket: "61–90 days", amount: Math.round(aging.d90 * 100) / 100 },
        { bucket: "90+ days", amount: Math.round(aging.d90plus * 100) / 100 },
      ],
      methods: methods.map((m) => ({
        method: m.method,
        total: Number(m._sum.amount ?? 0),
      })),
    },
    tables: { outstanding: topOutstanding },
  };
}

function emptyFinance(currency: string) {
  return {
    currency,
    kpis: [
      kpi("billed", "Total invoiced", "—", formatMoney(0, currency), 0),
      kpi("collected", "Collected", "—", formatMoney(0, currency), 0),
      kpi("outstanding", "Outstanding", "—", formatMoney(0, currency), 0),
      kpi("collectionRate", "Collection rate", "—", "—"),
      kpi("overdue", "Overdue", "—", "0"),
    ],
    charts: { monthly: [], aging: [], methods: [] },
    tables: { outstanding: [] },
  };
}
