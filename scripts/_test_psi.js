import { runPageSpeedTest } from "../lib/pagespeed.js";

console.log("Testing Google PSI for intelligentanalyticsdm.com (mobile)...");
const start = Date.now();
const result = await runPageSpeedTest("https://intelligentanalyticsdm.com", "mobile");
console.log(`Took ${((Date.now() - start) / 1000).toFixed(1)}s`);
if (!result) {
  console.log("✗ PSI returned NULL — fetch failed or threw");
} else {
  console.log("✓ PSI succeeded");
  console.log("Mobile performance score:", result.scores?.performance);
  console.log("LCP:", result.metrics?.lcp);
  console.log("CLS:", result.metrics?.cls);
  console.log("CrUX origin available:", !!result.field_origin);
  console.log("Opportunities:", result.opportunities?.length || 0);
}
