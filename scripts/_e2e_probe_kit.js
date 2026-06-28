// Probe the wp-cli flow for elementor kit settings on the test site.
import { runWpCli } from '../lib/hostingerSsh.js';

const TEST_DOMAIN = process.env.TEST_DOMAIN || 'arion-test14.intelligentanalyticsdm.com';

async function main() {
  console.log(`\n=== Probing ${TEST_DOMAIN} ===\n`);

  // 1. Get active kit ID
  let kitId;
  try {
    const r = await runWpCli(TEST_DOMAIN, `option get elementor_active_kit`);
    kitId = String((r.stdout || '').trim());
    console.log('elementor_active_kit:', JSON.stringify(kitId));
  } catch (e) {
    console.log('option get failed:', e.message);
    process.exit(1);
  }

  // 2. Get current kit settings
  console.log('\n=== post meta get (current state) ===');
  try {
    const r = await runWpCli(TEST_DOMAIN, `post meta get ${kitId} _elementor_page_settings --format=json`);
    console.log('exit code:', r.code);
    console.log('stdout (raw):', JSON.stringify(r.stdout));
    console.log('stderr (raw):', JSON.stringify(r.stderr));
  } catch (e) {
    console.log('post meta get THREW');
    console.log('  message:', e.message);
    console.log('  stdout:', JSON.stringify(e.stdout));
    console.log('  stderr:', JSON.stringify(e.stderr));
    console.log('  code:', e.code);
  }

  // 3. List all meta on the kit
  console.log('\n=== post meta list ===');
  try {
    const r = await runWpCli(TEST_DOMAIN, `post meta list ${kitId}`);
    console.log(r.stdout);
  } catch (e) {
    console.log('FAILED:', e.message);
  }

  // 4. Direct DB peek at settings via wp option (Elementor stores some defaults)
  console.log('\n=== wp eval (read settings via PHP) ===');
  try {
    const r = await runWpCli(TEST_DOMAIN, `eval 'echo json_encode(get_post_meta(${kitId}, "_elementor_page_settings", true));'`);
    console.log('result:', r.stdout);
  } catch (e) {
    console.log('FAILED:', e.message);
  }

  // 5. Check if Elementor is even active
  console.log('\n=== wp plugin status elementor ===');
  try {
    const r = await runWpCli(TEST_DOMAIN, `plugin status elementor`);
    console.log(r.stdout);
  } catch (e) {
    console.log('FAILED:', e.message);
  }
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
