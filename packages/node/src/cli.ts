/**
 * `itaja` — the command line of the Node SDK.
 *
 *   itaja catalog                print the canonical catalogue your config declares
 *   itaja push [--dry-run] [--yes]
 *                                sync it to Itaja (asks before writing, unless --yes)
 *   itaja status                 dry-run; exits 1 when Itaja differs from your code
 *   itaja trigger <type> --url <url> [--data '<json>']
 *                                send a signed sample event to your local handler
 *
 * Options: --config <file> (default: itaja.config.ts, .mts, .js, .mjs), --json.
 * The key and secret come from your config file (createItaja({ apiKey, webhookSecret })),
 * which usually reads them from ITAJA_API_KEY / ITAJA_WEBHOOK_SECRET — never from a flag.
 * The CLI loads `.env` and `.env.local` from the current directory first, so nothing
 * has to be exported in the shell.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import axios from "axios";
import { createJiti } from "jiti";
import type { Itaja } from "./client.js";
import type { CatalogItem } from "./catalog.js";
import { ItajaError } from "./errors.js";
import { signPayload } from "./webhooks.js";

// process.loadEnvFile never overrides a variable already set: loading .env.local first
// makes it win over .env, and the shell wins over both.
const ENV_FILES = [".env.local", ".env"];

/** Loads `.env.local` then `.env` (Node >= 20.12). */
function loadEnvFiles(): void {
  const load = (process as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (typeof load !== "function") return;
  for (const name of ENV_FILES) {
    const path = resolve(name);
    if (existsSync(path)) load(path);
  }
}

const CONFIG_NAMES = ["itaja.config.ts", "itaja.config.mts", "itaja.config.js", "itaja.config.mjs"];

interface Args {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | true>;
}

function parse(argv: string[]): Args {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) flags[name] = inline;
    else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--")) flags[name] = rest[++i]!;
    else flags[name] = true;
  }
  return { command, positional, flags };
}

async function loadItaja(flags: Args["flags"]): Promise<Itaja<readonly CatalogItem[]>> {
  const file =
    typeof flags.config === "string"
      ? resolve(flags.config)
      : CONFIG_NAMES.map((name) => resolve(name)).find((path) => existsSync(path));
  if (!file || !existsSync(file)) {
    throw new Error(`No Itaja config found. Create itaja.config.ts exporting your createItaja(...) instance, or pass --config.`);
  }
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const mod = (await jiti.import(file)) as Record<string, unknown>;
  const candidate = (mod.default ?? mod.itaja) as Itaja<readonly CatalogItem[]> | undefined;
  if (!candidate || typeof candidate.push !== "function") {
    throw new Error(`${file} must export your createItaja(...) instance as \`default\` or \`itaja\`.`);
  }
  return candidate;
}

type Change = { kind: string; key: string; product: string | null; action: string; version: number | null; fields: string[] };
type Diff = { mode: string; dryRun: boolean; summary: Record<string, number>; changes: Change[] };

function printDiff(diff: Diff): void {
  const marks: Record<string, string> = { created: "+", changed: "~", archived: "-", unchanged: " " };
  for (const c of diff.changes) {
    if (c.action === "unchanged") continue;
    const where = c.product ? `${c.product}/` : "";
    const version = c.version !== null ? ` v${c.version}` : "";
    const fields = c.fields.length > 0 ? ` (${c.fields.join(", ")})` : "";
    console.log(`  ${marks[c.action] ?? "?"} ${c.kind} ${where}${c.key}${version}${fields}`);
  }
  const s = diff.summary;
  console.log(`\n  ${s.created ?? 0} created · ${s.changed ?? 0} changed · ${s.archived ?? 0} archived · ${s.unchanged ?? 0} unchanged`);
}

const hasChanges = (diff: Diff) => (diff.summary.created ?? 0) + (diff.summary.changed ?? 0) + (diff.summary.archived ?? 0) > 0;

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

const SAMPLES: Record<string, Record<string, unknown>> = {
  "checkout.paid": { checkoutId: "chk_sample", productId: null, transactionId: "txn_sample", amount: 5000, currency: "XOF", paidAt: new Date().toISOString() },
  "credits.granted": { productId: "prd_sample", walletId: "cwl_sample", customerId: "cus_sample", amount: 100, delta: 100, balanceAfter: 100, reason: null, idempotencyKey: "sample-grant" },
  "credits.low": { productId: "prd_sample", walletId: "cwl_sample", customerId: "cus_sample", balance: 10, threshold: 20, idempotencyKey: "sample-consume" },
  "license.issued": { productId: "prd_sample", keyId: "key_sample", key: "ITJ-••••-••••-SMPL", customerId: "cus_sample", checkoutId: null, activationsMax: 3, expiresAt: null, status: "ACTIVE" },
  "invoice.paid": { productId: "prd_sample", contractId: "sub_sample", customerId: "cus_sample", planId: "pln_sample", invoiceId: "inv_sample", invoiceNumber: 1, amount: 5000, currency: "XOF", periodStart: new Date().toISOString(), periodEnd: new Date().toISOString(), dueDate: new Date().toISOString(), paidAt: new Date().toISOString() },
  "subscription.canceled": { productId: "prd_sample", contractId: "sub_sample", customerId: "cus_sample", planId: "pln_sample", status: "CANCELED", reason: "merchant", collectionMode: "MANUAL", currentPeriodStart: new Date().toISOString(), currentPeriodEnd: new Date().toISOString(), canceledAt: new Date().toISOString(), endedAt: null },
};

async function main(argv: string[]): Promise<number> {
  loadEnvFiles();
  const { command, positional, flags } = parse(argv);
  const asJson = flags.json === true;

  switch (command) {
    case "catalog": {
      const itaja = await loadItaja(flags);
      console.log(JSON.stringify(itaja.catalog, null, 2));
      return 0;
    }
    case "push":
    case "status": {
      const itaja = await loadItaja(flags);
      const banner = `Itaja ${itaja.mode.toUpperCase()} catalogue`;
      const diff = (await itaja.push({ dryRun: true })) as Diff;
      if (command === "status" || flags["dry-run"] === true) {
        if (asJson) console.log(JSON.stringify(diff, null, 2));
        else {
          console.log(`${banner} — ${hasChanges(diff) ? "differs from your code" : "in sync"}:\n`);
          printDiff(diff);
        }
        return command === "status" && hasChanges(diff) ? 1 : 0;
      }
      if (!hasChanges(diff)) {
        if (asJson) console.log(JSON.stringify(diff, null, 2));
        else console.log(`${banner} is already in sync. Nothing to push.`);
        return 0;
      }
      if (!asJson) {
        console.log(`${banner} — changes to apply:\n`);
        printDiff(diff);
        console.log("");
      }
      if (flags.yes !== true) {
        const ok = await confirm(`Apply these changes to your ${itaja.mode} catalogue?`);
        if (!ok) {
          console.error(process.stdin.isTTY ? "Aborted." : "Not a terminal: pass --yes to apply.");
          return 1;
        }
      }
      const applied = (await itaja.push({ idempotencyKey: randomUUID() })) as Diff;
      if (asJson) console.log(JSON.stringify(applied, null, 2));
      else console.log(`Pushed: ${applied.summary.created} created · ${applied.summary.changed} changed · ${applied.summary.archived} archived.`);
      return 0;
    }
    case "trigger": {
      const type = positional[0];
      const url = typeof flags.url === "string" ? flags.url : undefined;
      const secret = process.env.ITAJA_WEBHOOK_SECRET;
      if (!type || !url) throw new Error("Usage: itaja trigger <type> --url <url> [--data '<json>'] [--mode sandbox|live]");
      if (!secret) throw new Error("Set ITAJA_WEBHOOK_SECRET (in .env) to the secret your handler checks.");
      const data = typeof flags.data === "string" ? (JSON.parse(flags.data) as Record<string, unknown>) : SAMPLES[type];
      if (!data) throw new Error(`No sample for "${type}": pass --data '<json>'. Samples: ${Object.keys(SAMPLES).join(", ")}.`);
      const mode = flags.mode === "live" ? "live" : "sandbox";
      const payload = JSON.stringify({ id: `itaja_evt_trigger_${randomUUID()}`, type, apiVersion: "v1", mode, createdAt: new Date().toISOString(), data });
      const response = await axios.post(url, payload, {
        headers: { "content-type": "application/json", ...signPayload({ payload, secret }) },
        validateStatus: () => true,
        transformRequest: [(body: string) => body],
      });
      console.log(`${type} → ${url}: HTTP ${response.status} ${typeof response.data === "string" ? response.data : JSON.stringify(response.data)}`);
      return response.status < 300 ? 0 : 1;
    }
    case undefined:
    case "help":
    case "--help":
      console.log(
        [
          "itaja catalog                         print the catalogue your config declares",
          "itaja push [--dry-run] [--yes]        sync it to Itaja",
          "itaja status                          exit 1 when Itaja differs from your code",
          "itaja trigger <type> --url <url>      send a signed sample event to your handler",
          "",
          "--config <file>   default: itaja.config.ts | .mts | .js | .mjs",
          "--json            machine-readable output",
          "Reads .env and .env.local: ITAJA_API_KEY, ITAJA_WEBHOOK_SECRET, ITAJA_API_URL",
        ].join("\n"),
      );
      return 0;
    default:
      console.error(`Unknown command "${command}". Run \`itaja help\`.`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ItajaError) {
      console.error(`Itaja error ${error.status} ${error.code}: ${error.message}`);
      const issues = (error.details as { issues?: Array<{ path: string; message: string }> } | null)?.issues;
      for (const issue of issues ?? []) console.error(`  - ${issue.path}: ${issue.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  },
);
