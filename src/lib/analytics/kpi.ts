export type KpiTrend = "up" | "down" | "neutral" | null;

export type AnalyticsKpi = {
  key: string;
  label: string;
  definition: string;
  value: number | null;
  displayValue: string;
  previousValue: number | null;
  changePercent: number | null;
  trend: KpiTrend;
  hasComparison: boolean;
};

export function pct(n: number, d: number): number | null {
  if (d <= 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

export function formatPct(v: number | null): string {
  if (v === null) return "—";
  return `${v}%`;
}

export function formatMoney(v: number, currency: string): string {
  return `${currency} ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function kpi(
  key: string,
  label: string,
  definition: string,
  displayValue: string,
  value: number | null = null,
): AnalyticsKpi {
  return {
    key,
    label,
    definition,
    value,
    displayValue,
    previousValue: null,
    changePercent: null,
    trend: null,
    hasComparison: false,
  };
}
