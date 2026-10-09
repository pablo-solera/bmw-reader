import { createBmwContainer } from "./composition/container.js";

const container = createBmwContainer();
await container.objectStorage.ensureBucket();
container.app.listen(container.config.PORT, container.config.HOST, () => console.log(`bmw-reader listening on http://${container.config.HOST}:${container.config.PORT}`));
