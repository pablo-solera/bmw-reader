import { objectKey, deletePrefix } from "../src/storage.js";
import { ensureBucket } from "../src/storage.js";
import { config } from "../src/config.js";
import { typekeyProgressStore } from "../src/typekey-progress.js";
import { normalizeModelSeries } from "../src/model-series.js";

const [typekey, manufacturer = "BMW", series, family, date, group = "BMW"] = process.argv.slice(2);
if (!typekey || !series || !family || !date) throw new Error("Usage: bun scripts/clean-test-extraction.ts <typekey> <manufacturer> <series> <family> <YYYYMMDD> [group]");
if (!/^[A-Z0-9]{4}$/.test(typekey) || !/^\d{8}$/.test(date)) throw new Error("Invalid typekey or date format");
for (const value of [manufacturer, series, family]) if (!/^[A-Za-z0-9 _.-]+$/.test(value.replace(/'/g, "")) || value === "." || value === "..") throw new Error("Invalid path segment");

await ensureBucket();
const normalizedSeries = normalizeModelSeries(series);
const typekeyPrefix = objectKey(group, manufacturer, "labour", normalizedSeries, family, date, typekey);
const typekeyObjects = await deletePrefix(typekeyPrefix);
await typekeyProgressStore.clear([group, manufacturer, "labour", normalizedSeries, family, date, typekey].join("/"));
console.log(JSON.stringify({ deletedTypekeyObjects: typekeyObjects, progressKeysCleared: true, prefix: typekeyPrefix, bucket: config.S3_BUCKET }, null, 2));
