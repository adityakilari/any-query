-- Top customers by lifetime value over the last 90 days, with their most recent order.
-- Runs against samples/ecommerce-postgres.sql from Any Schema.
WITH shipped_orders AS (
    SELECT o.customer_id,
           COUNT(*)            AS order_count,
           SUM(o.total)        AS revenue,
           MAX(o.placed_at)    AS last_order_at
    FROM orders o
    WHERE o.status IN ('shipped', 'delivered')
      AND o.placed_at >= CURRENT_DATE - INTERVAL '90 days'
    GROUP BY o.customer_id
),
latest_order AS (
    SELECT o.customer_id, o.id AS order_id, o.total,
           ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.placed_at DESC) AS rn
    FROM orders o
)
SELECT c.email,
       c.first_name || ' ' || c.last_name AS customer_name,
       s.order_count,
       s.revenue,
       ROUND(s.revenue / s.order_count, 2) AS avg_order_value,
       lo.order_id AS latest_order_id,
       a.city
FROM customers c
JOIN shipped_orders s ON s.customer_id = c.id
LEFT JOIN latest_order lo ON lo.customer_id = c.id AND lo.rn = 1
LEFT JOIN addresses a ON a.customer_id = c.id AND a.is_default
WHERE c.deleted_at IS NULL
  AND c.marketing_opt_in
ORDER BY s.revenue DESC
LIMIT 20;
