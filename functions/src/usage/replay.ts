import { aggregateEvent } from "./aggregation";
import type {
  DeadLetter,
  ErrorAggregate,
  PrincipalDailyAggregate,
  StoredUsageEvent,
  UsageDailyAggregate,
  UsageTransaction,
} from "./types";

export interface ReplayWatermark {
  server_received_at: string;
  event_id: string;
}

export interface ReplayResult {
  replay_id: string;
  generation: string;
  status: "switched";
  started_at: string;
  completed_at: string;
  watermark: ReplayWatermark | null;
  processed: number;
  late_arrivals: number;
  source_count: number;
  shadow_count: number;
  comparison: {
    run_started: number;
    event_count: number;
    error_count: number;
  };
  previous_generation: string | null;
}

function beforeOrEqual(event: StoredUsageEvent, watermark: ReplayWatermark): boolean {
  return event.server_received_at < watermark.server_received_at || (event.server_received_at === watermark.server_received_at && event.event_id <= watermark.event_id);
}

function compareWatermark(left: ReplayWatermark, right: ReplayWatermark): number {
  if (left.server_received_at !== right.server_received_at) return left.server_received_at < right.server_received_at ? -1 : 1;
  return left.event_id < right.event_id ? -1 : left.event_id === right.event_id ? 0 : 1;
}

class AggregateMemory {
  readonly daily = new Map<string, UsageDailyAggregate>();
  readonly principal = new Map<string, PrincipalDailyAggregate>();
  readonly errors = new Map<string, ErrorAggregate>();
  readonly events = new Set<string>();

  transaction(): UsageTransaction {
    return {
      getUsageEvent: async (eventId) => (this.events.has(eventId) ? ({ event_id: eventId } as StoredUsageEvent) : undefined),
      putUsageEvent: async (event) => { this.events.add(event.event_id); },
      getEventReservation: async () => undefined,
      putEventReservation: async () => undefined,
      deleteEventReservation: async () => undefined,
      getDailyAggregate: async (id) => this.daily.get(id),
      putDailyAggregate: async (value) => { this.daily.set(value.id, value); },
      getPrincipalAggregate: async (id) => this.principal.get(id),
      putPrincipalAggregate: async (value) => { this.principal.set(value.id, value); },
      getErrorAggregate: async (id) => this.errors.get(id),
      putErrorAggregate: async (value) => { this.errors.set(value.id, value); },
      getOperation: async () => undefined,
      putOperation: async () => undefined,
      getDeadLetter: async () => undefined,
      putDeadLetter: async (_value: DeadLetter) => undefined,
      getAggregatePointer: async () => undefined,
      putAggregatePointer: async () => undefined,
      getAggregateSourceRevision: async () => undefined,
      putAggregateSourceRevision: async () => undefined,
    };
  }
}

export async function rebuildAggregates(events: StoredUsageEvent[], generation: string): Promise<AggregateMemory> {
  const target = new AggregateMemory();
  const ordered = [...events].sort((left, right) => left.server_received_at.localeCompare(right.server_received_at) || left.event_id.localeCompare(right.event_id));
  for (const event of ordered) {
    if (target.events.has(event.event_id)) continue;
    await aggregateEvent(target.transaction(), event, generation);
    target.events.add(event.event_id);
  }
  return target;
}

export class ReplayService {
  private currentGeneration = "online";
  private previousGeneration: string | null = null;
  private readonly generations = new Map<string, AggregateMemory>();
  private readonly replayStates = new Map<string, { status: "running" | "switched"; checkpoint: ReplayWatermark | null; processed: number }>();
  private readonly replayAudit: Array<{ replayId: string; action: "started" | "checkpointed" | "switched"; occurredAt: string; checkpoint: ReplayWatermark | null }> = [];

  public constructor(private readonly source: { listEvents(): Promise<StoredUsageEvent[]> }) {}

  public get activeGeneration(): string {
    return this.currentGeneration;
  }

  public getGeneration(generation: string): AggregateMemory | undefined {
    return this.generations.get(generation);
  }

  public getReplayState(replayId: string) {
    return this.replayStates.get(replayId);
  }

  public getReplayAudit(replayId: string) {
    return this.replayAudit.filter((record) => record.replayId === replayId);
  }

  public async rebuild(input: {
    replayId: string;
    generation: string;
    from: Date;
    to: Date;
    now: Date;
  }): Promise<ReplayResult> {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.generation)) throw new Error("invalid replay generation");
    const startedAt = input.now.toISOString();
    this.replayStates.set(input.replayId, { status: "running", checkpoint: null, processed: 0 });
    this.replayAudit.push({ replayId: input.replayId, action: "started", occurredAt: startedAt, checkpoint: null });
    const initial = (await this.source.listEvents()).filter((event) => {
      const at = Date.parse(event.server_received_at);
      return at >= input.from.getTime() && at <= input.to.getTime();
    });
    const ordered = [...initial].sort((left, right) => left.server_received_at.localeCompare(right.server_received_at) || left.event_id.localeCompare(right.event_id));
    const watermark = ordered.length ? { server_received_at: ordered[ordered.length - 1].server_received_at, event_id: ordered[ordered.length - 1].event_id } : null;
    const shadowEvents = watermark ? ordered.filter((event) => beforeOrEqual(event, watermark)) : [];
    const first = await rebuildAggregates(shadowEvents, input.generation);
    this.replayStates.set(input.replayId, { status: "running", checkpoint: watermark, processed: first.events.size });
    this.replayAudit.push({ replayId: input.replayId, action: "checkpointed", occurredAt: input.now.toISOString(), checkpoint: watermark });
    const during = (await this.source.listEvents()).filter((event) => {
      const at = Date.parse(event.server_received_at);
      return at >= input.from.getTime() && at <= input.to.getTime() && (!watermark || compareWatermark({ server_received_at: event.server_received_at, event_id: event.event_id }, watermark) > 0);
    });
    let lateArrivals = 0;
    for (const event of during) {
      if (first.events.has(event.event_id)) continue;
      lateArrivals += 1;
      await aggregateEvent(first.transaction(), event, input.generation);
      first.events.add(event.event_id);
    }
    const finalSource = [...new Set([...shadowEvents, ...during].map((event) => event.event_id))];
    const comparison = {
      run_started: [...first.daily.values()].reduce((sum, value) => sum + value.run_started, 0),
      event_count: [...first.daily.values()].reduce((sum, value) => sum + value.event_count, 0),
      error_count: [...first.errors.values()].reduce((sum, value) => sum + value.count, 0),
    };
    this.previousGeneration = this.currentGeneration;
    this.generations.set(input.generation, first);
    this.currentGeneration = input.generation;
    this.replayStates.set(input.replayId, { status: "switched", checkpoint: watermark, processed: first.events.size });
    this.replayAudit.push({ replayId: input.replayId, action: "switched", occurredAt: input.now.toISOString(), checkpoint: watermark });
    return {
      replay_id: input.replayId,
      generation: input.generation,
      status: "switched",
      started_at: startedAt,
      completed_at: input.now.toISOString(),
      watermark,
      processed: finalSource.length,
      late_arrivals: lateArrivals,
      source_count: initial.length + during.filter((event) => !initial.some((item) => item.event_id === event.event_id)).length,
      shadow_count: first.events.size,
      comparison,
      previous_generation: this.previousGeneration,
    };
  }
}
