import test from 'node:test';
import assert from 'node:assert/strict';
import { first, run, text, read, schemas } from './helpers.js';

test('grain: grouping, top-N per group, joins that repeat rows', () => {
  assert.equal(first('SELECT customer_id, COUNT(*) FROM orders GROUP BY customer_id').grain, 'one row per customer');
  assert.equal(first('SELECT COUNT(*) FROM orders').grain, 'a single summary row');
  assert.equal(first("SELECT * FROM (SELECT o.*, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY placed_at DESC) rn FROM orders o) x WHERE rn = 1").grain, 'the most recent order per customer');
  assert.equal(first('SELECT c.id, o.id FROM customers c JOIN orders o ON o.customer_id = c.id').grain, 'one row per order (so each customer can appear several times)');
  assert.equal(first('SELECT o.id, c.email FROM orders o JOIN customers c ON c.id = o.customer_id').grain, 'one row per order');
  assert.equal(first("SELECT DATE_TRUNC('month', placed_at), SUM(total) FROM orders GROUP BY 1").grain, 'one row per month');
});

test('joins are described with their effect on rows', () => {
  const t = text(first('SELECT o.id FROM orders o LEFT JOIN customers c ON c.id = o.customer_id'));
  assert.match(t, /Looks up each order's customer from `customers`/);
  assert.match(t, /Orders without one are kept/);
  const t2 = text(first('SELECT c.id FROM customers c JOIN orders o ON o.customer_id = c.id'));
  assert.match(t2, /from here on there is one row per order/);
  assert.match(t2, /Customers with no orders are left out/);
  const t3 = text(first('SELECT o.id FROM orders o LEFT JOIN addresses a ON a.id = o.shipping_address_id'));
  assert.match(t3, /shipping address \(address from `addresses`\)/);
});

test('relative dates in plain words', () => {
  const t = (w) => text(first(`SELECT id FROM orders WHERE ${w}`));
  assert.match(t("placed_at >= CURRENT_DATE - INTERVAL '90 days'"), /placed at is on or after 90 days ago/);
  assert.match(t('placed_at > DATEADD(day, -7, GETDATE())'), /placed at is after 7 days ago/);
  assert.match(t('placed_at < DATE_SUB(CURDATE(), INTERVAL 2 YEAR)'), /placed at is before 2 years ago/);
  assert.match(t('TRUNC(placed_at) = TRUNC(SYSDATE) - 1'), /placed at is yesterday/);
  assert.match(t("placed_at >= DATE_TRUNC('month', NOW())"), /on or after the start of this month/);
});

test('conditions: IN, LIKE, NULL, EXISTS', () => {
  const t = text(first("SELECT c.id FROM customers c WHERE c.email LIKE '%@example.com' AND c.phone IS NOT NULL AND c.country IN ('DE','FR') AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'paid')"));
  assert.match(t, /email ends with “@example.com”/);
  assert.match(t, /phone has a value/);
  assert.match(t, /country is “DE” or “FR”/);
  assert.match(t, /the customer has at least one order where status is “paid”/);
});

test('aggregates and windows', () => {
  const st = first("SELECT customer_id, COUNT(*) AS n, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid, MAX(placed_at) AS last_at, SUM(total) OVER (PARTITION BY customer_id ORDER BY placed_at) AS running FROM orders GROUP BY customer_id, total, placed_at");
  const byName = Object.fromEntries(st.outputs.map((o) => [o.name, o.text]));
  assert.equal(byName.n, 'The number of orders');
  assert.equal(byName.paid, 'The number of orders where status is “paid”');
  assert.equal(byName.last_at, 'The latest placed at');
  assert.match(byName.running, /^The running total of total within each customer, ordered by placed at \(oldest first\)/);
});

test('lineage traces columns through CTEs', () => {
  const st = first(read('samples/top-customers-postgres.sql'));
  const o = Object.fromEntries(st.outputs.map((x) => [x.name, x.origins]));
  assert.deepEqual(o.revenue, ['orders.total']);
  assert.deepEqual(o.order_count, ['orders (row count)']);
  assert.deepEqual(o.customer_name, ['customers.first_name', 'customers.last_name']);
  assert.equal(st.steps.length, 3);
});

test('schema adds documented meanings and expands *', () => {
  const st = first('SELECT * FROM customers', { schema: schemas.shop() });
  assert.ok(st.outputs.length > 5);
  assert.ok(st.outputs.find((o) => o.name === 'email').detail.includes('Email'));
});

test('DML and multi-statement files', () => {
  const r = run(read('samples/housekeeping-mysql.sql'));
  assert.deepEqual(r.statements.map((s) => s.title), ['Insert into orders_archive', 'Update customers', 'Delete from orders']);
  assert.match(r.statements[1].summary[0], /Changes `updated_at` to now in `customers`/);
  assert.match(first('DELETE FROM sessions').summary[0], /Deletes every row in `sessions`/);
});

test('Oracle sample reads naturally', () => {
  const st = first(read('samples/inpatients-oracle.sql'), { schema: schemas.clinic() });
  const t = text(st);
  assert.match(t, /encounter admit datetime is yesterday/);
  assert.match(t, /attending provider \(provider from `CLINIC.PRV`\)/);
  assert.match(t, /Stops after the first 100 rows it finds \(ROWNUM\), before sorting/);
  assert.equal(st.outputs.find((o) => o.name === 'order_count').text, 'The number of orders for this encounter');
});
