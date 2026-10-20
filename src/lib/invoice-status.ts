import type { InvoiceStatus } from "@prisma/client";
import { prisma } from "./prisma";

export async function refreshInvoiceTotals(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;

  const agg = await prisma.invoicePayment.aggregate({
    where: { invoiceId },
    _sum: { amount: true },
  });
  const paid = Number(agg._sum.amount ?? 0);
  const total = Number(invoice.amountTotal);

  let status: InvoiceStatus = "OPEN";
  if (paid <= 0) status = "OPEN";
  else if (paid >= total) status = "PAID";
  else status = "PARTIAL";

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { amountPaid: paid, status },
  });
}
