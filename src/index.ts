import { app } from "./app.js";
import { config } from "./config.js";
import { ensureBucket } from "./storage.js";

await ensureBucket();
app.listen(config.port, "127.0.0.1", () => console.log(`bmw-reader listening on http://127.0.0.1:${config.port}`));
