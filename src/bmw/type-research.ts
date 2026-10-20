export type TypeResearchQuery = {
  brand?: string;
  modelSeries?: string;
  developmentCode?: string;
  filterByType?: string;
  language: string;
};

export function normalizeTypeResearchResponse(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { availableFilters: {}, typekeys: [], raw };
  const response = raw as Record<string, unknown>;
  return {
    availableFilters: response.availableFilters && typeof response.availableFilters === "object" && !Array.isArray(response.availableFilters) ? response.availableFilters : {},
    typekeys: Array.isArray(response.typekeys) ? response.typekeys : [],
    raw,
  };
}
