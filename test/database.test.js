// Runs the samples and the review's suggested fixes in a real PostgreSQL (PGlite, in-process),
// to prove three things: formatting never changes results, the problems the review reports really
// happen, and the fixes it suggests are valid SQL that behaves as described.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { read, run, schemas } from './helpers.js';
import { formatSql } from '../src/core/format.js';

let db;
test.before(async () => {
  db = new PGlite();
  await db.exec(read('samples/schemas/ecommerce-postgres.sql'));
  await db.exec('SET search_path TO public');
  await db.exec(`
    INSERT INTO customers (id, email, first_name, last_name, password, marketing_opt_in, created_at, updated_at) VALUES
      (1, 'ann@x.io', 'Ann', 'Lee', 'h', true, now(), now()),
      (2, 'bo@x.io',  'Bo',  'Kim', 'h', true, now(), now()),
      (3, 'cy@x.io',  'Cy',  'Ray', 'h', false, now(), now());
    INSERT INTO addresses (id, customer_id, label, street, city, postal_code, country_code, is_default) VALUES
      (1, 1, 'home', 'a', 'Oslo', '1', 'NO', true), (2, 1, 'work', 'b', 'Bergen', '2', 'NO', false), (3, 2, 'home', 'c', 'Lund', '3', 'SE', true);
    INSERT INTO orders (id, customer_id, status, subtotal, tax_amount, total, currency, placed_at, shipped_at) VALUES
      (1, 1, 'shipped',   100, 0, 100, 'USD', now() - interval '10 days', now()),
      (2, 1, 'delivered',  50, 0,  50, 'USD', now() - interval '3 days',  now()),
      (3, 2, 'shipped',    70, 0,  70, 'USD', now() - interval '20 days', now()),
      (4, 2, 'pending',    10, 0,  10, 'USD', '2025-12-31 15:00+00', NULL),
      (5, 3, 'paid',       30, 0,  30, 'USD', '2025-06-01 09:00+00', NULL);
    INSERT INTO payments (id, order_id, provider, amount, status) VALUES (1, 1, 'card', 100, 'captured'), (2, 3, 'card', 70, 'failed');
    INSERT INTO products (id, sku, name, price, currency, stock_quantity, is_active, created_at) VALUES (1, 'S', 'P', 1, 'USD', 1, true, now());
    INSERT INTO reviews (id, product_id, customer_id, rating, created_at) VALUES (1, 1, 2, 1, now()), (2, 1, NULL, 1, now());
  `);
});
test.after(async () => { await db.close(); });

const rows = async (sql) => (await db.query(sql)).rows;

test('formatted SQL returns exactly the same rows', async () => {
  for (const sql of [read('samples/top-customers-postgres.sql'), read('samples/needs-review-postgres.sql').replace('o.status\n', 'MAX(o.status) AS status\n')]) {
    const a = await rows(sql);
    const b = await rows(formatSql(sql));
    assert.deepEqual(b, a);
  }
  assert.ok((await rows(read('samples/top-customers-postgres.sql'))).length > 0);
});

test('ungrouped column: PostgreSQL rejects it, as the review says', async () => {
  await assert.rejects(rows(read('samples/needs-review-postgres.sql')), /must appear in the GROUP BY clause/);
});

test('NOT IN with a NULL in the subquery returns nothing; the suggested NOT EXISTS works', async () => {
  const sql = 'SELECT c.id FROM customers c WHERE c.id NOT IN (SELECT customer_id FROM reviews WHERE rating = 1) ORDER BY 1';
  const f = run(sql, { schema: schemas.shop() }).statements[0].findings.find((x) => x.rule === 'not-in-null');
  assert.ok(f);
  assert.deepEqual(await rows(sql), []);
  const fixed = sql.replace(sql.slice(f.s, f.e), f.fixSql);
  assert.deepEqual((await rows(fixed)).map((r) => Number(r.id)), [1, 3]);
});

test('LEFT JOIN undone by WHERE drops unmatched rows; the suggested ON condition keeps them', async () => {
  const sql = "SELECT o.id FROM orders o LEFT JOIN payments p ON p.order_id = o.id WHERE p.status = 'captured' ORDER BY 1";
  const f = run(sql).statements[0].findings.find((x) => x.rule === 'left-join-undone');
  assert.deepEqual((await rows(sql)).map((r) => Number(r.id)), [1]);
  const fixed = `SELECT o.id FROM orders o ${f.fixSql} ORDER BY 1`;
  assert.deepEqual((await rows(fixed)).map((r) => Number(r.id)), [1, 2, 3, 4, 5]);
});

test('BETWEEN on a timestamp misses the last day; the suggested range does not', async () => {
  const sql = "SELECT o.id FROM orders o WHERE o.placed_at BETWEEN '2025-01-01' AND '2025-12-31' ORDER BY 1";
  const f = run(sql, { schema: schemas.shop() }).statements[0].findings.find((x) => x.rule === 'between-timestamp');
  assert.deepEqual((await rows(sql)).map((r) => Number(r.id)), [5]);
  const fixed = `SELECT o.id FROM orders o WHERE ${f.fixSql} ORDER BY 1`;
  assert.deepEqual((await rows(fixed)).map((r) => Number(r.id)), [4, 5]);
});

test('= NULL matches nothing; IS NULL does', async () => {
  const sql = 'SELECT o.id FROM orders o WHERE o.shipped_at = NULL';
  const f = run(sql).statements[0].findings.find((x) => x.rule === 'equals-null');
  assert.deepEqual(await rows(sql), []);
  assert.equal((await rows(`SELECT o.id FROM orders o WHERE ${f.fixSql}`)).length, 2);
});

test('index-friendly rewrite of EXTRACT(YEAR ...) returns the same rows', async () => {
  const sql = 'SELECT o.id FROM orders o WHERE EXTRACT(YEAR FROM o.placed_at) = 2025 ORDER BY 1';
  const f = run(sql).statements[0].findings.find((x) => x.rule === 'function-on-column');
  assert.deepEqual(await rows(`SELECT o.id FROM orders o WHERE ${f.fixSql} ORDER BY 1`), await rows(sql));
});

test('division fix returns NULL instead of failing', async () => {
  await assert.rejects(rows('SELECT 1 / (total - total) FROM orders'), /division by zero/);
  const f = run('SELECT o.total / o.tax_amount FROM orders o').statements[0].findings.find((x) => x.rule === 'division-by-zero');
  assert.equal((await rows(`SELECT ${f.fixSql} AS r FROM orders o`))[0].r, null);
});

test('the explanation matches what the query returns', async () => {
  // "one row per address (so each customer can appear several times)": customer 1 has two addresses
  const sql = read('samples/top-customers-postgres.sql').replace('AND a.is_default', '');
  const st = run(sql).statements[0];
  assert.match(st.grain, /one row per address/);
  const r = await rows(sql);
  assert.equal(r.filter((x) => x.email === 'ann@x.io').length, 2);
});

test('PL/pgSQL sample runs, and the problems the review reports really happen', async () => {
  const pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA docs;
    CREATE TABLE docs.categories (id bigint PRIMARY KEY, name text);
    CREATE TABLE docs.document_types (id bigint PRIMARY KEY, category_id bigint, name text);
    CREATE TABLE docs.documents (id serial PRIMARY KEY, external_key text, file_name text, url text, folder text, type_id bigint, created_at timestamptz, is_active boolean DEFAULT true);
    INSERT INTO docs.categories VALUES (1, 'Tax'), (2, 'Legal');
    INSERT INTO docs.document_types VALUES (10, 1, 'returns'), (20, 2, 'contracts'), (21, 2, 'returns');
  `);
  await pg.exec(read('samples/import-documents-plpgsql.sql'));
  const payload = JSON.stringify({ items: [
    { id: 'A1', file_name: 'a.pdf', url: 'returns/a.pdf', category: 'Tax' },
    { id: 'B2', file_name: 'b.pdf', url: 'returns/b.pdf' },
  ] });
  const res = (await pg.query('SELECT external_key, folder, type_id, url FROM docs.import_documents($1) ORDER BY 1', [payload])).rows;
  assert.deepEqual(res.map((r) => r.external_key), ['A1', 'B2']);
  assert.equal(res[0].folder, 'returns');            // "the part of v_url before the first /"
  assert.equal(res[0].url, 'returns/a.pdf');         // the no-op UPDATE changed nothing
  assert.equal(res[1].type_id, null);                // category 'Other' has no type, and the
  // fallback UPDATE never fills it because v_parent_id is always NULL, as the review says
  const st = run(read('samples/import-documents-plpgsql.sql')).statements[0];
  assert.ok(st.findings.some((f) => f.rule === 'unassigned-variable' && /v_parent_id/.test(f.title)));
  await pg.close();
});
