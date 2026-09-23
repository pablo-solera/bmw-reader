import { BmwClient } from "../src/bmw/client.js";
import { createLocalRateLimiter } from "../src/bmw/rate-limit.js";
import { catalogItems } from "../src/transform/catalog.js";

const typekey = process.argv[2];
if (!typekey || !/^[A-Z0-9]{4}$/.test(typekey)) throw new Error("Usage: bun scripts/smoke-catalog.ts <4-character-typekey>");
const result = await new BmwClient(undefined, createLocalRateLimiter()).catalog(typekey);
const catalog = catalogItems(result);
console.log(JSON.stringify({ typekey, catalogEntries: catalog.length, hgCodes: catalog.map(entry => entry.number), sample: catalog.slice(0, 2).map(({ id, number, text }) => ({ id, number, text })) }, null, 2));
