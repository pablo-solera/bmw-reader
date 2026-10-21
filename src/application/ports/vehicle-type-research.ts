export type TypeResearchQuery = {
  brand?: string;
  modelSeries?: string;
  developmentCode?: string;
  filterByType?: string;
  language: string;
};

export type TypeResearchResult = {
  availableFilters: Record<string, unknown>;
  typekeys: unknown[];
  raw: unknown;
};
