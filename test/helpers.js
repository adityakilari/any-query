import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSql } from '../src/core/index.js';
import { loadSchema } from '../src/core/schema.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
export const schemas = {
  shop: () => loadSchema(read('samples/schemas/ecommerce-postgres.sql'), 'ecommerce-postgres.sql'),
  clinic: () => loadSchema(read('samples/schemas/clinic-oracle-columns.json'), 'clinic-oracle-columns.json'),
  crm: () => loadSchema(read('samples/schemas/crm-sqlserver.sql'), 'crm-sqlserver.sql'),
};
export const run = (sql, opts = {}) => analyzeSql(sql, opts);
export const first = (sql, opts) => run(sql, opts).statements[0];
export const text = (st) => [...st.summary, ...st.steps.flatMap((s) => s.lines.flatMap((l) => [l.text, ...(l.items || []).map((i) => i.text)]))].join('\n');
export const rules = (sql, opts) => run(sql, opts).statements.flatMap((s) => s.findings.map((f) => f.rule));
