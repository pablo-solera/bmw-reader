import type { LabourState } from "../../domain/labour/labour-state.js";
import type { LabourListFilters, LabourListItem } from "../../domain/labour/types.js";
import { labourNextCursor, parseLabourCursor } from "../../domain/labour/cursor.js";

export function summarizeLabourList(states: Array<LabourState | null>, filters: LabourListFilters = {}): LabourListItem[] {
  return states.flatMap(value => {
    if (!value || !value.typekeySummary) return [];
    const axCode = value.typekeySummary.axCode ?? null;
    const edition = value.input?.edition ?? value.typekeySummary.date;
    if (filters.status?.length && !filters.status.includes(value.status)) return [];
    if (filters.axCode !== undefined && axCode !== filters.axCode) return [];
    if (filters.edition !== undefined && edition !== filters.edition) return [];
    if (filters.manufacturer !== undefined && value.input?.manufacturer !== filters.manufacturer) return [];
    return [{
      requestId: value.requestId,
      manufacturer: value.input?.manufacturer ?? "BMW",
      status: value.status,
      stage: value.stage,
      progress: value.progress,
      axCode,
      edition,
      date: value.typekeySummary.date,
      typekeys: value.typekeySummary.typekeys,
      error: ["completed", "cancelled"].includes(value.status) ? null : value.error ?? null,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }];
  }).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export type ListLaboursDependencies = {
  ensureIndex(): Promise<void>;
  cutoff(): number;
  pruneExpired(cutoff: number): Promise<void>;
  fetchRequestIds(cutoff: number, after: { score: number; requestId: string } | null, count: number): Promise<string[]>;
  fetchStates(requestIds: string[]): Promise<Array<LabourState | null>>;
  removeMissing(requestIds: string[]): Promise<void>;
};

export async function listLaboursUseCase(
  filters: LabourListFilters,
  cursor: string | undefined,
  count: number,
  dependencies: ListLaboursDependencies,
): Promise<{ items: LabourListItem[]; nextCursor: string | null }> {
  await dependencies.ensureIndex();
  let after = parseLabourCursor(cursor);
  const cutoff = dependencies.cutoff();
  await dependencies.pruneExpired(cutoff);
  const items: LabourListItem[] = [];
  let hasMore = false;
  let lastScannedPosition = after;
  let continuation: { score: number; requestId: string } | null = null;
  let exhausted = false;
  while (items.length <= count && !exhausted) {
    const batchSize = Math.max(50, count + 1);
    const requestIds = await dependencies.fetchRequestIds(cutoff, after, batchSize);
    if (requestIds.length < batchSize) exhausted = true;
    if (!requestIds.length) break;
    const states = await dependencies.fetchStates(requestIds);
    const missing = requestIds.filter((_id, index) => states[index] === null);
    if (missing.length) await dependencies.removeMissing(missing);
    for (let index = 0; index < requestIds.length; index++) {
      const state = states[index];
      const position = state ? { score: Date.parse(state.createdAt), requestId: requestIds[index]! } : null;
      if (state) {
        const matching = summarizeLabourList([state], filters);
        if (matching.length && items.length === count) {
          hasMore = true;
          continuation = lastScannedPosition;
          break;
        }
        items.push(...matching);
      }
      if (position && Number.isFinite(position.score)) lastScannedPosition = position;
    }
    if (!hasMore) {
      after = lastScannedPosition;
    }
    if (hasMore) break;
  }
  const nextPosition = continuation ?? (hasMore ? after : null);
  return { items, nextCursor: nextPosition ? labourNextCursor(nextPosition) : null };
}
