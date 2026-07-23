export interface UsageMonitoringMetrics {
  aggregateDriftRatio: number;
  permanentRejectRate: number;
  authFailureRate: number;
  leaseRenewFailureRate: number;
  deadLetterGrowthPerHour: number;
  writesPerAcceptedEvent: number;
}

export interface UsageMonitoringThresholds {
  aggregateDriftRatio: number;
  permanentRejectRate: number;
  authFailureRate: number;
  leaseRenewFailureRate: number;
  deadLetterGrowthPerHour: number;
  writesPerAcceptedEvent: number;
  owner: string;
}

export interface UsageAlert {
  code: string;
  value: number;
  threshold: number;
  owner: string;
  severity: "warning" | "critical";
}

export function validateUsageMonitoringThresholds(thresholds: UsageMonitoringThresholds): void {
  const rates: Array<keyof Pick<UsageMonitoringThresholds, "aggregateDriftRatio" | "permanentRejectRate" | "authFailureRate" | "leaseRenewFailureRate">> = [
    "aggregateDriftRatio",
    "permanentRejectRate",
    "authFailureRate",
    "leaseRenewFailureRate",
  ];
  for (const key of rates) {
    const value = thresholds[key];
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid monitoring threshold: ${key}`);
  }
  for (const key of ["deadLetterGrowthPerHour", "writesPerAcceptedEvent"] as const) {
    const value = thresholds[key];
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid monitoring threshold: ${key}`);
  }
  if (typeof thresholds.owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(thresholds.owner)) {
    throw new Error("Invalid monitoring owner");
  }
}

export function evaluateUsageMonitoring(metrics: UsageMonitoringMetrics, thresholds: UsageMonitoringThresholds): UsageAlert[] {
  validateUsageMonitoringThresholds(thresholds);
  const metricRates: Array<keyof Pick<UsageMonitoringMetrics, "aggregateDriftRatio" | "permanentRejectRate" | "authFailureRate" | "leaseRenewFailureRate">> = [
    "aggregateDriftRatio",
    "permanentRejectRate",
    "authFailureRate",
    "leaseRenewFailureRate",
  ];
  for (const key of metricRates) {
    const value = metrics[key];
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid monitoring metric: ${key}`);
  }
  for (const key of ["deadLetterGrowthPerHour", "writesPerAcceptedEvent"] as const) {
    const value = metrics[key];
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid monitoring metric: ${key}`);
  }
  const checks: Array<[string, number, number]> = [
    ["aggregate_drift", metrics.aggregateDriftRatio, thresholds.aggregateDriftRatio],
    ["permanent_reject_rate", metrics.permanentRejectRate, thresholds.permanentRejectRate],
    ["auth_failure_rate", metrics.authFailureRate, thresholds.authFailureRate],
    ["lease_renew_failure_rate", metrics.leaseRenewFailureRate, thresholds.leaseRenewFailureRate],
    ["dead_letter_growth", metrics.deadLetterGrowthPerHour, thresholds.deadLetterGrowthPerHour],
    ["write_cost", metrics.writesPerAcceptedEvent, thresholds.writesPerAcceptedEvent],
  ];
  return checks.filter(([, value, threshold]) => value > threshold).map(([code, value, threshold]) => ({
    code,
    value,
    threshold,
    owner: thresholds.owner,
    severity: value > threshold * 2 ? "critical" : "warning",
  }));
}
