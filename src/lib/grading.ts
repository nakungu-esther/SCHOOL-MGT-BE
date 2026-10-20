import { prisma } from "./prisma";

export type Band = {
  label: string;
  minPercent: number;
  maxPercent: number;
  sortOrder: number;
};

export const DEFAULT_BANDS: Band[] = [
  { label: "A", minPercent: 80, maxPercent: 100, sortOrder: 1 },
  { label: "B", minPercent: 70, maxPercent: 79.99, sortOrder: 2 },
  { label: "C", minPercent: 60, maxPercent: 69.99, sortOrder: 3 },
  { label: "D", minPercent: 50, maxPercent: 59.99, sortOrder: 4 },
  { label: "F", minPercent: 0, maxPercent: 49.99, sortOrder: 5 },
];

export async function getGradeBands(schoolId: string): Promise<Band[]> {
  const rows = await prisma.gradeBand.findMany({
    where: { schoolId },
    orderBy: { sortOrder: "asc" },
  });
  if (rows.length === 0) {
    return DEFAULT_BANDS;
  }
  return rows.map((r) => ({
    label: r.label,
    minPercent: r.minPercent,
    maxPercent: r.maxPercent,
    sortOrder: r.sortOrder,
  }));
}

export function gradeLabelForPercent(percent: number, bands: Band[]): string {
  const match = bands.find(
    (b) => percent >= b.minPercent && percent <= b.maxPercent,
  );
  return match?.label ?? "—";
}
