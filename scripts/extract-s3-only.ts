import { BmwClient } from "../src/bmw/client.js";
import { fetchTypekey } from "../src/bmw/fetch-typekey.js";
import { createLocalRateLimiter } from "../src/bmw/rate-limit.js";
import { ensureBucket } from "../src/storage.js";
import { config, requireBmwCredentials } from "../src/config.js";
import type { ExtractionInput } from "../src/types.js";

const [typekeyArg, manufacturerArg = "BMW", seriesArg, modelArg, familyArg] = process.argv.slice(2);
if (!typekeyArg || !seriesArg || !familyArg) {
  throw new Error("Usage: bun scripts/extract-s3-only.ts <typekey> <manufacturer> <series> [model] <family>");
}
if (!/^[A-Z0-9]{4}$/.test(typekeyArg)) throw new Error("typekey must contain exactly four uppercase letters or digits");
for (const [name, value] of Object.entries({ manufacturer: manufacturerArg, series: seriesArg, ...(modelArg ? { model: modelArg } : {}), family: familyArg })) {
  if (!/^[A-Za-z0-9 _.-]+$/.test(value) || value === "." || value === "..") throw new Error(`${name} contains invalid path characters`);
}

requireBmwCredentials();
await ensureBucket();
const dateIndex = process.argv.indexOf("--date");
const dateArg = dateIndex >= 0 ? process.argv[dateIndex + 1] : undefined;
if (dateArg && !/^\d{8}$/.test(dateArg)) throw new Error("--date must use YYYYMMDD");
const extractionDate = dateArg
  ? new Date(Date.UTC(Number(dateArg.slice(0, 4)), Number(dateArg.slice(4, 6)) - 1, Number(dateArg.slice(6, 8))))
  : new Date();
if (dateArg && extractionDate.toISOString().slice(0, 10).replace(/-/g, "") !== dateArg) throw new Error("--date is not a valid calendar date");
const input: ExtractionInput = {
  manufacturer: manufacturerArg,
  series: seriesArg,
  model: modelArg,
  family: familyArg,
  axCode: "S3ONLY",
  edition: extractionDate.toISOString().slice(0, 10).replace(/-/g, ""),
  typekeys: [typekeyArg],
};
const requestId = crypto.randomUUID();
const startedAt = Date.now();
const resume = process.argv.includes("--resume");
const result = await fetchTypekey(
  new BmwClient(config.BMW_API_LANGUAGE, createLocalRateLimiter()),
  { ...input, group: "BMW" },
  typekeyArg,
  requestId,
  extractionDate,
  progress => console.log(JSON.stringify({ event: "extraction_progress", requestId, ...progress })),
  resume,
);
console.log(JSON.stringify({
  status: "completed",
  requestId,
  typekey: typekeyArg,
  hgs: result.hgs,
  awSheetOIDs: result.awSheetOIDs,
  s3Bucket: config.S3_BUCKET,
  s3Prefix: result.relativeRoot,
  elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
}));
