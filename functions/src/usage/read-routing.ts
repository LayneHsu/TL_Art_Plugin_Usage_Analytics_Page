import type { DocumentData, Firestore } from "firebase-admin/firestore";

const POINTER_COLLECTION = "usageAggregatePointers";
const ACTIVE_POINTER_ID = "active";

export interface AggregateGenerationPartition {
  from: string;
  to: string;
  generation: string;
  rollback_generation: string | null;
}

export interface AggregatePointerDocument {
  active_generation: string;
  write_generations: string[];
  rollback_generation: string | null;
  source_revision: number;
  source_watermark: {
    corrected_observed_at: string;
    server_received_at: string;
    event_id: string;
  } | null;
  generation_partitions: AggregateGenerationPartition[];
  updated_at: string;
}

export interface AggregateGenerationSegment {
  from: string;
  to: string;
  generation: string;
}

export class ReplayOperationError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ReplayOperationError";
  }
}

function isWatermark(value: unknown): value is NonNullable<AggregatePointerDocument["source_watermark"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<NonNullable<AggregatePointerDocument["source_watermark"]>>;
  return typeof candidate.corrected_observed_at === "string"
    && typeof candidate.server_received_at === "string"
    && typeof candidate.event_id === "string";
}

export function defaultAggregatePointer(at: string): AggregatePointerDocument {
  return {
    active_generation: "online",
    write_generations: ["online"],
    rollback_generation: null,
    source_revision: 0,
    source_watermark: null,
    generation_partitions: [],
    updated_at: at,
  };
}

export function aggregatePointerFromData(data: DocumentData | undefined, at: string): AggregatePointerDocument {
  if (!data) return defaultAggregatePointer(at);
  const activeGeneration = typeof data.active_generation === "string" && data.active_generation.length > 0
    ? data.active_generation
    : "online";
  return {
    active_generation: activeGeneration,
    write_generations: Array.isArray(data.write_generations)
      ? data.write_generations.filter((item): item is string => typeof item === "string")
      : [activeGeneration],
    rollback_generation: typeof data.rollback_generation === "string" ? data.rollback_generation : null,
    source_revision: Number.isSafeInteger(data.source_revision) && data.source_revision >= 0 ? data.source_revision : 0,
    source_watermark: isWatermark(data.source_watermark) ? data.source_watermark : null,
    generation_partitions: Array.isArray(data.generation_partitions)
      ? data.generation_partitions.filter((item): item is AggregateGenerationPartition => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const value = item as Partial<AggregateGenerationPartition>;
        return typeof value.from === "string" && typeof value.to === "string" && typeof value.generation === "string"
          && (typeof value.rollback_generation === "string" || value.rollback_generation === null);
      })
      : [],
    updated_at: typeof data.updated_at === "string" ? data.updated_at : at,
  };
}

export function resolveAggregateGenerationSegments(
  pointer: AggregatePointerDocument,
  from: Date,
  to: Date,
): AggregateGenerationSegment[] {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new ReplayOperationError("invalid_read_range", "Invalid aggregate read range");
  }
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const matching = pointer.generation_partitions
    .filter((partition) => partition.from < toIso && partition.to > fromIso)
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  const segments: AggregateGenerationSegment[] = [];
  const append = (segment: AggregateGenerationSegment): void => {
    if (segment.from >= segment.to) return;
    const previous = segments[segments.length - 1];
    if (previous && previous.to === segment.from && previous.generation === segment.generation) {
      previous.to = segment.to;
      return;
    }
    segments.push(segment);
  };
  let cursor = fromIso;
  for (const partition of matching) {
    const segmentFrom = partition.from < cursor ? cursor : partition.from;
    const segmentTo = partition.to > toIso ? toIso : partition.to;
    if (segmentFrom > cursor) append({ from: cursor, to: segmentFrom, generation: pointer.active_generation });
    append({ from: segmentFrom, to: segmentTo, generation: partition.generation });
    if (segmentTo > cursor) cursor = segmentTo;
  }
  if (cursor < toIso) append({ from: cursor, to: toIso, generation: pointer.active_generation });
  return segments.length ? segments : [{ from: fromIso, to: toIso, generation: pointer.active_generation }];
}

export class FirestoreAggregateGenerationReader {
  public constructor(private readonly firestore: Firestore) {}

  private async pointer(): Promise<AggregatePointerDocument> {
    const snapshot = await this.firestore.collection(POINTER_COLLECTION).doc(ACTIVE_POINTER_ID).get();
    return aggregatePointerFromData(snapshot.data(), new Date().toISOString());
  }

  public async getActiveGeneration(): Promise<string> {
    return (await this.pointer()).active_generation;
  }

  public async getActiveGenerationsForRange(from: Date, to: Date): Promise<string[]> {
    const segments = await this.getActiveGenerationSegmentsForRange(from, to);
    return [...new Set(segments.map((segment) => segment.generation))];
  }

  public async getActiveGenerationSegmentsForRange(from: Date, to: Date): Promise<AggregateGenerationSegment[]> {
    return resolveAggregateGenerationSegments(await this.pointer(), from, to);
  }
}
