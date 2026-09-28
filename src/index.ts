import { app } from "./app.js";
import { config } from "./config.js";
import { ensureBucket } from "./storage.js";

await ensureBucket();
app.listen(config.PORT, config.HOST, () => console.log(`bmw-reader listening on http://${config.HOST}:${config.PORT}`));
