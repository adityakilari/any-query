-- A customer report with several common mistakes. Open the Review tab to see them.
-- Schema: samples/schemas/ecommerce-postgres.sql
SELECT c.id,
       c.email,
       c.first_name,
       COUNT(o.id)   AS orders,
       SUM(p.amount) AS paid,
       o.status
FROM customers c, orders o
LEFT JOIN payments p ON p.order_id = o.id
WHERE c.id = o.customer_id
  AND p.status = 'captured'
  AND o.shipped_at = NULL
  AND EXTRACT(YEAR FROM o.placed_at) = 2025
  AND c.id NOT IN (SELECT customer_id FROM reviews WHERE rating = 1)
  AND o.placed_at BETWEEN '2025-01-01' AND '2025-12-31'
GROUP BY c.id, c.email
ORDER BY 4 DESC
LIMIT 50;
