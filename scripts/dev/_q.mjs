import 'dotenv/config';
import { getServicesPool } from '../../db/servicesPool.js';
const pool = await getServicesPool();
const q = process.argv.slice(2).join(' ');
const r = await pool.request().query(q);
console.log(JSON.stringify(r.recordset, null, 1));
process.exit(0);
