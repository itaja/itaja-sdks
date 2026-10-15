import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SDK_VERSION } from "../src/index.js";

it("SDK_VERSION equals package.json (it goes out in x-itaja-client)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(SDK_VERSION).toBe(pkg.version);
});
