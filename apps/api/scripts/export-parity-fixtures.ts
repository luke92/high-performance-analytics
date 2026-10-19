import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildParityFixture } from "./parityFixture.js";

export const FIXTURE_PATH = fileURLToPath(new URL("../../../cpp/tests/fixtures/parity.txt", import.meta.url));

mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
const text = buildParityFixture();
writeFileSync(FIXTURE_PATH, text, "utf8");
console.log(`Wrote ${FIXTURE_PATH} (${text.split("\n").length - 1} lines)`);
