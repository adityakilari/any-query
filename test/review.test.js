import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, run, read, schemas } from './helpers.js';

const has = (sql, rule, opts) => rules(sql, opts).includes(rule);

test('each rule fires on its pattern and not on the corrected query', () => {
  const cases = [
    ['missing-join-condition', 'SELECT * FROM orders o, customers c', 'SELECT * FROM orders o CROSS JOIN customers c'],
    ['missing-join-condition', 'SELECT * FROM orders o, customers c WHERE o.total > 10', 'SELECT * FROM orders o, customers c WHERE o.customer_id = c.id'],
    ['left-join-undone', "SELECT o.id FROM orders o LEFT JOIN payments p ON p.order_id = o.id WHERE p.status = 'ok'", "SELECT o.id FROM orders o LEFT JOIN payments p ON p.order_id = o.id AND p.status = 'ok'"],
    ['not-in-null', 'SELECT id FROM customers WHERE id NOT IN (SELECT customer_id FROM reviews)', 'SELECT id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM reviews r WHERE r.customer_id = c.id)'],
    ['equals-null', 'SELECT id FROM orders WHERE shipped_at = NULL', 'SELECT id FROM orders WHERE shipped_at IS NULL'],
    ['ungrouped-column', 'SELECT customer_id, status, COUNT(*) FROM orders GROUP BY customer_id', 'SELECT customer_id, status, COUNT(*) FROM orders GROUP BY customer_id, status'],
    ['aggregate-in-where', 'SELECT customer_id FROM orders WHERE COUNT(*) > 1 GROUP BY customer_id', 'SELECT customer_id FROM orders GROUP BY customer_id HAVING COUNT(*) > 1'],
    ['limit-without-order', 'SELECT id FROM orders LIMIT 10', 'SELECT id FROM orders ORDER BY placed_at DESC LIMIT 10'],
    ['between-timestamp', "SELECT id FROM orders WHERE placed_at BETWEEN '2025-01-01' AND '2025-01-31'", "SELECT id FROM orders WHERE placed_at >= '2025-01-01' AND placed_at < '2025-02-01'"],
    ['function-on-column', 'SELECT id FROM orders WHERE YEAR(placed_at) = 2024', "SELECT id FROM orders WHERE placed_at >= '2024-01-01' AND placed_at < '2025-01-01'"],
    ['row-number-without-order', 'SELECT ROW_NUMBER() OVER (PARTITION BY a) FROM t', 'SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) FROM t'],
    ['unused-cte', 'WITH a AS (SELECT 1 x), b AS (SELECT 2 y) SELECT * FROM a', 'WITH a AS (SELECT 1 x) SELECT * FROM a'],
    ['update-without-where', 'UPDATE orders SET status = 1', 'UPDATE orders SET status = 1 WHERE id = 5'],
    ['unknown-alias', 'SELECT x.id FROM orders o', 'SELECT o.id FROM orders o'],
    ['window-in-where', 'SELECT id FROM t WHERE ROW_NUMBER() OVER (ORDER BY id) = 1', 'SELECT id FROM t QUALIFY ROW_NUMBER() OVER (ORDER BY id) = 1'],
    ['correlated-subquery', 'SELECT c.id, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) FROM customers c', 'SELECT c.id, COUNT(o.id) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id'],
    ['distinct-hides-join', 'SELECT DISTINCT c.id FROM customers c JOIN orders o ON o.customer_id = c.id', 'SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)'],
    ['having-without-aggregate', "SELECT status, COUNT(*) FROM orders GROUP BY status HAVING status <> 'x'", "SELECT status, COUNT(*) FROM orders WHERE status <> 'x' GROUP BY status"],
    ['not-in-null-literal', 'SELECT id FROM t WHERE a NOT IN (1, NULL)', 'SELECT id FROM t WHERE a NOT IN (1, 2)'],
    ['nolock', 'SELECT a FROM t WITH (NOLOCK)', 'SELECT a FROM t'],
    ['division-by-zero', 'SELECT a / b FROM t', 'SELECT a / NULLIF(b, 0) FROM t'],
    ['rownum-order', 'SELECT id FROM t WHERE ROWNUM <= 5 ORDER BY id', 'SELECT id FROM t ORDER BY id FETCH FIRST 5 ROWS ONLY'],
    ['alias-in-where', 'SELECT price * qty AS line_total FROM items WHERE line_total > 100', 'SELECT price * qty AS line_total FROM items WHERE price * qty > 100'],
    ['ordinal-reference', 'SELECT a, COUNT(*) FROM t GROUP BY 1', 'SELECT a, COUNT(*) FROM t GROUP BY a'],
    ['union-distinct', 'SELECT a FROM t UNION SELECT a FROM u', 'SELECT a FROM t UNION ALL SELECT a FROM u'],
  ];
  for (const [rule, bad, good] of cases) {
    assert.ok(has(bad, rule), `${rule} should fire on: ${bad}\n got ${rules(bad)}`);
    assert.ok(!has(good, rule), `${rule} should not fire on: ${good}`);
  }
});

test('schema-based checks', () => {
  const schema = schemas.shop();
  assert.ok(has('SELECT emial FROM customers', 'unknown-column', { schema }));
  const f = run('SELECT emial FROM customers', { schema }).statements[0].findings[0];
  assert.match(f.fix, /Did you mean `email`/);
  assert.ok(has('SELECT id FROM custmers', 'unknown-table', { schema }));
  assert.ok(has('SELECT id FROM customers c JOIN orders o ON o.customer_id = c.id', 'ambiguous-column', { schema }));
  assert.ok(!has('SELECT c.id FROM customers c JOIN orders o ON o.customer_id = c.id', 'ambiguous-column', { schema }));
  // NOT IN on a NOT NULL primary key is safe
  assert.ok(!has('SELECT id FROM orders WHERE customer_id NOT IN (SELECT id FROM customers)', 'not-in-null', { schema }));
});

test('no false alarms on the clean samples', () => {
  assert.deepEqual(rules(read('samples/top-customers-postgres.sql'), { schema: schemas.shop() }), []);
  assert.deepEqual(rules(read('samples/housekeeping-mysql.sql')), []);
});

test('the review sample finds every planted mistake', () => {
  const found = rules(read('samples/needs-review-postgres.sql'), { schema: schemas.shop() });
  for (const r of ['ungrouped-column', 'left-join-undone', 'equals-null', 'not-in-null', 'function-on-column', 'between-timestamp']) assert.ok(found.includes(r), r);
});

test('findings carry line numbers and ready-to-run fixes', () => {
  const f = run(read('samples/needs-review-postgres.sql'), { schema: schemas.shop() }).statements[0].findings;
  const notIn = f.find((x) => x.rule === 'not-in-null');
  assert.equal(notIn.line, 15);
  assert.equal(notIn.fixSql, 'NOT EXISTS (SELECT 1 FROM reviews WHERE reviews.customer_id = c.id AND rating = 1)');
  assert.equal(f.find((x) => x.rule === 'between-timestamp').fixSql, "o.placed_at >= '2025-01-01' AND o.placed_at < '2026-01-01'");
});
