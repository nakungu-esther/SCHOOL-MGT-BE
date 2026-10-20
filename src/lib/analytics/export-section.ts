import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

export function sectionToCsv(
  title: string,
  kpis: { label: string; displayValue: string }[],
  tableHeaders: string[],
  tableRows: (string | number)[][],
): string {
  const escape = (v: string | number) => {
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [title, "", "KPI,Value", ...kpis.map((k) => `${escape(k.label)},${escape(k.displayValue)}`), ""];
  if (tableHeaders.length) {
    lines.push(tableHeaders.map(escape).join(","));
    for (const row of tableRows) {
      lines.push(row.map(escape).join(","));
    }
  }
  return lines.join("\n");
}

export async function sectionToXlsx(
  schoolName: string,
  title: string,
  kpis: { label: string; displayValue: string }[],
  tableHeaders: string[],
  tableRows: (string | number)[][],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Analytics");
  sheet.addRow([schoolName, title]);
  sheet.addRow([]);
  sheet.addRow(["KPI", "Value"]);
  for (const k of kpis) sheet.addRow([k.label, k.displayValue]);
  sheet.addRow([]);
  if (tableHeaders.length) {
    sheet.addRow(tableHeaders);
    for (const row of tableRows) sheet.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function sectionToPdf(
  schoolName: string,
  title: string,
  kpis: { label: string; displayValue: string }[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(16).text(schoolName);
    doc.fontSize(12).text(title);
    doc.moveDown();
    for (const k of kpis) {
      doc.text(`${k.label}: ${k.displayValue}`);
    }
    doc.end();
  });
}
