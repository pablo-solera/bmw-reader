import { BmwClient } from "../src/bmw/client.js";
import { catalogItems } from "../src/transform/catalog.js";

const typekey = process.argv[2];
if (!typekey || !/^[A-Z0-9]{4}$/.test(typekey)) throw new Error("Usage: bun scripts/smoke-catalog.ts <4-character-typekey>");
const result = await new BmwClient().catalog(typekey);
const catalog = catalogItems(result);
console.log(JSON.stringify({ typekey, catalogEntries: catalog.length, sample: catalog.slice(0, 2) }, null, 2));
