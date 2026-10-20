import type { JobState } from "../../domain/labour/job-state.js";
import type { LabourListFilters, LabourListItem } from "../../domain/labour/types.js";
import { summarizeLabourList } from "../../domain/labour/policies.js";
import { labourNextCursor, parseLabourCursor } from "../../domain/labour/cursor.js";

export type ListLaboursDependencies = {
  ensureIndex(): Promise<void>;
  cutoff(): number;
  pruneExpired(cutoff: number): Promise<void>;
  fetchRequestIds(cutoff: number, after: { score: number; requestId: string } | null, legacyOffset: number, count: number): Promise<string[]>;
  fetchStates(requestIds: string[]): Promise<Array<JobState | null>>;
  removeMissing(requestIds: string[]): Promise<void>;
};

export async function listLaboursUseCase(
  filters: LabourListFilters,
  cursor: string | undefined,
  count: number,
  dependencies: ListLaboursDependencies,
): Promise<{ items: LabourListItem[]; nextCursor: string | null }> {
  await dependencies.ensureIndex();
  const decodedCursor = parseLabourCursor(cursor);
  let after = decodedCursor.kind === "after" ? { score: decodedCursor.score, requestId: decodedCursor.requestId } : null;
  const legacyOffset = decodedCursor.kind === "offset" ? decodedCursor.offset : 0;
  const cutoff = dependencies.cutoff();
  await dependencies.pruneExpired(cutoff);
  const items: LabourListItem[] = [];
  let hasMore = false;
  let legacyScanned = 0;
  let lastScannedPosition = after;
  let continuation: { score: number; requestId: string } | null = null;
  let exhausted = false;
  while (items.length <= count && !exhausted) {
    const batchSize = Math.max(50, count + 1);
    const requestIds = await dependencies.fetchRequestIds(cutoff, after, after ? 0 : legacyOffset + legacyScanned, batchSize);
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
      if (after) after = lastScannedPosition;
      else legacyScanned += requestIds.length;
    }
    if (hasMore) break;
  }
  const nextPosition = continuation ?? (hasMore ? after : null);
  return { items, nextCursor: nextPosition ? labourNextCursor(nextPosition) : null };
}
