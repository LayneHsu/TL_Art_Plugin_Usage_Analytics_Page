import type {
  PluginAuthAuditRecord,
  PluginAuthStore,
  PluginAuthTransaction,
  PluginDeviceBindingRecord,
  PluginPairingRecord,
  PluginPrincipalRecord,
  PluginOpsReviewRecord,
} from "./types";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryPluginAuthStore implements PluginAuthStore {
  private readonly pairings = new Map<string, PluginPairingRecord>();
  private readonly principals = new Map<string, PluginPrincipalRecord>();
  private readonly bindings = new Map<string, PluginDeviceBindingRecord>();
  private readonly audits = new Map<string, PluginAuthAuditRecord>();
  private readonly opsReviews = new Map<string, PluginOpsReviewRecord>();
  private transactionTail: Promise<void> = Promise.resolve();

  public async runTransaction<T>(
    handler: (transaction: PluginAuthTransaction) => Promise<T>,
  ): Promise<T> {
    let release: () => void = () => undefined;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const transaction: PluginAuthTransaction = {
        getPairing: async (id) => {
          const record = this.pairings.get(id);
          return record ? clone(record) : undefined;
        },
        putPairing: async (record) => {
          this.pairings.set(record.pairingId, clone(record));
        },
        getPrincipal: async (id) => {
          const record = this.principals.get(id);
          return record ? clone(record) : undefined;
        },
        putPrincipal: async (record) => {
          this.principals.set(record.principalId, clone(record));
        },
        getBinding: async (id) => {
          const record = this.bindings.get(id);
          return record ? clone(record) : undefined;
        },
        putBinding: async (record) => {
          this.bindings.set(record.bindingId, clone(record));
        },
        getOpsReview: async (id) => {
          const record = this.opsReviews.get(id);
          return record ? clone(record) : undefined;
        },
        putOpsReview: async (record) => {
          this.opsReviews.set(record.reviewId, clone(record));
        },
        putAudit: async (record) => {
          this.audits.set(record.auditId, clone(record));
        },
      };
      return await handler(transaction);
    } finally {
      release();
    }
  }

  public exportForTest() {
    return {
      pairings: clone([...this.pairings.values()]),
      principals: clone([...this.principals.values()]),
      bindings: clone([...this.bindings.values()]),
      audits: clone([...this.audits.values()]),
      opsReviews: clone([...this.opsReviews.values()]),
    };
  }
}
