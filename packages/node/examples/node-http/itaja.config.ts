/**
 * The whole integration of a small SaaS: what it sells, and what it does when
 * Itaja tells it something happened. `itaja push` reads this file.
 */
import { createItaja, creditPack, credits, feature, group, license, plan } from "../../src/index.js";

// 1. Declare
export const messages = feature({ id: "messages", type: "metered" });
export const exportCsv = feature({ id: "export", type: "boolean" });

const app = group({ id: process.env.EXAMPLE_GROUP_ID ?? "app", name: "My App" });
export const free = plan({ name: "Free", group: app, default: true, includes: [messages({ limit: 100, reset: "month" })] });
export const pro = plan({
  name: "Pro",
  group: app,
  price: { amount: 5000, currency: "XOF", interval: "month" },
  trial: { days: 7 },
  includes: [messages({ limit: 2000, reset: "month" }), exportCsv()],
});

const tokens = credits({ id: process.env.EXAMPLE_TOKENS_ID ?? "tokens", name: "AI tokens", coinName: "Tokens" });
export const small = creditPack({ id: "small", of: tokens, credits: 100, price: { amount: 1000, currency: "XOF" } });
export const ebook = license({ id: process.env.EXAMPLE_EBOOK_ID ?? "ebook", name: "The guide", devices: null, price: { amount: 3000, currency: "XOF" } });

// 4. React
export const itaja = createItaja({
  catalog: [messages, exportCsv, free, pro, small, ebook],
  on: {
    "checkout.paid": async ({ data }) => {
      console.log(`[shop] paid ${data.amount} ${data.currency} — fulfil checkout ${data.checkoutId}`);
    },
    "credits.low": async ({ data }) => {
      console.log(`[shop] customer ${data.customerId} has ${data.balance} credits left`);
    },
    "*": async (event) => {
      console.log(`[shop] received ${event.type} (${event.id})`);
    },
  },
});

export default itaja;
