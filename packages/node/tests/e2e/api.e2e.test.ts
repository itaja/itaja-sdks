/**
 * End to end against a real Itaja developer API (sandbox key). Declare a
 * catalogue, push it, push it again, change a price, use what was pushed by
 * its name — and leave a walk a later run is compared with.
 *
 * Runs only when ITAJA_E2E_API_KEY (an `itjs_` key, never live) and
 * ITAJA_E2E_API_URL are set; skipped otherwise.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * E1. The API refuses the document the SDK builds (422 CATALOG_INVALID).
 * E2. A second identical push is not all `unchanged` — the SDK's document is
 *     not stable, or the diff sees phantom changes.
 * E3. A price change does not version the plan, or archives it.
 * E4. A product referenced by its name is not found after a push.
 * E5. A write the SDK retries under its key runs twice, or the same key over
 *     another body is not refused.
 * E6. An API error reaches the caller as something else than a typed
 *     ItajaError carrying the API's code.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ItajaNotFoundError,
  ItajaPermissionError,
  createItaja,
  creditPack,
  credits,
  feature,
  group,
  license,
  plan,
} from "../../src/index.js";

const apiKey = process.env.ITAJA_E2E_API_KEY ?? "";
const baseUrl = process.env.ITAJA_E2E_API_URL ?? "";
const enabled = apiKey.startsWith("itjs_") && baseUrl !== "";

/** Names unique to this run, so runs never collide on a shared sandbox. */
const RUN = process.env.ITAJA_E2E_RUN ?? Date.now().toString(36);
const named = (name: string) => `${name}-${RUN}`;

function declare(proPrice: number) {
  const messages = feature({ name: named("messages"), type: "metered" });
  const app = group({ name: named("app") });
  const free = plan({ name: "Free", group: app, default: true, includes: [messages({ limit: 100, reset: "month" })] });
  const pro = plan({
    name: "Pro",
    group: app,
    price: { amount: proPrice, currency: "XOF", interval: "month" },
    includes: [messages({ limit: 2000, reset: "month" })],
  });
  const tokens = credits({ name: named("tokens"), coinName: "Tokens" });
  const small = creditPack({ name: "100 Tokens", of: tokens, credits: 100, price: { amount: 1000, currency: "XOF" } });
  const ebook = license({ name: named("ebook"), devices: null, price: { amount: 3000, currency: "XOF" } });
  return [messages, free, pro, small, ebook] as const;
}

interface Step {
  step: string;
  [k: string]: unknown;
}
const walk: Step[] = [];
/** Strip the run suffix so a later run produces the same walk. */
const norm = (value: string | null) => (value === null ? null : value.replace(`-${RUN}`, "-<run>"));

describe.skipIf(!enabled)("itaja-node against a real developer API", () => {
  it("E1/E2/E3 — push, push again, change a price", async () => {
    const first = createItaja({ apiKey, baseUrl, catalog: declare(5000) });
    expect(first.mode).toBe("sandbox");

    const dry = await first.push({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.summary.created).toBeGreaterThan(0);

    const created = await first.push();
    const mine = (r: typeof created) =>
      r.changes
        .filter((c) => (c.product ?? c.key).endsWith(RUN))
        .map((c) => ({ kind: c.kind, key: norm(c.key), product: norm(c.product), action: c.action, version: c.version }))
        .sort((a, b) => `${a.kind}${a.product}${a.key}`.localeCompare(`${b.kind}${b.product}${b.key}`));
    walk.push({ step: "first push", changes: mine(created) });
    expect(mine(created).every((c) => c.action === "created")).toBe(true);

    const again = await first.push();
    walk.push({ step: "same catalogue again", changes: mine(again) });
    expect(mine(again).every((c) => c.action === "unchanged")).toBe(true);

    const repriced = await createItaja({ apiKey, baseUrl, catalog: declare(6000) }).push();
    walk.push({ step: "pro repriced", changes: mine(repriced).filter((c) => c.action !== "unchanged") });
    const pro = mine(repriced).find((c) => c.kind === "plan" && c.key?.toLowerCase() === "pro");
    expect(pro).toMatchObject({ action: "changed", version: 2 });
  });

  it("E4/E5 — products are used by their name; a keyed retry is one write", async () => {
    const itaja = createItaja({ apiKey, baseUrl, catalog: declare(6000) });
    const packs = await itaja.credits.packs({ product: ` ${named("TOKENS")} ` });
    walk.push({ step: "packs of the pushed credits", packs: packs.packs.map((p) => ({ label: p.label, coins: p.coins, amount: p.amount, currency: p.currency })) });
    expect(packs.packs).toHaveLength(1);

    // The SDK's own retry reuses its key: the API replays the first answer.
    const key = `sdk-e2e-push-${RUN}`;
    const a = await itaja.push({ idempotencyKey: key });
    const b = await itaja.push({ idempotencyKey: key });
    expect(b).toEqual(a);
    // The same key over another catalogue is refused, nothing written.
    const reused = await createItaja({ apiKey, baseUrl, catalog: declare(7000) })
      .push({ idempotencyKey: key })
      .catch((e: unknown) => e);
    expect(reused).toMatchObject({ status: 422, code: "IDEMPOTENCY_KEY_REUSED" });
    walk.push({ step: "push replayed under one key, then reused on another catalogue", replayEqual: true, reused: (reused as { code: string }).code });
  });

  it("E6 — API refusals arrive typed with the API's code", async () => {
    // Today `/customers` takes only a product-scoped key, and `/catalog` only an
    // account key: an account key reading a customer is refused (403).
    const itaja = createItaja({ apiKey, baseUrl });
    const scoped = await itaja.customers.get(`nobody-${RUN}`).catch((e: unknown) => e);
    expect(scoped).toBeInstanceOf(ItajaPermissionError);
    walk.push({ step: "customer read with an account key", error: (scoped as ItajaPermissionError).name, status: (scoped as ItajaPermissionError).status, code: (scoped as ItajaPermissionError).code });

    const missing = await itaja.subscriptions.get(`nobody-${RUN}`).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ItajaNotFoundError);
    walk.push({ step: "unknown subscription", error: (missing as ItajaNotFoundError).name, status: (missing as ItajaNotFoundError).status, code: (missing as ItajaNotFoundError).code });

    const unknownProduct = await createItaja({ apiKey, baseUrl, catalog: declare(6000) })
      .credits.balance({ product: "never-pushed" as never, customerId: "x" })
      .catch((e: unknown) => e);
    expect(unknownProduct).toMatchObject({ code: "CATALOG_PRODUCT_NOT_PUSHED" });
    walk.push({ step: "product never pushed", code: (unknownProduct as ItajaNotFoundError).code });
  });

  it("leaves a walk a later run is compared with", () => {
    const path = new URL("./__fixtures__/catalog-push-walk.json", import.meta.url);
    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(path)) {
      mkdirSync(new URL("./__fixtures__/", import.meta.url), { recursive: true });
      writeFileSync(path, `${JSON.stringify(walk, null, 2)}\n`);
    }
    expect(walk).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });
});
