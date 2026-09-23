import { config } from "../src/config.js";
import { loadInitialDirectory, scanInitialDirectory } from "../src/db/carga-inicial.js";

const root = process.argv[2] ?? config.BMW_CARGA_INICIAL_ROOT;
if (!root) throw new Error("Pass cargaInicial root path or set BMW_CARGA_INICIAL_ROOT");
const parsed = await scanInitialDirectory(root);
console.log(JSON.stringify({ root, dryRun: !process.argv.includes("--write"), files: parsed.map(file => ({ kind: file.kind, file: file.file, rows: file.rows.length })) }, null, 2));
if (process.argv.includes("--write")) {
  const result = await loadInitialDirectory(root);
  console.log(JSON.stringify({ result }, null, 2));
}
