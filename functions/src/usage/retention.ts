export interface RetentionRecord {
  id: string;
  collection:
    | "usageEvents"
    | "deadLetters"
    | "pluginAuthAudit"
    | "toolUsageDaily"
    | "principalUsageDaily"
    | "errorAggregates"
    | "usageQuotas"
    | "usageOperations"
    | "usageReplayApprovals"
    | "usageReplayJobs"
    | "usageRetentionRuns"
    | "usageReplayValidationGroups"
    | "usageAggregateSourceRevisions"
    | "usageMonitoringCounters"
    | "usageMonitoringSnapshots"
    | "usageMonitoringNotifications";
  occurredAt: Date;
}

export interface RetentionPolicy {
  rawEventRetentionMs: number;
  deadLetterRetentionMs: number;
  authAuditRetentionMs: number;
  aggregateRetentionMs: number;
  quotaRetentionMs: number;
  operationRetentionMs: number;
  replayMetadataRetentionMs: number;
  retentionRunRetentionMs: number;
  monitoringRetentionMs: number;
  rebuildWindowMs: number;
  lateArrivalAllowanceMs: number;
  batchSize?: number;
}

export interface RetentionAdapter {
  listExpired(collection: RetentionRecord["collection"], before: Date, limit: number): Promise<RetentionRecord[]>;
  deleteBatch(collection: RetentionRecord["collection"], ids: string[]): Promise<void>;
  writeAudit(record: { runId: string; dryRun: boolean; collection: string; ids: string[]; occurredAt: Date }): Promise<void>;
}

// In-memory adapter helper only. Production cleanup uses FirestoreRetentionCleanupService.
export class RetentionCleanupService {
  public constructor(private readonly adapter: RetentionAdapter, private readonly policy: RetentionPolicy) {
    if (policy.rawEventRetentionMs < policy.rebuildWindowMs + policy.lateArrivalAllowanceMs) {
      throw new Error("Raw event retention must cover the rebuild window and late arrivals");
    }
    if (policy.batchSize !== undefined && (!Number.isSafeInteger(policy.batchSize) || policy.batchSize < 1 || policy.batchSize > 500)) {
      throw new Error("Retention batch size must be between 1 and 500");
    }
  }

  public async run(input: { runId: string; now: Date; dryRun: boolean }): Promise<{ dryRun: boolean; candidates: number; deleted: number }> {
    const batchSize = this.policy.batchSize ?? 200;
    const rules: Array<[RetentionRecord["collection"], number]> = [
      ["usageEvents", this.policy.rawEventRetentionMs],
      ["deadLetters", this.policy.deadLetterRetentionMs],
      ["pluginAuthAudit", this.policy.authAuditRetentionMs],
      ["toolUsageDaily", this.policy.aggregateRetentionMs],
      ["principalUsageDaily", this.policy.aggregateRetentionMs],
      ["errorAggregates", this.policy.aggregateRetentionMs],
      ["usageQuotas", this.policy.quotaRetentionMs],
      ["usageOperations", this.policy.operationRetentionMs],
      ["usageReplayApprovals", this.policy.operationRetentionMs],
      ["usageReplayJobs", this.policy.replayMetadataRetentionMs],
      ["usageRetentionRuns", this.policy.retentionRunRetentionMs],
      ["usageAggregateSourceRevisions", this.policy.rawEventRetentionMs],
      ["usageMonitoringCounters", this.policy.monitoringRetentionMs],
      ["usageMonitoringSnapshots", this.policy.monitoringRetentionMs],
      ["usageMonitoringNotifications", this.policy.monitoringRetentionMs],
    ];
    let candidates = 0;
    let deleted = 0;
    for (const [collection, retentionMs] of rules) {
      const records = await this.adapter.listExpired(collection, new Date(input.now.getTime() - retentionMs), batchSize);
      const ids = records.map((record) => record.id);
      candidates += ids.length;
      await this.adapter.writeAudit({ runId: input.runId, dryRun: input.dryRun, collection, ids, occurredAt: input.now });
      if (!input.dryRun && ids.length) {
        await this.adapter.deleteBatch(collection, ids);
        deleted += ids.length;
      }
    }
    return { dryRun: input.dryRun, candidates, deleted };
  }
}
