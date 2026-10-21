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
 * C6. Typed ids are not inferred: `PlanNameOf` widens to `string`.
 * C7. A plan is sent with an `id`, or without its name: the API keys plans by
 *     name inside their product (there is no plan id).
 * C8. Two plans whose names differ only by case or spaces are accepted
 *     locally, though the API sees one plan — or the same name in two groups
 *     is refused, though each group is its own namespace.
 * C9. The SDK's document drifts from the cross-language reference
 *     (`spec/conformance/reference-catalog.json`).
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
  plan,
  toCatalogDocument,
  type PlanNameOf,
  type CreditsIdOf,
} from "../src/index.js";

const schema = JSON.parse(readFileSync(new URL("../../../spec/catalog.schema.json", import.meta.url), "utf8"));
const reference: unknown = JSON.parse(
  readFileSync(new URL("../../../spec/conformance/reference-catalog.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
ajv.addFormat("integer", true);
const validate = ajv.compile(schema);

function declare() {
  const messages = feature({ id: "messages", type: "metered" });
  const exportCsv = feature({ id: "export", type: "boolean" });
  const app = group({ id: "app", name: "My App" });
  const free = plan({ name: "Free", group: app, default: true, includes: [messages({ limit: 100, reset: "month" })] });
  const pro = plan({
    name: "Pro",
    group: app,
    price: { amount: 5000, currency: "XOF", interval: "month" },
    trial: { days: 7 },
    includes: [messages({ limit: 2000, reset: "month" }), exportCsv()],
  });
  const tokens = credits({ id: "tokens", name: "AI tokens", coinName: "Tokens" });
  const small = creditPack({ id: "small", of: tokens, credits: 100, price: { amount: 1000, currency: "XOF" } });
  const desktop = license({ id: "desktop", name: "Desktop app", devices: 3, duration: "days-365", price: { amount: 25000, currency: "XOF" } });
  return [messages, exportCsv, free, pro, small, desktop] as const;
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
    const p = plan({ name: "Team", group: "app", price: { amount: 1, currency: "XOF", interval: "month" }, includes: [seats({ limit: 5 })] });
    expect(configError(() => toCatalogDocument([p]))).toContain('includes feature "seats"');
  });

  it("C4 — every local rule the API would enforce later", () => {
    const m = feature({ id: "m", type: "metered" });
    const b = feature({ id: "b", type: "boolean" });
    expect(configError(() => plan({ name: "Paid", group: "g" }))).toContain("no price");
    expect(configError(() => (m as unknown as () => unknown)())).toContain("metered");
    expect(configError(() => (b as unknown as (q: { limit: number }) => unknown)({ limit: 3 }))).toContain("boolean");
    expect(
      configError(() => toCatalogDocument([plan({ name: "A", group: "g", default: true }), plan({ name: "B", group: "g", default: true })])),
    ).toContain("two default plans");
    expect(configError(() => toCatalogDocument([credits({ id: "c", name: "C" })]))).toContain("no pack");
    expect(
      configError(() => toCatalogDocument([license({ id: "x", name: "X", devices: 1, price: { amount: 1, currency: "XOF" } }), plan({ name: "P", group: "x", default: true })])),
    ).toContain("used twice");
  });

  it("C5 — ids the API would refuse are refused at declaration", () => {
    for (const id of ["", "-lead", "has space", "é", "x".repeat(65)]) {
      expect(configError(() => feature({ id, type: "boolean" }))).toContain("Invalid feature id");
    }
  });

  it("C6 — ids are inferred as literals from the declaration", () => {
    const catalog = declare();
    expectTypeOf<PlanNameOf<typeof catalog>>().toEqualTypeOf<"Free" | "Pro">();
    expectTypeOf<CreditsIdOf<typeof catalog>>().toEqualTypeOf<"tokens">();
  });

  it("C7 — a plan is named, never id'd: the emitted plans carry no id", () => {
    const doc = toCatalogDocument(declare());
    const subscription = doc.products.find((p) => p.type === "subscription");
    const plans = subscription?.["plans"];
    expect(Array.isArray(plans)).toBe(true);
    for (const p of plans as ReadonlyArray<Record<string, unknown>>) {
      expect(p).not.toHaveProperty("id");
      expect(typeof p["name"]).toBe("string");
    }
    expect(JSON.stringify(doc)).not.toContain('"id":"free"');
    expect(JSON.stringify(doc)).not.toContain('"id":"pro"');
  });

  it("C7 — the name is required, non-blank and at most 200 characters", () => {
    for (const name of ["", "   ", "\t\n"]) {
      expect(configError(() => plan({ name, group: "g", default: true }))).toContain("needs a name");
    }
    expect(configError(() => plan({ name: "x".repeat(201), group: "g", default: true }))).toContain("at most 200");
    expect(plan({ name: "x".repeat(200), group: "g", default: true }).name).toHaveLength(200);
  });

  it("C8 — names differing only by case or whitespace are the same plan", () => {
    const price = { amount: 1, currency: "XOF", interval: "month" } as const;
    for (const twin of ["pro", " PRO ", "Pro", "pRo\t"]) {
      const message = configError(() =>
        toCatalogDocument([plan({ name: "Pro", group: "g", price }), plan({ name: twin, group: "g", price })]),
      );
      expect(message).toContain("declared twice");
      expect(message).toContain('group "g"');
    }
    expect(
      configError(() =>
        toCatalogDocument([plan({ name: "Pro  Max", group: "g", price }), plan({ name: " pro max", group: "g", price })]),
      ),
    ).toContain("declared twice");
    // A different name is a different plan.
    expect(() =>
      toCatalogDocument([plan({ name: "Pro", group: "g", price }), plan({ name: "Pro Max", group: "g", price })]),
    ).not.toThrow();
  });

  it("C8 — the same name in two groups is two plans", () => {
    const price = { amount: 1, currency: "XOF", interval: "month" } as const;
    const doc = toCatalogDocument([plan({ name: "Pro", group: "a", price }), plan({ name: "Pro", group: "b", price })]);
    expect(doc.products.map((p) => p.id)).toEqual(["a", "b"]);
    expect(validate(doc)).toBe(true);
  });

  it("C9 — the reference declaration produces spec/conformance/reference-catalog.json exactly", () => {
    expect(toCatalogDocument(declare())).toEqual(reference);
  });
});
