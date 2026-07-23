import type {
  DocumentData,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";

import type {
  PluginAuthAuditRecord,
  PluginAuthStore,
  PluginAuthTransaction,
  PluginDeviceBindingRecord,
  PluginPairingRecord,
  PluginPrincipalRecord,
  PluginOpsReviewRecord,
} from "./types";

const collections = {
  principals: "pluginPrincipals",
  bindings: "pluginDeviceBindings",
  pairings: "pluginDevicePairings",
  audits: "pluginAuthAudit",
  opsReviews: "pluginOpsReviews",
} as const;

function fromFirestore<T>(value: unknown): T {
  if (Array.isArray(value)) {
    return value.map((item) => fromFirestore(item)) as T;
  }
  if (value && typeof value === "object") {
    const maybeTimestamp = value as { toDate?: () => Date };
    if (typeof maybeTimestamp.toDate === "function") {
      return maybeTimestamp.toDate() as T;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fromFirestore(item)]),
    ) as T;
  }
  return value as T;
}

async function getRecord<T>(
  transaction: Transaction,
  firestore: Firestore,
  collection: string,
  documentId: string,
): Promise<T | undefined> {
  const snapshot = await transaction.get(
    firestore.collection(collection).doc(documentId),
  );
  const data: DocumentData | undefined = snapshot.data();
  return data ? fromFirestore<T>(data) : undefined;
}

export class FirestorePluginAuthStore implements PluginAuthStore {
  public constructor(private readonly firestore: Firestore) {}

  public async runTransaction<T>(
    handler: (transaction: PluginAuthTransaction) => Promise<T>,
  ): Promise<T> {
    return this.firestore.runTransaction(async (firestoreTransaction) => {
      const transaction: PluginAuthTransaction = {
        getPairing: (pairingId) =>
          getRecord<PluginPairingRecord>(
            firestoreTransaction,
            this.firestore,
            collections.pairings,
            pairingId,
          ),
        putPairing: async (record) => {
          firestoreTransaction.set(
            this.firestore.collection(collections.pairings).doc(record.pairingId),
            record,
          );
        },
        getPrincipal: (principalId) =>
          getRecord<PluginPrincipalRecord>(
            firestoreTransaction,
            this.firestore,
            collections.principals,
            principalId,
          ),
        putPrincipal: async (record) => {
          firestoreTransaction.set(
            this.firestore
              .collection(collections.principals)
              .doc(record.principalId),
            record,
          );
        },
        getBinding: (bindingId) =>
          getRecord<PluginDeviceBindingRecord>(
            firestoreTransaction,
            this.firestore,
            collections.bindings,
            bindingId,
          ),
        putBinding: async (record) => {
          firestoreTransaction.set(
            this.firestore.collection(collections.bindings).doc(record.bindingId),
            record,
          );
        },
        getOpsReview: (reviewId) =>
          getRecord<PluginOpsReviewRecord>(
            firestoreTransaction,
            this.firestore,
            collections.opsReviews,
            reviewId,
          ),
        putOpsReview: async (record) => {
          firestoreTransaction.set(
            this.firestore.collection(collections.opsReviews).doc(record.reviewId),
            record,
          );
        },
        putAudit: async (record: PluginAuthAuditRecord) => {
          firestoreTransaction.set(
            this.firestore.collection(collections.audits).doc(record.auditId),
            record,
          );
        },
      };
      return handler(transaction);
    });
  }
}
