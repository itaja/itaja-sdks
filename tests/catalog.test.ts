/**
 * The catalogue in code (ADR 0015 D2) → the canonical document `PUT /v1/catalog`
 * takes.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * C1. The document the SDK builds is refused by the API's own schema
 *     (`spec/catalog.schema.json`, copied from apps/dev-api).
 * C2. The same declaration gives two different documents (order, undefined
 *     keys): `push` reports changes that are not there, and two languages
 *     disagree.
 * C3. A feature included by a plan but not declared is sent anyway — the API
 *     answers 422 at deploy time instead of the developer's editor/CI.
 * C4. Two default plans in a group, a paid plan without a price, a boolean
 *     feature with a limit, a metered one without, credits without a pack, or
 *     a product id used twice are accepted locally.
 * C5. An invalid id passes locally and fails on the server.
 * C6. Typed ids are not inferred: `PlanIdOf` widens to `string`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  ItajaConfigError,
  creditPack,
  credits,
  feature,
  group,
  license,
  offer,
  plan,
  toCatalogDocument,
  type PlanIdOf,
  type CreditsIdOf,
} from "../src/index.js";

const schema = JSON.parse(readFileSync(new URL("../spec/catalog.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
ajv.addFormat("integer", true);
const validate = ajv.compile(schema);

function declare() {
  const messages = feature({ id: "messages", type: "metered" });
  const exportCsv = feature({ id: "export", type: "boolean" });
  const app = group({ id: "app", name: "My App" });
  const free = plan({ id: "free", group: app, default: true, includes: [messages({ limit: 100, reset: "month" })] });
  const pro = plan({
    id: "pro",
    group: app,
    price: { amount: 5000, currency: "XOF", interval: "month" },
    trial: { days: 7 },
    includes: [messages({ limit: 2000, reset: "month" }), exportCsv()],
  });
  const tokens = credits({ id: "tokens", name: "AI tokens", coinName: "Tokens" });
  const small = creditPack({ id: "small", of: tokens, credits: 100, price: { amount: 1000, currency: "XOF" } });
  const desktop = license({ id: "desktop", name: "Desktop app", devices: 3, duration: "days-365", price: { amount: 25000, currency: "XOF" } });
  const ebook = offer({ id: "ebook", name: "The guide", price: { amount: 3000, currency: "XOF" } });
  return [messages, exportCsv, free, pro, small, desktop, ebook] as const;
}

const configError = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ItajaConfigError);
    return (error as Error).message;
  }
  throw new Error("expected an ItajaConfigError");
};

describe("toCatalogDocument", () => {
  it("C1 — the reference declaration validates against the API's schema", () => {
    const doc = toCatalogDocument(declare());
    const ok = validate(doc);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("C1 — it is the document of the API reference's example, field for field", () => {
    expect(toCatalogDocument(declare())).toMatchInlineSnapshot(`
      {
        "features": [
          {
            "id": "messages",
            "type": "metered",
          },
          {
            "id": "export",
            "type": "boolean",
          },
        ],
        "products": [
          {
            "id": "app",
            "name": "My App",
            "plans": [
              {
                "default": true,
                "id": "free",
                "includes": [
                  {
                    "feature": "messages",
                    "limit": 100,
                    "reset": "month",
                  },
                ],
                "name": "Free",
              },
              {
                "id": "pro",
                "includes": [
                  {
                    "feature": "messages",
                    "limit": 2000,
                    "reset": "month",
                  },
                  {
                    "feature": "export",
                  },
                ],
                "name": "Pro",
                "price": {
                  "amount": 5000,
                  "currency": "XOF",
                  "interval": "month",
                },
                "trial": {
                  "days": 7,
                },
              },
            ],
            "type": "subscription",
          },
          {
            "coinName": "Tokens",
            "id": "tokens",
            "name": "AI tokens",
            "packs": [
              {
                "credits": 100,
                "id": "small",
                "label": "100 Tokens",
                "price": {
                  "amount": 1000,
                  "currency": "XOF",
                },
              },
            ],
            "type": "credits",
          },
          {
            "devices": 3,
            "duration": "days-365",
            "id": "desktop",
            "name": "Desktop app",
            "price": {
              "amount": 25000,
              "currency": "XOF",
            },
            "type": "license",
          },
          {
            "id": "ebook",
            "name": "The guide",
            "price": {
              "amount": 3000,
              "currency": "XOF",
            },
            "type": "offer",
          },
        ],
      }
    `);
  });

  it("C2 — the same declaration always serialises to the same bytes", () => {
    expect(JSON.stringify(toCatalogDocument(declare()))).toBe(JSON.stringify(toCatalogDocument(declare())));
    expect(JSON.stringify(toCatalogDocument(declare()))).not.toContain("undefined");
  });

  it("C3 — a plan including an undeclared feature is refused locally", () => {
    const seats = feature({ id: "seats", type: "metered" });
    const p = plan({ id: "team", group: "app", price: { amount: 1, currency: "XOF", interval: "month" }, includes: [seats({ limit: 5 })] });
    expect(configError(() => toCatalogDocument([p]))).toContain('includes feature "seats"');
  });

  it("C4 — every local rule the API would enforce later", () => {
    const m = feature({ id: "m", type: "metered" });
    const b = feature({ id: "b", type: "boolean" });
    expect(configError(() => plan({ id: "paid", group: "g" }))).toContain("no price");
    expect(configError(() => (m as unknown as () => unknown)())).toContain("metered");
    expect(configError(() => (b as unknown as (q: { limit: number }) => unknown)({ limit: 3 }))).toContain("boolean");
    expect(
      configError(() => toCatalogDocument([plan({ id: "a", group: "g", default: true }), plan({ id: "b", group: "g", default: true })])),
    ).toContain("two default plans");
    expect(configError(() => toCatalogDocument([credits({ id: "c", name: "C" })]))).toContain("no pack");
    expect(
      configError(() => toCatalogDocument([offer({ id: "x", name: "X", price: { amount: 1, currency: "XOF" } }), plan({ id: "p", group: "x", default: true })])),
    ).toContain("used twice");
  });

  it("C5 — ids the API would refuse are refused at declaration", () => {
    for (const id of ["", "-lead", "has space", "é", "x".repeat(65)]) {
      expect(configError(() => feature({ id, type: "boolean" }))).toContain("Invalid feature id");
    }
  });

  it("C6 — ids are inferred as literals from the declaration", () => {
    const catalog = declare();
    expectTypeOf<PlanIdOf<typeof catalog>>().toEqualTypeOf<"free" | "pro">();
    expectTypeOf<CreditsIdOf<typeof catalog>>().toEqualTypeOf<"tokens">();
  });
});
