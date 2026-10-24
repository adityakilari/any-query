-- Housekeeping (MySQL): archive orders older than two years, flag their customers, then delete them.
INSERT INTO orders_archive (id, customer_id, total, placed_at)
SELECT id, customer_id, total, placed_at
FROM orders
WHERE placed_at < DATE_SUB(CURDATE(), INTERVAL 2 YEAR);

UPDATE customers c
JOIN orders o ON o.customer_id = c.id
SET c.updated_at = NOW()
WHERE o.placed_at < DATE_SUB(CURDATE(), INTERVAL 2 YEAR);

DELETE FROM orders
WHERE placed_at < DATE_SUB(CURDATE(), INTERVAL 2 YEAR);
