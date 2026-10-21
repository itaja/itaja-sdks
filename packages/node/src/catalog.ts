/**
 * The catalogue in code (ADR 0015 D2): one builder per way of selling, and
 * `toCatalogDocument` that turns what you declared into the canonical JSON
 * `PUT /v1/catalog` takes (`spec/catalog.schema.json`).
 *
 * Everything is identified by its **name** (`"Messages"`, `"My App"`,
 * `"AI tokens"`, `"Pro"`): there is no id to choose. Names are compared
 * trimmed, inner whitespace collapsed and case-insensitively, and are inferred
 * as literal types, so `itaja.credits.grant({ product: "AI tokens" })` is
 * checked at compile time. Itaja assigns the system ids. Amounts are in
 * **major units** of their currency, as on every product route of the API
 * (`5000` XOF, `9.99` EUR).
 */
import { ItajaConfigError } from "./errors.js";

export type Interval = "week" | "month" | "quarter" | "year";
export type Reset = "day" | "week" | "month" | "year";

export interface Money {
  /** Major units of `currency` (`5000` XOF, `9.99` EUR). */
  amount: number;
  /** ISO 4217, three letters (`XOF`, `EUR`). */
  currency: string;
}

// ── Features ────────────────────────────────────────────────────────────────

export interface FeatureInclusion<Name extends string = string> {
  /** The included feature's name. */
  readonly feature: Name;
  readonly limit?: number;
  readonly reset?: Reset;
}

interface FeatureBase<Name extends string, T extends "boolean" | "metered"> {
  readonly kind: "feature";
  /** The feature's identity: unique in the catalogue, compared normalised. */
  readonly name: Name;
  readonly type: T;
}

/** A yes/no right: call it with no argument to include it in a plan. */
export type BooleanFeature<Name extends string = string> = FeatureBase<Name, "boolean"> &
  (() => FeatureInclusion<Name>);

/** A quota per period: include it with its `limit` (and `reset`, the plan's interval by default). */
export type MeteredFeature<Name extends string = string> = FeatureBase<Name, "metered"> &
  ((quota: { limit: number; reset?: Reset }) => FeatureInclusion<Name>);

export type Feature = BooleanFeature | MeteredFeature;

export function feature<const Name extends string>(input: { name: Name; type: "boolean" }): BooleanFeature<Name>;
export function feature<const Name extends string>(input: { name: Name; type: "metered" }): MeteredFeature<Name>;
export function feature<const Name extends string>(input: { name: Name; type: "boolean" | "metered" }): Feature {
  assertName(input.name, "feature", `feature({ name: "Messages", type: "metered" })`);
  const name = input.name;
  const include = (quota?: { limit: number; reset?: Reset }): FeatureInclusion<Name> => {
    if (input.type === "boolean") {
      if (quota !== undefined) {
        throw configError(`Feature "${name}" is boolean: include it with no argument, without a limit.`);
      }
      return { feature: name };
    }
    if (quota === undefined || !Number.isInteger(quota.limit) || quota.limit < 0) {
      throw configError(`Feature "${name}" is metered: include it with a whole, non-negative limit.`);
    }
    return { feature: name, limit: quota.limit, ...(quota.reset ? { reset: quota.reset } : {}) };
  };
  // A function's own `name` is read-only: define it, do not assign it.
  Object.defineProperty(include, "name", { value: name, enumerable: true });
  return Object.assign(include, { kind: "feature" as const, type: input.type }) as Feature;
}

// ── Subscriptions ───────────────────────────────────────────────────────────

/** A subscription product: its plans exclude one another for a customer (ADR 0015 D2). */
export interface Group<Name extends string = string> {
  readonly kind: "group";
  /** The product's identity: unique among all your products, compared normalised. */
  readonly name: Name;
  readonly description?: string | null;
}

export function group<const Name extends string>(input: { name: Name; description?: string | null }): Group<Name> {
  assertName(input.name, "product", `group({ name: "My App" })`);
  return {
    kind: "group",
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
}

export interface Plan<Name extends string = string, G extends string = string> {
  readonly kind: "plan";
  /** The plan's identity inside its group (`"Pro"` and `" pro "` are the same plan). */
  readonly name: Name;
  readonly group: Group<G>;
  readonly description?: string | null;
  readonly price?: Money & { interval: Interval; intervalCount?: number };
  readonly trial?: { days: number };
  readonly default?: boolean;
  readonly includes: readonly FeatureInclusion[];
}

/**
 * A plan of a group, identified by its `name` — unique in its group, compared
 * trimmed, inner spaces collapsed and case-insensitively. The same name in two
 * groups is two plans. Renaming a plan declares a new plan (the old one is
 * archived). The group's `default` plan is its free fallback and may omit
 * `price`; every other plan needs one.
 */
export function plan<const Name extends string, const G extends string>(input: {
  /** The plan's identity in its group, as the buyer reads it (`"Pro"`). 1 to 200 characters. */
  name: Name;
  /** The group, or its name. */
  group: Group<G> | G;
  description?: string | null;
  price?: Money & { interval: Interval; intervalCount?: number };
  trial?: { days: number };
  default?: boolean;
  includes?: readonly FeatureInclusion[];
}): Plan<Name, G> {
  assertName(input.name, "plan", `plan({ name: "Pro", group, ... })`);
  const g = typeof input.group === "string" ? group({ name: input.group }) : input.group;
  if (!input.default && input.price === undefined) {
    throw configError(`Plan "${input.name}" has no price: only the group's default plan may be free.`);
  }
  return {
    kind: "plan",
    name: input.name,
    group: g,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.price ? { price: input.price } : {}),
    ...(input.trial ? { trial: input.trial } : {}),
    ...(input.default ? { default: true } : {}),
    includes: input.includes ?? [],
  };
}

// ── Credits ─────────────────────────────────────────────────────────────────

export interface Credits<Name extends string = string> {
  readonly kind: "credits";
  /** The product's identity: unique among all your products, compared normalised. */
  readonly name: Name;
  readonly description?: string | null;
  /** What the buyer calls one credit (`Tokens`, `Coins`). Defaults to `name`. */
  readonly coinName?: string;
}

/** A credit currency your app spends as the buyer uses it (ADR 0010). Sell it with `creditPack`. */
export function credits<const Name extends string>(input: {
  name: Name;
  description?: string | null;
  coinName?: string;
}): Credits<Name> {
  assertName(input.name, "product", `credits({ name: "AI tokens" })`);
  return {
    kind: "credits",
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.coinName !== undefined ? { coinName: input.coinName } : {}),
  };
}

export interface CreditPack<Name extends string = string, C extends string = string> {
  readonly kind: "creditPack";
  /** The pack's identity inside its credits product, and the label the buyer reads. */
  readonly name: Name;
  readonly of: Credits<C>;
  readonly description?: string | null;
  readonly credits: number;
  readonly price: Money;
}

/** A bundle of credits sold at a fixed price, named as the buyer reads it (`"100 tokens"`). */
export function creditPack<const Name extends string, const C extends string>(input: {
  name: Name;
  of: Credits<C>;
  credits: number;
  price: Money;
  description?: string | null;
}): CreditPack<Name, C> {
  assertName(input.name, "credit pack", `creditPack({ name: "100 tokens", of, credits: 100, price })`);
  if (!Number.isInteger(input.credits) || input.credits < 1) {
    throw configError(`Credit pack "${input.name}": credits must be a whole number of at least 1.`);
  }
  return {
    kind: "creditPack",
    name: input.name,
    of: input.of,
    credits: input.credits,
    price: input.price,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
}

// ── Licences ─────────────────────────────────────────────

export type LicenseDuration = "lifetime" | `days-${number}` | `from-first-activation-days-${number}`;

export interface License<Name extends string = string> {
  readonly kind: "license";
  /** The product's identity: unique among all your products, compared normalised. */
  readonly name: Name;
  readonly description?: string | null;
  readonly price: Money;
  /** Devices one key unlocks; `null` = unlimited. */
  readonly devices: number | null;
  readonly duration?: LicenseDuration;
}

/** A licence key that unlocks your software on a number of devices (ADR 0006). */
export function license<const Name extends string>(input: {
  name: Name;
  description?: string | null;
  price: Money;
  devices: number | null;
  duration?: LicenseDuration;
}): License<Name> {
  assertName(input.name, "product", `license({ name: "Desktop app", devices, price })`);
  return {
    kind: "license",
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    price: input.price,
    devices: input.devices,
    ...(input.duration !== undefined ? { duration: input.duration } : {}),
  };
}

// ── The catalogue ───────────────────────────────────────────────────────────

/** What `catalog` accepts: plans, credit packs, licences — and features or credits on their own. */
export type CatalogItem = Plan | CreditPack | License | Credits | Feature;

/** The canonical document `PUT /v1/catalog` takes (`spec/catalog.schema.json`). */
export interface CatalogDocument {
  features: Array<{ name: string; type: "boolean" | "metered" }>;
  products: Array<Record<string, unknown> & { type: "subscription" | "credits" | "license"; name: string }>;
}

type ProductEntry =
  | { kind: "group"; decl: Group; plans: Plan[] }
  | { kind: "credits"; decl: Credits; packs: CreditPack[] }
  | { kind: "license"; decl: License };

/**
 * Turns a declaration into the canonical catalogue. Deterministic: the same
 * declaration gives the same JSON, in declaration order, in every language
 * (ADR 0015 D9). Refuses locally what the API would refuse: a blank or too
 * long name, two items of one scope whose names match once normalised, a plan
 * including a feature the catalogue does not declare.
 */
export function toCatalogDocument(items: readonly CatalogItem[]): CatalogDocument {
  const features = new Map<string, Feature>();
  const products = new Map<string, ProductEntry>();

  const product = (kind: ProductEntry["kind"], decl: Group | Credits | License): ProductEntry => {
    const key = normalizeName(decl.name);
    const known = products.get(key);
    if (!known) {
      const entry: ProductEntry =
        kind === "group"
          ? { kind, decl: decl as Group, plans: [] }
          : kind === "credits"
            ? { kind, decl: decl as Credits, packs: [] }
            : { kind, decl: decl as License };
      products.set(key, entry);
      return entry;
    }
    // The same product reached twice (a group shared by its plans, credits and
    // their packs) is one product; two declarations of one name are refused.
    if (known.decl === decl || (known.kind === kind && kind !== "license" && sameDeclaration(known.decl, decl))) {
      return known;
    }
    throw configError(
      `Product "${decl.name}" is declared twice (same name as "${known.decl.name}"): product names are unique across subscriptions, credits and licences, compared trimmed and case-insensitively.`,
    );
  };

  for (const item of items) {
    switch (item.kind) {
      case "feature": {
        const key = normalizeName(item.name);
        const known = features.get(key);
        // The very same declaration listed twice is one feature; another
        // spelling, or another type, under one name is refused.
        if (known && known !== item && !(known.name === item.name && known.type === item.type)) {
          throw configError(
            `Feature "${item.name}" is declared twice (same name as "${known.name}": feature names are compared trimmed and case-insensitively).`,
          );
        }
        features.set(key, item);
        break;
      }
      case "plan": {
        const entry = product("group", item.group) as Extract<ProductEntry, { kind: "group" }>;
        const key = normalizeName(item.name);
        const twin = entry.plans.find((p) => normalizeName(p.name) === key);
        if (twin) {
          throw configError(
            `Plan "${item.name}" is declared twice in group "${entry.decl.name}" (same name as "${twin.name}": plan names are compared trimmed and case-insensitively).`,
          );
        }
        if (item.default && entry.plans.some((p) => p.default)) {
          throw configError(`Group "${entry.decl.name}" has two default plans; keep one.`);
        }
        entry.plans.push(item);
        break;
      }
      case "credits":
      case "creditPack": {
        const entry = product("credits", item.kind === "credits" ? item : item.of) as Extract<ProductEntry, { kind: "credits" }>;
        if (item.kind === "creditPack") {
          const key = normalizeName(item.name);
          const twin = entry.packs.find((p) => normalizeName(p.name) === key);
          if (twin) {
            throw configError(
              `Credit pack "${item.name}" is declared twice in "${entry.decl.name}" (same name as "${twin.name}": pack names are compared trimmed and case-insensitively).`,
            );
          }
          entry.packs.push(item);
        }
        break;
      }
      case "license":
        product("license", item);
        break;
    }
  }

  const out: CatalogDocument["products"] = [];
  for (const entry of products.values()) {
    if (entry.kind === "group") {
      const g = entry.decl;
      for (const p of entry.plans) {
        for (const inc of p.includes) {
          if (!features.has(normalizeName(inc.feature))) {
            throw configError(
              `Plan "${p.name}" includes feature "${inc.feature}", which the catalogue does not declare. Add the feature to \`catalog\`.`,
            );
          }
        }
      }
      out.push({
        type: "subscription",
        name: g.name,
        ...(g.description !== undefined ? { description: g.description } : {}),
        plans: entry.plans.map((p) => ({
          name: p.name,
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(p.default ? { default: true } : {}),
          ...(p.trial ? { trial: p.trial } : {}),
          ...(p.price ? { price: p.price } : {}),
          includes: p.includes.map((inc) => ({ ...inc })),
        })),
      });
    } else if (entry.kind === "credits") {
      const c = entry.decl;
      if (entry.packs.length === 0) {
        throw configError(`Credits "${c.name}" has no pack: declare at least one creditPack({ name, of, credits, price }).`);
      }
      out.push({
        type: "credits",
        name: c.name,
        ...(c.description !== undefined ? { description: c.description } : {}),
        ...(c.coinName !== undefined ? { coinName: c.coinName } : {}),
        packs: entry.packs.map((p) => ({
          name: p.name,
          ...(p.description !== undefined ? { description: p.description } : {}),
          credits: p.credits,
          price: p.price,
        })),
      });
    } else {
      const l = entry.decl;
      out.push({
        type: "license",
        name: l.name,
        ...(l.description !== undefined ? { description: l.description } : {}),
        devices: l.devices,
        ...(l.duration !== undefined ? { duration: l.duration } : {}),
        price: l.price,
      });
    }
  }

  return { features: [...features.values()].map((f) => ({ name: f.name, type: f.type })), products: out };
}

// ── Typed names, read off a declaration ─────────────────────────────────────

type Items = readonly CatalogItem[];
/** The plan names of a catalogue — what `subscribe({ plan })` takes. */
export type PlanNameOf<C extends Items> = Extract<C[number], Plan>["name"];
/** The credits product names of a catalogue (from `credits()` or the packs selling them). */
export type CreditsNameOf<C extends Items> =
  | Extract<C[number], Credits>["name"]
  | Extract<C[number], CreditPack>["of"]["name"];
/** The licence product names of a catalogue. */
export type LicenseNameOf<C extends Items> = Extract<C[number], License>["name"];
/** The subscription product (group) names of a catalogue. */
export type GroupNameOf<C extends Items> = Extract<C[number], Plan>["group"]["name"];
/** Every product name — groups, credits, licences. */
export type ProductNameOf<C extends Items> = GroupNameOf<C> | CreditsNameOf<C> | LicenseNameOf<C>;

// ── helpers ─────────────────────────────────────────────────────────────────

/** The longest name the API accepts, for every catalogue item. */
export const NAME_MAX_LENGTH = 200;

/**
 * A catalogue item's identity: Unicode NFC, trimmed, inner whitespace
 * collapsed to one space, lowercased — exactly as the API compares names (and
 * stores them as `catalogKey`).
 */
export function normalizeName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function assertName(name: unknown, what: string, example: string): void {
  if (typeof name !== "string" || name.trim() === "") {
    throw configError(`A ${what} needs a name: it is its identity (there is no id), e.g. ${example}.`);
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw configError(
      `The ${what} name "${name.slice(0, 40)}…" is ${name.length} characters long: at most ${NAME_MAX_LENGTH}.`,
    );
  }
}

function sameDeclaration(a: Group | Credits | License, b: Group | Credits | License): boolean {
  const coin = (x: Group | Credits | License) => ("coinName" in x ? x.coinName : undefined);
  return a.name === b.name && a.description === b.description && coin(a) === coin(b);
}

function configError(message: string): ItajaConfigError {
  return new ItajaConfigError({ message, code: "CATALOG_DECLARATION_INVALID", status: 0 });
}
