/**
 * The catalogue in code (ADR 0015 D2) → the canonical document `PUT /v1/catalog`
 * takes.
 *
 * ── HOW IT CAN FAIL (written before the code) ───────────────────────────────
 *
 * C1. The document the SDK builds is refused by the API's own schema
 *     (`spec/catalog.schema.json`).
 * C2. The same declaration gives two different documents (order, undefined
 *     keys): `push` reports changes that are not there, and two languages
 *     disagree.
 * C3. A feature included by a plan but not declared is sent anyway — the API
 *     answers 422 at deploy time instead of the developer's editor/CI. Or a
 *     feature declared under one spelling and included under another
 *     (`"messages"` vs `"Messages"`) is refused though the API sees one.
 * C4. Two default plans in a group, a paid plan without a price, a boolean
 *     feature with a limit, a metered one without, or credits without a pack
 *     are accepted locally.
 * C5. A blank or over-long name passes locally and fails on the server.
 * C6. Typed names are not inferred: `PlanNameOf` widens to `string`.
 * C7. An id is accepted or emitted anywhere: features, products, packs and
 *     plans are identified by their name only (there is no catalogue id).
 * C8. Two items of one scope whose names differ only by case or spaces are
 *     accepted locally, though the API sees one — or the same plan name in two
 *     groups is refused, though each group is its own namespace.
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
  normalizeName,
  type CatalogItem,
  type CreditsNameOf,
  type LicenseNameOf,
  type PlanNameOf,
  type ProductNameOf,
} from "../src/index.js";

const schema = JSON.parse(readFileSync(new URL("../../../spec/catalog.schema.json", import.meta.url), "utf8"));
const reference: unknown = JSON.parse(
  readFileSync(new URL("../../../spec/conformance/reference-catalog.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
ajv.addFormat("integer", true);
const validate = ajv.compile(schema);

function declare() {
  const messages = feature({ name: "Messages", type: "metered" });
  const exportCsv = feature({ name: "Export", type: "boolean" });
  const app = group({ name: "My App" });
  const free = plan({ name: "Free", group: app, default: true, includes: [messages({ limit: 100, reset: "month" })] });
  const pro = plan({
    name: "Pro",
    group: app,
    price: { amount: 5000, currency: "XOF", interval: "month" },
    trial: { days: 7 },
    includes: [messages({ limit: 2000, reset: "month" }), exportCsv()],
  });
  const tokens = credits({ name: "AI tokens", coinName: "Tokens" });
  const small = creditPack({ name: "100 tokens", of: tokens, credits: 100, price: { amount: 1000, currency: "XOF" } });
  const desktop = license({ name: "Desktop app", devices: 3, duration: "days-365", price: { amount: 25000, currency: "XOF" } });
  return [messages, exportCsv, free, pro, small, desktop] as const;
}

const configError = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ItajaConfigError);
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected an ItajaConfigError");
};

const monthly = { amount: 1, currency: "XOF", interval: "month" } as const;
const xof = { amount: 1, currency: "XOF" } as const;

/** Every key of every object in a JSON value, at any depth. */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)]);
  }
  return [];
}

describe("toCatalogDocument", () => {
  it("C1 — the reference declaration validates against the API's schema", () => {
    const doc = toCatalogDocument(declare());
    const ok = validate(doc);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("C1 — the schema itself refuses an id-less name and accepts no id requirement", () => {
    expect(validate({ features: [{ type: "boolean" }], products: [] })).toBe(false);
    expect(validate({ features: [{ name: "   ", type: "boolean" }], products: [] })).toBe(false);
    expect(validate({ features: [{ name: "Export", type: "boolean" }], products: [] })).toBe(true);
  });

  it("C2 — the same declaration always serialises to the same bytes", () => {
    expect(JSON.stringify(toCatalogDocument(declare()))).toBe(JSON.stringify(toCatalogDocument(declare())));
    expect(JSON.stringify(toCatalogDocument(declare()))).not.toContain("undefined");
  });

  it("C3 — a plan including an undeclared feature is refused locally", () => {
    const seats = feature({ name: "Seats", type: "metered" });
    const p = plan({ name: "Team", group: "My App", price: monthly, includes: [seats({ limit: 5 })] });
    expect(configError(() => toCatalogDocument([p]))).toContain('includes feature "Seats"');
  });

  it("C3 — includes match the declared feature by normalised name", () => {
    const declared = feature({ name: "Messages", type: "metered" });
    const spelledOtherwise = feature({ name: " messages ", type: "metered" });
    const p = plan({ name: "Free", group: "My App", default: true, includes: [spelledOtherwise({ limit: 1 })] });
    const doc = toCatalogDocument([declared, p]);
    expect(doc.features).toEqual([{ name: "Messages", type: "metered" }]);
    expect(doc.products[0]?.["plans"]).toEqual([{ name: "Free", default: true, includes: [{ feature: " messages ", limit: 1 }] }]);
  });

  it("C4 — every local rule the API would enforce later", () => {
    const m = feature({ name: "M", type: "metered" });
    const b = feature({ name: "B", type: "boolean" });
    expect(configError(() => plan({ name: "Paid", group: "g" }))).toContain("no price");
    // @ts-expect-error a metered feature is included with its limit
    expect(configError(() => m())).toContain("metered");
    // @ts-expect-error a boolean feature takes no limit
    expect(configError(() => b({ limit: 3 }))).toContain("boolean");
    expect(
      configError(() => toCatalogDocument([plan({ name: "A", group: "g", default: true }), plan({ name: "B", group: "g", default: true })])),
    ).toContain("two default plans");
    expect(configError(() => toCatalogDocument([credits({ name: "C" })]))).toContain("no pack");
  });

  it("C5 — every name is required, non-blank and at most 200 characters", () => {
    const builders: Array<[string, (name: string) => unknown]> = [
      ["feature", (name) => feature({ name, type: "boolean" })],
      ["product", (name) => group({ name })],
      ["plan", (name) => plan({ name, group: "g", default: true })],
      ["product", (name) => credits({ name })],
      ["credit pack", (name) => creditPack({ name, of: credits({ name: "C" }), credits: 1, price: xof })],
      ["product", (name) => license({ name, devices: 1, price: xof })],
    ];
    for (const [what, build] of builders) {
      for (const blank of ["", "   ", "\t\n"]) {
        expect(configError(() => build(blank))).toContain(`A ${what} needs a name`);
      }
      expect(configError(() => build("x".repeat(201)))).toContain("at most 200");
      expect(() => build("x".repeat(200))).not.toThrow();
    }
  });

  it("C6 — names are inferred as literals from the declaration", () => {
    const catalog = declare();
    expectTypeOf<PlanNameOf<typeof catalog>>().toEqualTypeOf<"Free" | "Pro">();
    expectTypeOf<CreditsNameOf<typeof catalog>>().toEqualTypeOf<"AI tokens">();
    expectTypeOf<LicenseNameOf<typeof catalog>>().toEqualTypeOf<"Desktop app">();
    expectTypeOf<ProductNameOf<typeof catalog>>().toEqualTypeOf<"My App" | "AI tokens" | "Desktop app">();
  });

  it("C7 — no builder accepts an id", () => {
    // @ts-expect-error a feature has no id
    feature({ id: "messages", name: "Messages", type: "metered" });
    // @ts-expect-error a group has no id
    group({ id: "app", name: "My App" });
    // @ts-expect-error a plan has no id
    plan({ id: "pro", name: "Pro", group: "My App", default: true });
    // @ts-expect-error credits have no id
    credits({ id: "tokens", name: "AI tokens" });
    // @ts-expect-error a pack has no id
    creditPack({ id: "small", name: "100 tokens", of: credits({ name: "AI tokens" }), credits: 1, price: xof });
    // @ts-expect-error a pack has no label: its name is its label
    creditPack({ label: "100", name: "100 tokens", of: credits({ name: "AI tokens" }), credits: 1, price: xof });
    // @ts-expect-error a licence has no id
    license({ id: "desktop", name: "Desktop app", devices: 1, price: xof });
  });

  it("C7 — the emitted document carries no id nor label anywhere", () => {
    const keys = keysDeep(toCatalogDocument(declare()));
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("label");
  });

  it("C8 — features whose names differ only by case or whitespace are one feature", () => {
    for (const twin of ["messages", " MESSAGES ", "Messages\t"]) {
      const message = configError(() =>
        toCatalogDocument([feature({ name: "Messages", type: "metered" }), feature({ name: twin, type: "metered" })]),
      );
      expect(message).toContain("Feature");
      expect(message).toContain("declared twice");
    }
  });

  it("C8 — products share one namespace across types, compared normalised", () => {
    const pairs: Array<[CatalogItem, CatalogItem]> = [
      [plan({ name: "Free", group: "My App", default: true }), license({ name: " my  app ", devices: 1, price: xof })],
      [creditPack({ name: "P", of: credits({ name: "AI tokens" }), credits: 1, price: xof }), plan({ name: "Free", group: "AI TOKENS", default: true })],
      [license({ name: "Desktop app", devices: 1, price: xof }), license({ name: "desktop app", devices: 2, price: xof })],
      [plan({ name: "Free", group: group({ name: "App" }), default: true }), plan({ name: "Pro", group: group({ name: "App", description: "other" }), price: monthly })],
    ];
    for (const [a, b] of pairs) {
      const message = configError(() => toCatalogDocument([a, b]));
      expect(message).toContain("Product");
      expect(message).toContain("declared twice");
    }
  });

  it("C8 — a group shared by its plans, or named by a string, is one product", () => {
    const app = group({ name: "My App" });
    const doc = toCatalogDocument([
      plan({ name: "Free", group: app, default: true }),
      plan({ name: "Pro", group: "My App", price: monthly }),
    ]);
    expect(doc.products).toHaveLength(1);
    expect(doc.products[0]?.["plans"]).toHaveLength(2);
  });

  it("C8 — packs whose names differ only by case or whitespace are one pack; the same name in two products is two", () => {
    const tokens = credits({ name: "AI tokens" });
    for (const twin of ["100 TOKENS", " 100  tokens "]) {
      const message = configError(() =>
        toCatalogDocument([
          creditPack({ name: "100 tokens", of: tokens, credits: 100, price: xof }),
          creditPack({ name: twin, of: tokens, credits: 200, price: xof }),
        ]),
      );
      expect(message).toContain('Credit pack "' + twin + '" is declared twice in "AI tokens"');
    }
    const other = credits({ name: "Image credits" });
    const doc = toCatalogDocument([
      creditPack({ name: "100 tokens", of: tokens, credits: 100, price: xof }),
      creditPack({ name: "100 tokens", of: other, credits: 100, price: xof }),
    ]);
    expect(doc.products.map((p) => p.name)).toEqual(["AI tokens", "Image credits"]);
    expect(validate(doc)).toBe(true);
  });

  it("C8 — plans whose names differ only by case or whitespace are the same plan", () => {
    for (const twin of ["pro", " PRO ", "Pro", "pRo\t"]) {
      const message = configError(() =>
        toCatalogDocument([plan({ name: "Pro", group: "g", price: monthly }), plan({ name: twin, group: "g", price: monthly })]),
      );
      expect(message).toContain("declared twice");
      expect(message).toContain('group "g"');
    }
    expect(
      configError(() =>
        toCatalogDocument([plan({ name: "Pro  Max", group: "g", price: monthly }), plan({ name: " pro max", group: "g", price: monthly })]),
      ),
    ).toContain("declared twice");
    expect(() =>
      toCatalogDocument([plan({ name: "Pro", group: "g", price: monthly }), plan({ name: "Pro Max", group: "g", price: monthly })]),
    ).not.toThrow();
  });

  it("C8 — the same plan name in two groups is two plans", () => {
    const doc = toCatalogDocument([plan({ name: "Pro", group: "a", price: monthly }), plan({ name: "Pro", group: "b", price: monthly })]);
    expect(doc.products.map((p) => p.name)).toEqual(["a", "b"]);
    expect(validate(doc)).toBe(true);
  });

  it("normalizeName composes (NFC), trims, collapses inner whitespace and lowercases", () => {
    expect(normalizeName("  AI \t  TOKENS ")).toBe("ai tokens");
    // "é" typed as e + combining acute is the same name as the precomposed "é".
    expect(normalizeName("Cafe\u0301")).toBe(normalizeName("CAF\u00c9"));
    expect(normalizeName("Pro")).toBe(normalizeName(" pro "));
  });

  it("C9 — the reference declaration produces spec/conformance/reference-catalog.json exactly", () => {
    const doc = toCatalogDocument(declare());
    expect(doc).toEqual(reference);
    // Same keys in the same order, so every SDK emits the same bytes.
    expect(JSON.stringify(doc)).toBe(JSON.stringify(reference));
  });
});
