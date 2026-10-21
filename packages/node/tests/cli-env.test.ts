/**
 * The `itaja` CLI reads `.env` / `.env.local`, so nothing has to be exported.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * V1. `.env` is not read: `itaja push` says "no API key" although `.env` has one.
 * V2. `.env.local` does not override `.env` (a developer's local key is ignored).
 * V3. A file overrides a variable set in the shell or in CI (CI pushes with the
 *     wrong key).
 * V4. `trigger` signs with another secret than the one in `.env`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { constructEvent } from "../src/index.js";

const cli = resolve(__dirname, "../dist/cli.js");
const dist = resolve(__dirname, "../dist/index.js");
let server: Server;
let port = 0;
let dir = "";
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/api/v1")) {
        seen.push(`key=${req.headers["x-itj-key"]}`);
        res.end(JSON.stringify({ success: true, data: { summary: { created: 0, changed: 0, archived: 0, unchanged: 1 }, changes: [] } }));
        return;
      }
      try {
        constructEvent({ payload: body, headers: req.headers as Record<string, string>, secret: "whsec_dotenv" });
        seen.push("webhook=verified");
        res.end("{}");
      } catch {
        seen.push("webhook=refused");
        res.statusCode = 400;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
  dir = mkdtempSync(join(tmpdir(), "itaja-cli-env-"));
  writeFileSync(
    join(dir, "itaja.config.mjs"),
    `import { createItaja, feature, group, plan } from ${JSON.stringify(dist)};
const m = feature({ id: "messages", type: "metered" });
const app = group({ id: "app", name: "App" });
export default createItaja({
  apiKey: process.env.ITAJA_API_KEY,
  webhookSecret: process.env.ITAJA_WEBHOOK_SECRET,
  baseUrl: process.env.ITAJA_API_URL,
  catalog: [m, plan({ name: "Free", group: app, default: true, includes: [m({ limit: 1 })] })],
});
`,
  );
  writeFileSync(join(dir, ".env"), `ITAJA_API_KEY=itjs_from_dotenv\nITAJA_WEBHOOK_SECRET=whsec_dotenv\nITAJA_API_URL=http://127.0.0.1:1/api/v1\n`);
  writeFileSync(join(dir, ".env.local"), `ITAJA_API_URL=http://127.0.0.1:${port}/api/v1\n`);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  return new Promise<void>((done) => server.close(() => done()));
});

// Asynchronous on purpose: the API stub runs in this process and must keep answering.
async function run(args: string[], env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ITAJA_")));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args], { cwd: dir, env: { ...clean, ...env }, timeout: 15_000 });
  return stdout;
}

// Runs against the built CLI (`pnpm build` first; CI builds before testing).
describe.skipIf(!existsSync(cli) || typeof (process as { loadEnvFile?: unknown }).loadEnvFile !== "function")("itaja CLI and .env", () => {
  it("V1 / V2 — the key comes from .env and the URL from .env.local", async () => {
    seen.length = 0;
    expect(await run(["status"])).toContain("in sync");
    expect(seen).toEqual(["key=itjs_from_dotenv"]);
  });

  it("V3 — a variable set in the shell wins over both files", async () => {
    seen.length = 0;
    await run(["status"], { ITAJA_API_KEY: "itjs_from_shell" });
    expect(seen).toEqual(["key=itjs_from_shell"]);
  });

  it("V4 — trigger signs with the .env secret", async () => {
    seen.length = 0;
    await run(["trigger", "checkout.paid", "--url", `http://127.0.0.1:${port}/itaja/webhook`]);
    expect(seen).toEqual(["webhook=verified"]);
  });
});
