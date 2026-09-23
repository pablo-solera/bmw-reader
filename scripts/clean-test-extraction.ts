import { objectKey, deletePrefix } from "../src/storage.js";
import { ensureBucket } from "../src/storage.js";
import { config } from "../src/config.js";

const [typekey, manufacturer = "BMW", model, family, date, group = "BMW"] = process.argv.slice(2);
if (!typekey || !model || !family || !date) throw new Error("Usage: bun scripts/clean-test-extraction.ts <typekey> <manufacturer> <model> <family> <YYYYMMDD> [group]");
if (!/^[A-Z0-9]{4}$/.test(typekey) || !/^\d{8}$/.test(date)) throw new Error("Invalid typekey or date format");
for (const value of [manufacturer, model, family]) if (!/^[A-Za-z0-9 _.-]+$/.test(value) || value === "." || value === "..") throw new Error("Invalid path segment");

await ensureBucket();
const typekeyPrefix = objectKey(group, manufacturer, "labour", model, family, date, typekey);
const summaryPrefix = objectKey(group, manufacturer, "labour", model, family, date, "structured");
const progressPrefix = objectKey(group, manufacturer, "labour", model, family, date, "_progress", typekey);
for (const prefix of [typekeyPrefix, summaryPrefix, progressPrefix]) {
  if (!prefix.startsWith(`${config.S3_PREFIX}/BMW/${manufacturer}/labour/${model}/${family}/${date}/`)) throw new Error("Refusing deletion: prefix is outside expected BMW extraction date path");
}
const typekeyObjects = await deletePrefix(typekeyPrefix);
const summaryObjects = await deletePrefix(summaryPrefix);
const progressObjects = await deletePrefix(progressPrefix);
console.log(JSON.stringify({ deletedTypekeyObjects: typekeyObjects, deletedSummaryObjects: summaryObjects, deletedProgressObjects: progressObjects, prefixes: [typekeyPrefix, summaryPrefix, progressPrefix] }, null, 2));
