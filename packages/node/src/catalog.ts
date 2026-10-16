/**
 * The catalogue in code (ADR 0015 D2): one builder per way of selling, and
 * `toCatalogDocument` that turns what you declared into the canonical JSON
 * `PUT /v1/catalog` takes (`spec/catalog.schema.json`).
 *
 * Every id is **yours** (`free`, `pro`, `messages`) and is inferred as a literal
 * type, so `itaja.credits.grant({ credits: "tokens" })` is checked at compile
 * time. Amounts are in **major units** of their currency, as on every product
 * route of the API (`5000` XOF, `9.99` EUR).
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

export interface FeatureInclusion<Id extends string = string> {
  readonly feature: Id;
  readonly limit?: number;
  readonly reset?: Reset;
}

interface FeatureBase<Id extends string, T extends "boolean" | "metered"> {
  readonly kind: "feature";
  readonly id: Id;
  readonly type: T;
}

/** A yes/no right: call it with no argument to include it in a plan. */
export type BooleanFeature<Id extends string = string> = FeatureBase<Id, "boolean"> &
  (() => FeatureInclusion<Id>);

/** A quota per period: include it with its `limit` (and `reset`, the plan's interval by default). */
export type MeteredFeature<Id extends string = string> = FeatureBase<Id, "metered"> &
  ((quota: { limit: number; reset?: Reset }) => FeatureInclusion<Id>);

export type Feature = BooleanFeature | MeteredFeature;

export function feature<const Id extends string>(input: { id: Id; type: "boolean" }): BooleanFeature<Id>;
export function feature<const Id extends string>(input: { id: Id; type: "metered" }): MeteredFeature<Id>;
export function feature<const Id extends string>(input: { id: Id; type: "boolean" | "metered" }): Feature {
  assertId(input.id, "feature");
  const include = (quota?: { limit: number; reset?: Reset }): FeatureInclusion<Id> => {
    if (input.type === "boolean") {
      if (quota !== undefined) {
        throw configError(`Feature "${input.id}" is boolean: include it as ${input.id}(), without a limit.`);
      }
      return { feature: input.id };
    }
    if (quota === undefined || !Number.isInteger(quota.limit) || quota.limit < 0) {
      throw configError(`Feature "${input.id}" is metered: include it with a whole, non-negative limit.`);
    }
    return { feature: input.id, limit: quota.limit, ...(quota.reset ? { reset: quota.reset } : {}) };
  };
  return Object.assign(include, { kind: "feature" as const, id: input.id, type: input.type }) as Feature;
}

// ── Subscriptions ───────────────────────────────────────────────────────────

/** A subscription product: its plans exclude one another for a customer (ADR 0015 D2). */
export interface Group<Id extends string = string> {
  readonly kind: "group";
  readonly id: Id;
  readonly name: string;
  readonly description?: string | null;
}

export function group<const Id extends string>(input: {
  id: Id;
  name: string;
  description?: string | null;
}): Group<Id> {
  assertId(input.id, "group");
  return { kind: "group", ...input };
}

export interface Plan<Id extends string = string, G extends string = string> {
  readonly kind: "plan";
  readonly id: Id;
  readonly group: Group<G>;
  readonly name: string;
  readonly description?: string | null;
  readonly price?: Money & { interval: Interval; intervalCount?: number };
  readonly trial?: { days: number };
  readonly default?: boolean;
  readonly includes: readonly FeatureInclusion[];
}

/**
 * A plan of a group. The group's `default` plan is its free fallback and may
 * omit `price`; every other plan needs one.
 */
export function plan<const Id extends string, const G extends string>(input: {
  id: Id;
  /** The group, or its id — then the group is named after it. */
  group: Group<G> | G;
  name?: string;
  description?: string | null;
  price?: Money & { interval: Interval; intervalCount?: number };
  trial?: { days: number };
  default?: boolean;
  includes?: readonly FeatureInclusion[];
}): Plan<Id, G> {
  assertId(input.id, "plan");
  const g = typeof input.group === "string" ? group({ id: input.group, name: humanize(input.group) }) : input.group;
  if (!input.default && input.price === undefined) {
    throw configError(`Plan "${input.id}" has no price: only the group's default plan may be free.`);
  }
  return {
    kind: "plan",
    id: input.id,
    group: g,
    name: input.name ?? humanize(input.id),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.price ? { price: input.price } : {}),
    ...(input.trial ? { trial: input.trial } : {}),
    ...(input.default ? { default: true } : {}),
    includes: input.includes ?? [],
  };
}

// ── Credits ─────────────────────────────────────────────────────────────────

export interface Credits<Id extends string = string> {
  readonly kind: "credits";
  readonly id: Id;
  readonly name: string;
  readonly description?: string | null;
  /** What the buyer calls one credit (`Tokens`, `Coins`). Defaults to `name`. */
  readonly coinName?: string;
}

/** A credit currency your app spends as the buyer uses it (ADR 0010). Sell it with `creditPack`. */
export function credits<const Id extends string>(input: {
  id: Id;
  name: string;
  description?: string | null;
  coinName?: string;
}): Credits<Id> {
  assertId(input.id, "credits");
  return { kind: "credits", ...input };
}

export interface CreditPack<Id extends string = string, C extends string = string> {
  readonly kind: "creditPack";
  readonly id: Id;
  readonly of: Credits<C>;
  readonly label: string;
  readonly description?: string | null;
  readonly credits: number;
  readonly price: Money;
}

/** A bundle of credits sold at a fixed price. All packs of one currency share a price currency. */
export function creditPack<const Id extends string, const C extends string>(input: {
  id: Id;
  of: Credits<C>;
  credits: number;
  price: Money;
  label?: string;
  description?: string | null;
}): CreditPack<Id, C> {
  assertId(input.id, "credit pack");
  if (!Number.isInteger(input.credits) || input.credits < 1) {
    throw configError(`Credit pack "${input.id}": credits must be a whole number of at least 1.`);
  }
  return {
    kind: "creditPack",
    id: input.id,
    of: input.of,
    credits: input.credits,
    price: input.price,
    label: input.label ?? `${input.credits} ${input.of.coinName ?? input.of.name}`,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
}

// ── Licences ─────────────────────────────────────────────

export type LicenseDuration = "lifetime" | `days-${number}` | `from-first-activation-days-${number}`;

export interface License<Id extends string = string> {
  readonly kind: "license";
  readonly id: Id;
  readonly name: string;
  readonly description?: string | null;
  readonly price: Money;
  /** Devices one key unlocks; `null` = unlimited. */
  readonly devices: number | null;
  readonly duration?: LicenseDuration;
}

/** A licence key that unlocks your software on a number of devices (ADR 0006). */
export function license<const Id extends string>(input: {
  id: Id;
  name: string;
  description?: string | null;
  price: Money;
  devices: number | null;
  duration?: LicenseDuration;
}): License<Id> {
  assertId(input.id, "license");
  return { kind: "license", ...input };
}

// ── The catalogue ───────────────────────────────────────────────────────────

/** What `catalog` accepts: plans, credit packs, licences — and features or credits on their own. */
export type CatalogItem = Plan | CreditPack | License | Credits | Feature;

/** The canonical document `PUT /v1/catalog` takes (`spec/catalog.schema.json`). */
export interface CatalogDocument {
  features: Array<{ id: string; type: "boolean" | "metered" }>;
  products: Array<Record<string, unknown> & { id: string; type: "subscription" | "credits" | "license" }>;
}

/**
 * Turns a declaration into the canonical catalogue. Deterministic: the same
 * declaration gives the same JSON, in declaration order, in every language
 * (ADR 0015 D9). Features are the ones you list plus every one a plan includes.
 */
export function toCatalogDocument(items: readonly CatalogItem[]): CatalogDocument {
  const features = new Map<string, { id: string; type: "boolean" | "metered" }>();
  const products = new Map<string, CatalogDocument["products"][number]>();
  const groups = new Map<string, { group: Group; plans: Plan[] }>();
  const creditProducts = new Map<string, { credits: Credits; packs: CreditPack[] }>();
  const order: Array<{ kind: "group" | "credits" | "single"; id: string }> = [];
  const seen = (_kind: string, id: string) =>
    products.has(`single:${id}`) || groups.has(id) || creditProducts.has(id);

  const addFeature = (f: Feature) => {
    const known = features.get(f.id);
    if (known && known.type !== f.type) {
      throw configError(`Feature "${f.id}" is declared twice with different types.`);
    }
    features.set(f.id, { id: f.id, type: f.type });
  };

  for (const item of items) {
    switch (item.kind) {
      case "feature":
        addFeature(item);
        break;
      case "plan": {
        let entry = groups.get(item.group.id);
        if (!entry) {
          if (seen("group", item.group.id)) throw duplicateProduct(item.group.id);
          entry = { group: item.group, plans: [] };
          groups.set(item.group.id, entry);
          order.push({ kind: "group", id: item.group.id });
        } else if (entry.group.name !== item.group.name) {
          throw configError(`Group "${item.group.id}" is declared with two different names.`);
        }
        if (entry.plans.some((p) => p.id === item.id)) {
          throw configError(`Plan "${item.id}" is declared twice in group "${item.group.id}".`);
        }
        if (item.default && entry.plans.some((p) => p.default)) {
          throw configError(`Group "${item.group.id}" has two default plans; keep one.`);
        }
        entry.plans.push(item);
        break;
      }
      case "credits":
      case "creditPack": {
        const c = item.kind === "credits" ? item : item.of;
        let entry = creditProducts.get(c.id);
        if (!entry) {
          if (seen("credits", c.id)) throw duplicateProduct(c.id);
          entry = { credits: c, packs: [] };
          creditProducts.set(c.id, entry);
          order.push({ kind: "credits", id: c.id });
        }
        if (item.kind === "creditPack") {
          if (entry.packs.some((p) => p.id === item.id)) {
            throw configError(`Credit pack "${item.id}" is declared twice in "${c.id}".`);
          }
          entry.packs.push(item);
        }
        break;
      }
      case "license": {
        if (seen("single", item.id)) throw duplicateProduct(item.id);
        const { kind, ...rest } = item;
        products.set(`single:${item.id}`, { ...rest, type: kind } as CatalogDocument["products"][number]);
        order.push({ kind: "single", id: item.id });
        break;
      }
    }
  }

  const out: CatalogDocument["products"] = [];
  for (const entry of order) {
    if (entry.kind === "group") {
      const { group: g, plans } = groups.get(entry.id)!;
      for (const p of plans) {
        for (const inc of p.includes) {
          if (!features.has(inc.feature)) {
            throw configError(
              `Plan "${p.id}" includes feature "${inc.feature}", which the catalogue does not declare. Add the feature to \`catalog\`.`,
            );
          }
        }
      }
      out.push({
        id: g.id,
        type: "subscription",
        name: g.name,
        ...(g.description !== undefined ? { description: g.description } : {}),
        plans: plans.map((p) => ({
          id: p.id,
          name: p.name,
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(p.price ? { price: p.price } : {}),
          ...(p.trial ? { trial: p.trial } : {}),
          ...(p.default ? { default: true } : {}),
          includes: p.includes.map((inc) => ({ ...inc })),
        })),
      });
    } else if (entry.kind === "credits") {
      const { credits: c, packs } = creditProducts.get(entry.id)!;
      if (packs.length === 0) {
        throw configError(`Credits "${c.id}" has no pack: declare at least one creditPack({ of: ${c.id} }).`);
      }
      out.push({
        id: c.id,
        type: "credits",
        name: c.name,
        ...(c.description !== undefined ? { description: c.description } : {}),
        ...(c.coinName !== undefined ? { coinName: c.coinName } : {}),
        packs: packs.map((p) => ({
          id: p.id,
          label: p.label,
          ...(p.description !== undefined ? { description: p.description } : {}),
          credits: p.credits,
          price: p.price,
        })),
      });
    } else {
      out.push(products.get(`single:${entry.id}`)!);
    }
  }

  return { features: [...features.values()], products: out };
}

// ── Typed ids, read off a declaration ───────────────────────────────────────

type Items = readonly CatalogItem[];
/** The plan ids of a catalogue. */
export type PlanIdOf<C extends Items> = Extract<C[number], Plan>["id"];
/** The credit ids of a catalogue (from `credits()` or the packs selling them). */
export type CreditsIdOf<C extends Items> =
  | Extract<C[number], Credits>["id"]
  | Extract<C[number], CreditPack>["of"]["id"];
/** The licence ids of a catalogue. */
export type LicenseIdOf<C extends Items> = Extract<C[number], License>["id"];
/** Every product id — groups, credits, licences. */
export type ProductIdOf<C extends Items> =
  | Extract<C[number], Plan>["group"]["id"]
  | CreditsIdOf<C>
  | LicenseIdOf<C>;

// ── helpers ─────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function assertId(id: string, what: string): void {
  if (!ID_PATTERN.test(id)) {
    throw configError(
      `Invalid ${what} id "${id}": 1 to 64 letters, digits, "_" or "-", starting with a letter or a digit.`,
    );
  }
}

function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function duplicateProduct(id: string): ItajaConfigError {
  return configError(`Product id "${id}" is used twice in the catalogue (groups, credits and licences share one id space).`);
}

function configError(message: string): ItajaConfigError {
  return new ItajaConfigError({ message, code: "CATALOG_DECLARATION_INVALID", status: 0 });
}
