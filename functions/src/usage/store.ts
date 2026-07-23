import type {
  DocumentData,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";

import type {
  DeadLetter,
  ErrorAggregate,
  PrincipalDailyAggregate,
  OperationState,
  StoredUsageEvent,
  UsageAggregatePointer,
  UsageAggregateSourceRevision,
  UsageDailyAggregate,
  UsageEventReservation,
  UsageStore,
  UsageTransaction,
} from "./types";

const collections = {
  events: "usageEvents",
  eventReservations: "usageEventReservations",
  daily: "toolUsageDaily",
  principal: "principalUsageDaily",
  errors: "errorAggregates",
  deadLetters: "deadLetters",
  operations: "usageOperations",
  pointers: "usageAggregatePointers",
  sourceRevisions: "usageAggregateSourceRevisions",
} as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fromFirestore<T>(value: unknown): T {
  if (Array.isArray(value)) {
    return value.map((item) => fromFirestore(item)) as T;
  }
  if (value && typeof value === "object") {
    const timestamp = value as { toDate?: () => Date };
    if (typeof timestamp.toDate === "function") {
      return timestamp.toDate() as T;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fromFirestore(item)]),
    ) as T;
  }
  return value as T;
}

async function getRecord<T>(
  firestoreTransaction: Transaction,
  firestore: Firestore,
  collection: string,
  id: string,
): Promise<T | undefined> {
  const snapshot = await firestoreTransaction.get(
    firestore.collection(collection).doc(id),
  );
  const data: DocumentData | undefined = snapshot.data();
  return data ? fromFirestore<T>(data) : undefined;
}

export class FirestoreUsageStore implements UsageStore {
  public constructor(
    private readonly firestore: Firestore,
    private readonly hooks: { onCommittedWrites?: (count: number) => Promise<void> } = {},
  ) {}

  public async runTransaction<T>(
    handler: (transaction: UsageTransaction) => Promise<T>,
  ): Promise<T> {
    let committedWrites = 0;
    const result = await this.firestore.runTransaction(async (firestoreTransaction) => {
      let attemptedWrites = 0;
      const transaction: UsageTransaction = {
        getUsageEvent: (eventId) =>
          getRecord<StoredUsageEvent>(
            firestoreTransaction,
            this.firestore,
            collections.events,
            eventId,
          ),
        putUsageEvent: async (value) => {
          attemptedWrites += 1;
          firestoreTransaction.create(
            this.firestore.collection(collections.events).doc(value.event_id),
            value,
          );
        },
        getEventReservation: (eventId) =>
          getRecord<UsageEventReservation>(
            firestoreTransaction,
            this.firestore,
            collections.eventReservations,
            eventId,
          ),
        putEventReservation: async (value) => {
          attemptedWrites += 1;
          firestoreTransaction.create(
            this.firestore.collection(collections.eventReservations).doc(value.event_id),
            value,
          );
        },
        deleteEventReservation: async (eventId) => {
          attemptedWrites += 1;
          firestoreTransaction.delete(this.firestore.collection(collections.eventReservations).doc(eventId));
        },
        getDailyAggregate: (id) =>
          getRecord<UsageDailyAggregate>(
            firestoreTransaction,
            this.firestore,
            collections.daily,
            id,
          ),
        putDailyAggregate: async (value) => {
          attemptedWrites += 1;
          firestoreTransaction.set(
            this.firestore.collection(collections.daily).doc(value.id),
            value,
          );
        },
        getPrincipalAggregate: (id) =>
          getRecord<PrincipalDailyAggregate>(
            firestoreTransaction,
            this.firestore,
            collections.principal,
            id,
          ),
        putPrincipalAggregate: async (value) => {
          attemptedWrites += 1;
          firestoreTransaction.set(
            this.firestore.collection(collections.principal).doc(value.id),
            value,
          );
        },
        getErrorAggregate: (id) =>
          getRecord<ErrorAggregate>(
            firestoreTransaction,
            this.firestore,
            collections.errors,
            id,
          ),
        putErrorAggregate: async (value) => {
          attemptedWrites += 1;
          firestoreTransaction.set(
            this.firestore.collection(collections.errors).doc(value.id),
            value,
          );
        },
        getOperation: (id) =>
          getRecord<OperationState>(firestoreTransaction, this.firestore, collections.operations, id),
        putOperation: async (value) => {
          attemptedWrites += 1;
          firestoreTransaction.set(this.firestore.collection(collections.operations).doc(value.id), value);
        },
        getDeadLetter: (id) =>
          getRecord<DeadLetter>(firestoreTransaction, this.firestore, collections.deadLetters, id),
        putDeadLetter: async (value) => {
          attemptedWrites += 1;
          firestoreTransaction.set(
            this.firestore.collection(collections.deadLetters).doc(value.id),
            value,
          );
        },
        getAggregatePointer: (id) =>
          getRecord<UsageAggregatePointer>(
            firestoreTransaction,
            this.firestore,
            collections.pointers,
            id,
          ),
        putAggregatePointer: async (value) => {
          attemptedWrites += 1;
          firestoreTransaction.set(
            this.firestore.collection(collections.pointers).doc(value.id),
            value,
          );
        },
        getAggregateSourceRevision: (date) =>
          getRecord<UsageAggregateSourceRevision>(
            firestoreTransaction,
            this.firestore,
            collections.sourceRevisions,
            date,
          ),
        putAggregateSourceRevision: async (value) => {
          attemptedWrites += 1;
          firestoreTransaction.set(
            this.firestore.collection(collections.sourceRevisions).doc(value.date),
            value,
          );
        },
      };
      const transactionResult = await handler(transaction);
      committedWrites = attemptedWrites;
      return transactionResult;
    });
    if (committedWrites > 0 && this.hooks.onCommittedWrites) {
      try {
        await this.hooks.onCommittedWrites(committedWrites);
      } catch {
        // Monitoring failure cannot roll back or relabel an already committed event.
      }
    }
    return result;
  }
}

export class InMemoryUsageStore implements UsageStore {
  private readonly events = new Map<string, StoredUsageEvent>();
  private readonly eventReservations = new Map<string, UsageEventReservation>();
  private readonly daily = new Map<string, UsageDailyAggregate>();
  private readonly principal = new Map<string, PrincipalDailyAggregate>();
  private readonly errors = new Map<string, ErrorAggregate>();
  private readonly deadLetters = new Map<string, DeadLetter>();
  private readonly operations = new Map<string, OperationState>();
  private readonly pointers = new Map<string, UsageAggregatePointer>();
  private readonly sourceRevisions = new Map<string, UsageAggregateSourceRevision>();
  private transactionTail: Promise<void> = Promise.resolve();

  public async runTransaction<T>(
    handler: (transaction: UsageTransaction) => Promise<T>,
  ): Promise<T> {
    let release: () => void = () => undefined;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = {
      events: clone(this.events),
      eventReservations: clone(this.eventReservations),
      daily: clone(this.daily),
      principal: clone(this.principal),
      errors: clone(this.errors),
      deadLetters: clone(this.deadLetters),
      operations: clone(this.operations),
      pointers: clone(this.pointers),
      sourceRevisions: clone(this.sourceRevisions),
    };
    try {
      const transaction: UsageTransaction = {
        getUsageEvent: async (id) => {
          const value = this.events.get(id);
          return value ? clone(value) : undefined;
        },
        putUsageEvent: async (value) => {
          if (this.events.has(value.event_id)) {
            throw new Error("duplicate event id");
          }
          this.events.set(value.event_id, clone(value));
        },
        getEventReservation: async (eventId) => {
          const value = this.eventReservations.get(eventId);
          return value ? clone(value) : undefined;
        },
        putEventReservation: async (value) => {
          if (this.eventReservations.has(value.event_id)) throw new Error("duplicate event reservation");
          this.eventReservations.set(value.event_id, clone(value));
        },
        deleteEventReservation: async (eventId) => {
          this.eventReservations.delete(eventId);
        },
        getDailyAggregate: async (id) => {
          const value = this.daily.get(id);
          return value ? clone(value) : undefined;
        },
        putDailyAggregate: async (value) => {
          this.daily.set(value.id, clone(value));
        },
        getPrincipalAggregate: async (id) => {
          const value = this.principal.get(id);
          return value ? clone(value) : undefined;
        },
        putPrincipalAggregate: async (value) => {
          this.principal.set(value.id, clone(value));
        },
        getErrorAggregate: async (id) => {
          const value = this.errors.get(id);
          return value ? clone(value) : undefined;
        },
        putErrorAggregate: async (value) => {
          this.errors.set(value.id, clone(value));
        },
        getOperation: async (id) => {
          const value = this.operations.get(id);
          return value ? clone(value) : undefined;
        },
        putOperation: async (value) => {
          this.operations.set(value.id, clone(value));
        },
        getDeadLetter: async (id) => {
          const value = this.deadLetters.get(id);
          return value ? clone(value) : undefined;
        },
        putDeadLetter: async (value) => {
          this.deadLetters.set(value.id, clone(value));
        },
        getAggregatePointer: async (id) => {
          const value = this.pointers.get(id);
          return value ? clone(value) : undefined;
        },
        putAggregatePointer: async (value) => {
          this.pointers.set(value.id, clone(value));
        },
        getAggregateSourceRevision: async (date) => {
          const value = this.sourceRevisions.get(date);
          return value ? clone(value) : undefined;
        },
        putAggregateSourceRevision: async (value) => {
          this.sourceRevisions.set(value.date, clone(value));
        },
      };
      return await handler(transaction);
    } catch (error) {
      this.events.clear();
      this.eventReservations.clear();
      this.daily.clear();
      this.principal.clear();
      this.errors.clear();
      this.deadLetters.clear();
      this.operations.clear();
      this.pointers.clear();
      this.sourceRevisions.clear();
      for (const [id, value] of snapshot.events) this.events.set(id, value);
      for (const [id, value] of snapshot.eventReservations) this.eventReservations.set(id, value);
      for (const [id, value] of snapshot.daily) this.daily.set(id, value);
      for (const [id, value] of snapshot.principal) this.principal.set(id, value);
      for (const [id, value] of snapshot.errors) this.errors.set(id, value);
      for (const [id, value] of snapshot.deadLetters) this.deadLetters.set(id, value);
      for (const [id, value] of snapshot.operations) this.operations.set(id, value);
      for (const [id, value] of snapshot.pointers) this.pointers.set(id, value);
      for (const [id, value] of snapshot.sourceRevisions) this.sourceRevisions.set(id, value);
      throw error;
    } finally {
      release();
    }
  }

  public exportForTest() {
    return {
      events: clone([...this.events.values()]),
      eventReservations: clone([...this.eventReservations.values()]),
      daily: clone([...this.daily.values()]),
      principal: clone([...this.principal.values()]),
      errors: clone([...this.errors.values()]),
      deadLetters: clone([...this.deadLetters.values()]),
      operations: clone([...this.operations.values()]),
      pointers: clone([...this.pointers.values()]),
      sourceRevisions: clone([...this.sourceRevisions.values()]),
    };
  }
}
