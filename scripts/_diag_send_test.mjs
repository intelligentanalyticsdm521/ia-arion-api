// Send a real email through WordPress on the sandbox and report the result.
//
// The PHP is base64'd and decoded on the box, then run with `wp eval-file`.
// Inlining PHP into `wp eval` over SSH means two layers of quoting (shell then
// PHP) and it mangles every time — see the shQuote fix in hostingerSsh.js.
import { runSshCommand } from '../lib/hostingerSsh.js';

const D = 'azure-coyote-795824.hostingersite.com';
const TO = process.argv[2] || 'brandonsheriff+coldstart@gmail.com';

const php = `<?php
add_action('wp_mail_failed', function ($e) {
  echo "WPMAIL_ERROR: " . $e->get_error_message() . "\\n";
});
$ok = wp_mail(
  ${JSON.stringify(TO)},
  "IA SMTP verification",
  "Sent from the Cold Start sandbox to verify Hostinger SMTP."
);
echo $ok ? "WPMAIL_OK\\n" : "WPMAIL_FAILED\\n";
`;

const b64 = Buffer.from(php, 'utf8').toString('base64');
const remote = '/tmp/ia-smtp-test.php';
const cmd =
  `cd ~/domains/${D}/public_html && ` +
  `echo ${b64} | base64 -d > ${remote} && ` +
  `wp eval-file ${remote}; rm -f ${remote}`;

const r = await runSshCommand(cmd);
const out = (r.stdout || '').toString().trim();
const err = (r.stderr || '').toString().trim();
console.log(out || '(no stdout)');
if (err) console.log('stderr: ' + err.slice(0, 900));
process.exit(0);
