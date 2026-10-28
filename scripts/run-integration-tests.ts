import { spawn } from "node:child_process";

const composeFile = "docker-compose.test.yml";
const composeProject = "bmw-reader-test";
const env = {
  ...process.env,
  BMW_API_CLIENT_ID: "",
  BMW_API_CLIENT_SECRET: "",
  BMW_API_KEY: "",
  REDIS_URL: "redis://127.0.0.1:16379",
  S3_ENDPOINT: "http://127.0.0.1:19000",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY: "bmwtestaccess",
  S3_SECRET_ACCESS_KEY: "bmwtestsecret-only-for-local-tests",
  S3_BUCKET: "bmw-reader-integration",
  S3_PREFIX: "integration-tests",
  S3_FORCE_PATH_STYLE: "true",
  S3_AUTO_CREATE_BUCKET: "true",
};

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}

let result = 1;
try {
  const started = await run("docker", ["compose", "-p", composeProject, "-f", composeFile, "up", "-d", "--wait"]);
  if (started !== 0) throw new Error("Could not start isolated Redis/RustFS test services.");
  result = await run("bun", ["test", "--config=bunfig.integration.toml", "tests/integration"], { env });
} catch (error) {
  console.error(error);
} finally {
  const stopped = await run("docker", ["compose", "-p", composeProject, "-f", composeFile, "down"]);
  if (stopped !== 0) console.error("Could not stop isolated integration-test services.");
}

process.exitCode = result;
