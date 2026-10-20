import { Router } from "express";
import type { Role } from "@prisma/client";
import { ZodError } from "zod";
import { academicsAnalytics } from "../lib/analytics/academics";
import { attendanceAnalytics } from "../lib/analytics/attendance";
import { enrollmentAnalytics } from "../lib/analytics/enrollment";
import {
  loadAnalyticsFilterOptions,
  parseAnalyticsFilters,
} from "../lib/analytics/filters";
import { financeAnalytics } from "../lib/analytics/finance";
import {
  sectionToCsv,
  sectionToPdf,
  sectionToXlsx,
} from "../lib/analytics/export-section";
import { analyticsOverview } from "../lib/analytics/overview";
import { staffAnalytics } from "../lib/analytics/staff";
import { prisma } from "../lib/prisma";
import { requireTenantScope } from "../lib/tenant";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

export const analyticsRouter = Router();

const analyticsRead = [requireAuth, requirePermission("reports.view")] as const;

type Section = "enrollment" | "academics" | "attendance" | "finance" | "staff";

function canViewFinance(role: Role): boolean {
  return role === "SCHOOL_ADMIN" || role === "BURSAR";
}

async function loadSection(section: Section, schoolId: string, filters: ReturnType<typeof parseAnalyticsFilters>, role: Role) {
  if (section === "enrollment") return enrollmentAnalytics(schoolId, filters);
  if (section === "academics") return academicsAnalytics(schoolId, filters);
  if (section === "attendance") return attendanceAnalytics(schoolId, filters);
  if (section === "finance") {
    if (!canViewFinance(role)) {
      return { forbidden: true as const };
    }
    return financeAnalytics(schoolId, filters);
  }
  return staffAnalytics(schoolId, filters);
}

function parseSection(raw: string): Section | null {
  if (["enrollment", "academics", "attendance", "finance", "staff"].includes(raw)) {
    return raw as Section;
  }
  return null;
}

analyticsRouter.get("/filters", ...analyticsRead, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  res.json(await loadAnalyticsFilterOptions(schoolId));
});

analyticsRouter.get("/overview", ...analyticsRead, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;
  try {
    const filters = parseAnalyticsFilters(req.query as Record<string, unknown>);
    const data = await analyticsOverview(schoolId, filters, canViewFinance(req.auth!.role));
    res.json(data);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Invalid analytics filters" });
      return;
    }
    throw err;
  }
});

for (const section of ["enrollment", "academics", "attendance", "finance", "staff"] as Section[]) {
  analyticsRouter.get(`/${section}`, ...analyticsRead, async (req: AuthedRequest, res) => {
    const schoolId = requireTenantScope(req, res);
    if (!schoolId) return;
    if (section === "finance" && !canViewFinance(req.auth!.role)) {
      res.status(403).json({ error: "Financial analytics require bursar or admin access" });
      return;
    }
    try {
      const filters = parseAnalyticsFilters(req.query as Record<string, unknown>);
      const data = await loadSection(section, schoolId, filters, req.auth!.role);
      if (data && typeof data === "object" && "forbidden" in data) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.json(data);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: "Invalid analytics filters" });
        return;
      }
      console.error(`GET /analytics/${section} failed:`, err);
      res.status(500).json({ error: "Analytics query failed" });
    }
  });
}

analyticsRouter.get("/:section/export", ...analyticsRead, async (req: AuthedRequest, res) => {
  const schoolId = requireTenantScope(req, res);
  if (!schoolId) return;

  const section = parseSection(String(req.params.section));
  if (!section) {
    res.status(400).json({ error: "Unknown section" });
    return;
  }
  if (section === "finance" && !canViewFinance(req.auth!.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const format = String(req.query.format ?? "csv").toLowerCase();
  if (!["csv", "xlsx", "pdf"].includes(format)) {
    res.status(400).json({ error: "format must be csv, xlsx, or pdf" });
    return;
  }

  try {
    const filters = parseAnalyticsFilters(req.query as Record<string, unknown>);
    const data = await loadSection(section, schoolId, filters, req.auth!.role);
    if (data && typeof data === "object" && "forbidden" in data) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true },
    });
    const title = `${section.charAt(0).toUpperCase()}${section.slice(1)} analytics`;
    const kpis = "kpis" in data ? (data.kpis as { label: string; displayValue: string }[]) : [];

    let tableHeaders: string[] = [];
    let tableRows: (string | number)[][] = [];
    if ("tables" in data && data.tables) {
      const tables = data.tables as Record<string, Record<string, unknown>[]>;
      const firstKey = Object.keys(tables)[0];
      const rows = firstKey ? tables[firstKey] : [];
      if (rows?.length) {
        tableHeaders = Object.keys(rows[0]!).filter((k) => k !== "linkPath" && k !== "studentId" && k !== "staffId" && k !== "subjectId");
        tableRows = rows.map((r) => tableHeaders.map((h) => String(r[h] ?? "")));
      }
    }

    if (format === "csv") {
      const csv = sectionToCsv(title, kpis, tableHeaders, tableRows);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="edumanage-${section}.csv"`);
      res.send("\uFEFF" + csv);
      return;
    }

    if (format === "xlsx") {
      const buf = await sectionToXlsx(school?.name ?? "School", title, kpis, tableHeaders, tableRows);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="edumanage-${section}.xlsx"`);
      res.send(buf);
      return;
    }

    const pdf = await sectionToPdf(school?.name ?? "School", title, kpis);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="edumanage-${section}.pdf"`);
    res.send(pdf);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Invalid filters" });
      return;
    }
    console.error("analytics export failed:", err);
    res.status(500).json({ error: "Export failed" });
  }
});
