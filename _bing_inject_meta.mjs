import { runSshCommand } from './lib/hostingerSsh.js';

const DOMAIN = 'rollinginitllc.com';
const BING_CODE = '7D316DF7130CE1E21E43BA0E552B8313';
const META_TAG = `<meta name="msvalidate.01" content="${BING_CODE}" />`;

const muPluginContent = `<?php
/**
 * Plugin Name: IA Bing WMT Verification
 * Description: Injects Bing Webmaster Tools site verification meta tag (msvalidate.01).
 * Version: 1.0.0
 */
add_action('wp_head', function() {
    echo '${META_TAG}' . "\n";
}, 1);
`;

const ensureDir = `mkdir -p ~/domains/${DOMAIN}/public_html/wp-content/mu-plugins`;
console.log('Ensuring mu-plugins dir...');
const r1 = await runSshCommand(ensureDir);
console.log('  exit:', r1.code);

const filepath = `~/domains/${DOMAIN}/public_html/wp-content/mu-plugins/ia-bing-verification.php`;
const writeCmd = `cat > ${filepath} <<'IAEOF'
${muPluginContent}
IAEOF`;
console.log('\nWriting mu-plugin...');
const r2 = await runSshCommand(writeCmd);
console.log('  exit:', r2.code);

const verify = `cat ${filepath}`;
console.log('\nVerifying file contents:');
const r3 = await runSshCommand(verify);
console.log(r3.stdout);

console.log('\nFetching live homepage to confirm tag...');
const fetchRes = await fetch('https://rollinginitllc.com/?_cb=' + Date.now());
const html = await fetchRes.text();
const hasTag = html.includes(BING_CODE);
console.log('  tag present in live HTML:', hasTag);
if (!hasTag) {
  const headStart = html.indexOf('<head');
  const headEnd = html.indexOf('</head>');
  console.log('  HTML head excerpt:', html.slice(headStart, headEnd + 7).slice(0, 1500));
}
