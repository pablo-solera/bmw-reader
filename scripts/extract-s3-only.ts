import { BmwClient } from "../src/bmw/client.js";
import { fetchTypekey } from "../src/bmw/fetch-typekey.js";
import { createLocalRateLimiter } from "../src/bmw/rate-limit.js";
import { ensureBucket, objectKey, putJson } from "../src/storage.js";
import { config, requireBmwCredentials } from "../src/config.js";
import type { ExtractionInput } from "../src/types.js";

const [typekeyArg, manufacturerArg = "BMW", modelArg, familyArg] = process.argv.slice(2);
if (!typekeyArg || !modelArg || !familyArg) {
  throw new Error("Usage: bun scripts/extract-s3-only.ts <typekey> <manufacturer> <model> <family>");
}
if (!/^[A-Z0-9]{4}$/.test(typekeyArg)) throw new Error("typekey must contain exactly four uppercase letters or digits");
for (const [name, value] of Object.entries({ manufacturer: manufacturerArg, model: modelArg, family: familyArg })) {
  if (!/^[A-Za-z0-9 _.-]+$/.test(value) || value === "." || value === "..") throw new Error(`${name} contains invalid path characters`);
}

requireBmwCredentials();
await ensureBucket();
const extractionDate = new Date();
const input: ExtractionInput = {
  manufacturer: manufacturerArg,
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
const summaryKey = objectKey("BMW", manufacturerArg, "labour", modelArg, familyArg, extractionDate.toISOString().slice(0, 10).replace(/-/g, ""), "structured", `${requestId}.json`);
await putJson(summaryKey, {
  requestId,
  mode: "s3-only",
  input: { manufacturer: manufacturerArg, model: modelArg, family: familyArg, typekeys: [typekeyArg], language: config.BMW_API_LANGUAGE },
  result: { typekey: result.typekey, root: result.relativeRoot, hgCount: result.hgs, awSheetOIDCount: result.awSheetOIDs },
  completedAt: new Date().toISOString(),
});
console.log(JSON.stringify({
  status: "completed",
  requestId,
  typekey: typekeyArg,
  hgs: result.hgs,
  awSheetOIDs: result.awSheetOIDs,
  s3Bucket: config.S3_BUCKET,
  s3Prefix: result.relativeRoot,
  summaryKey,
  elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
}));
