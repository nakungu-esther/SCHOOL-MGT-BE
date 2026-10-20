import ExcelJS from "exceljs";
import type {
  academicReportSummary,
  attendanceReportSummary,
  financeReportSummary,
} from "./report-data";

type AcademicSummary = Awaited<ReturnType<typeof academicReportSummary>>;
type AttendanceSummary = Awaited<ReturnType<typeof attendanceReportSummary>>;
type FinanceSummary = Awaited<ReturnType<typeof financeReportSummary>>;

export async function academicSummaryToXlsx(
  data: AcademicSummary,
  schoolName: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Academic");
  sheet.addRow([schoolName, "Examination summary"]);
  sheet.addRow([]);
  sheet.addRow([
    "Exam",
    "Class",
    "Year",
    "Term",
    "Published",
    "Marks",
    "Avg score",
  ]);
  for (const row of data.examinations) {
    sheet.addRow([
      row.name,
      row.className,
      row.academicYear,
      row.term,
      row.published ? "Yes" : "No",
      row.marksRecorded,
      row.averageScore ?? "",
    ]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function attendanceSummaryToXlsx(
  data: AttendanceSummary,
  schoolName: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Attendance");
  sheet.addRow([schoolName, "Attendance totals"]);
  sheet.addRow([]);
  sheet.addRow(["Status", "Count"]);
  for (const [status, count] of Object.entries(data.totals)) {
    sheet.addRow([status, count]);
  }
  sheet.addRow(["Total", data.totalRecords]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function financeSummaryToXlsx(
  data: FinanceSummary,
  schoolName: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Finance");
  sheet.addRow([schoolName, "Financial summary"]);
  sheet.addRow([
    "Invoices",
    data.summary.invoiceCount,
    "Billed",
    data.summary.billed,
    "Collected",
    data.summary.collected,
    "Outstanding",
    data.summary.outstanding,
  ]);
  sheet.addRow([]);
  sheet.addRow([
    "Invoice",
    "Student",
    "Admission",
    "Status",
    "Total",
    "Paid",
    "Balance",
  ]);
  for (const inv of data.invoices) {
    sheet.addRow([
      inv.invoiceNo,
      inv.studentName,
      inv.admissionNo,
      inv.status,
      inv.amountTotal,
      inv.amountPaid,
      inv.balance,
    ]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
