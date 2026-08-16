import { runWpCli } from '../lib/hostingerSsh.js';
for (const d of ['rollinginitllc.com','briarwoodsmiles.com','midwestagservices.com','intelligentanalyticsdm.com']) {
  try { const r = await runWpCli(d, 'litespeed-purge all'); console.log(d, (r.stdout||'').trim()); }
  catch (e) { console.log(d, 'ERR', (e.message||'').slice(0,100)); }
}
