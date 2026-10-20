import type { JobState } from "../../types.js";
import type { LabourListFilters, LabourListItem } from "../../domain/labour/types.js";
import { summarizeLabourList } from "../../domain/labour/policies.js";
import { labourNextCursor, parseLabourCursor } from "../../domain/labour/cursor.js";

export type ListLaboursDependencies = {
  ensureIndex(): Promise<void>;
  cutoff(): number;
  pruneExpired(cutoff: number): Promise<void>;
  fetchRequestIds(cutoff: number, offset: number, count: number): Promise<string[]>;
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
  const start = parseLabourCursor(cursor);
  const cutoff = dependencies.cutoff();
  await dependencies.pruneExpired(cutoff);
  const items: LabourListItem[] = [];
  let hasMore = false;
  let scanned = 0;
  let exhausted = false;
  while (items.length <= count && !exhausted) {
    const batchSize = Math.max(50, count + 1);
    const requestIds = await dependencies.fetchRequestIds(cutoff, start + scanned, batchSize);
    if (requestIds.length < batchSize) exhausted = true;
    if (!requestIds.length) break;
    const states = await dependencies.fetchStates(requestIds);
    const missing = requestIds.filter((_id, index) => states[index] === null);
    if (missing.length) await dependencies.removeMissing(missing);
    let matchingScanned = 0;
    for (const state of states) {
      if (state) items.push(...summarizeLabourList([state], filters));
      matchingScanned++;
      if (items.length > count) break;
    }
    if (items.length > count) {
      scanned += Math.max(0, matchingScanned - 1);
      hasMore = true;
      break;
    }
    scanned += requestIds.length;
  }
  return { items: items.slice(0, count), nextCursor: hasMore ? labourNextCursor(start + scanned) : null };
}
