/** `npm run native:check`: loads the addon and runs a tiny end-to-end smoke test. Exits 1 on any problem. */
import { computeAnalytics, generateEvents } from "../src/analytics/index.js";
import { getNativeStatus } from "../src/native/loader.js";
import { nativeComputeAnalytics, nativeGenerateEvents } from "../src/native/nativeEngine.js";

const status = getNativeStatus();
if (!status.available) {
  console.error(`Native addon unavailable (${status.reason}). Build it with: npm run native:build`);
  process.exit(1);
}

const options = { seed: 42, count: 1000 };
const nativeEvents = nativeGenerateEvents(options);
const tsEvents = generateEvents(options);
const same =
  JSON.stringify(nativeEvents) === JSON.stringify(tsEvents) &&
  JSON.stringify(nativeComputeAnalytics(nativeEvents)) === JSON.stringify(computeAnalytics(tsEvents));
if (!same) {
  console.error("Native and TypeScript engines disagree on the smoke dataset");
  process.exit(1);
}
console.log(`Native addon OK: core ${status.coreVersion}, Node-API ${status.napiVersion}; matches TypeScript on 1000 events.`);
