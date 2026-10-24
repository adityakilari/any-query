-- Monthly revenue with month-over-month change and a running total (Snowflake).
WITH monthly AS (
    SELECT DATE_TRUNC('month', placed_at)  AS month,
           SUM(total)                      AS revenue,
           COUNT(DISTINCT customer_id)     AS customers
    FROM orders
    WHERE status <> 'cancelled'
    GROUP BY 1
)
SELECT month,
       revenue,
       customers,
       revenue - LAG(revenue) OVER (ORDER BY month) AS change_vs_last_month,
       ROUND(100 * (revenue / NULLIF(LAG(revenue) OVER (ORDER BY month), 0) - 1), 1) AS pct_change,
       SUM(revenue) OVER (ORDER BY month ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_revenue
FROM monthly
ORDER BY month;

-- Each customer's first order, using QUALIFY to keep one row per customer.
SELECT customer_id,
       id AS first_order_id,
       placed_at
FROM orders
QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY placed_at) = 1;
