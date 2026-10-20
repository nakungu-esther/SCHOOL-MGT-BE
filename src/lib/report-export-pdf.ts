import PDFDocument from "pdfkit";

type PdfDoc = InstanceType<typeof PDFDocument>;
import type {
  academicReportSummary,
  attendanceReportSummary,
  financeReportSummary,
} from "./report-data";

type AcademicSummary = Awaited<ReturnType<typeof academicReportSummary>>;
type AttendanceSummary = Awaited<ReturnType<typeof attendanceReportSummary>>;
type FinanceSummary = Awaited<ReturnType<typeof financeReportSummary>>;

function pdfToBuffer(build: (doc: PdfDoc) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

export function academicSummaryToPdf(
  data: AcademicSummary,
  schoolName: string,
): Promise<Buffer> {
  return pdfToBuffer((doc) => {
    doc.fontSize(16).text(schoolName, { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(12).text("Examination summary report");
    doc.moveDown();
    for (const row of data.examinations.slice(0, 40)) {
      doc
        .fontSize(10)
        .text(
          `${row.name} · ${row.className} · ${row.academicYear} (${row.term}) — marks: ${row.marksRecorded}, avg: ${row.averageScore?.toFixed(1) ?? "n/a"}`,
        );
    }
  });
}

export function attendanceSummaryToPdf(
  data: AttendanceSummary,
  schoolName: string,
): Promise<Buffer> {
  return pdfToBuffer((doc) => {
    doc.fontSize(16).text(schoolName, { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(12).text("Attendance totals by status");
    doc.moveDown();
    for (const [status, count] of Object.entries(data.totals)) {
      doc.fontSize(11).text(`${status}: ${count}`);
    }
    doc.moveDown(0.5);
    doc.text(`Total records: ${data.totalRecords}`);
  });
}

export function financeSummaryToPdf(
  data: FinanceSummary,
  schoolName: string,
): Promise<Buffer> {
  return pdfToBuffer((doc) => {
    doc.fontSize(16).text(schoolName, { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(12).text("Financial summary");
    doc.moveDown(0.5);
    doc.fontSize(10).text(
      `Invoices: ${data.summary.invoiceCount} · Billed: ${data.summary.billed.toFixed(2)} · Collected: ${data.summary.collected.toFixed(2)} · Outstanding: ${data.summary.outstanding.toFixed(2)}`,
    );
    doc.moveDown();
    for (const inv of data.invoices.slice(0, 50)) {
      doc.text(
        `${inv.invoiceNo} · ${inv.studentName} · ${inv.status} · balance ${inv.balance.toFixed(2)}`,
      );
    }
  });
}
