import { resolveModelSeries } from "./series.js";
import type { LabourInput } from "./types.js";
import { ValidationError } from "reader-core/domain/errors";

function validatePathSegment(field: string, value: string) {
  if (!/^[A-Za-z0-9 _.'-]+$/.test(value) || value === "." || value === "..") throw new ValidationError(`${field} contains invalid path characters`);
}

export function baseExtractionDate(yyyymmdd: string) {
  if (!/^\d{8}$/.test(yyyymmdd)) throw new ValidationError("date must use YYYYMMDD");
  const value = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8))));
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10).replace(/-/g, "") !== yyyymmdd) throw new ValidationError("Invalid calendar date");
  return value;
}

export function validateLabourInput(input: LabourInput): LabourInput {
  if (input.manufacturer !== "BMW" && input.manufacturer !== "MINI") throw new ValidationError("manufacturer must be BMW or MINI");
  validatePathSegment("manufacturer", input.manufacturer);
  if (input.model) validatePathSegment("model", input.model);
  if (input.axCode && !/^[A-Za-z0-9_]+$/.test(input.axCode)) throw new ValidationError("axCode may only contain letters, digits and underscores");
  if (input.edition && !/^[A-Za-z0-9_]+$/.test(input.edition)) throw new ValidationError("edition may only contain letters, digits and underscores");
  baseExtractionDate(input.date);
  if (!input.typekeys.length || input.typekeys.some(item => !/^[A-Z0-9]{4}$/.test(item.typekey) || !/^[A-Z0-9]+$/.test(item.family) || ((item.model ?? input.model) !== undefined && !/^[A-Za-z0-9 _.'-]+$/.test((item.model ?? input.model)!)))) throw new ValidationError("Invalid labour typekeys/families/models");
  const entries = input.typekeys.map(entry => ({ ...entry, series: resolveModelSeries(entry.series, input.series) }));
  if (new Set(entries.map(item => item.typekey)).size !== entries.length) throw new ValidationError("Labour typekeys must be unique");
  return { ...input, typekeys: entries };
}
