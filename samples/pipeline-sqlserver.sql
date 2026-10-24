-- Open sales pipeline per account, with the next open activity on each deal (SQL Server).
-- Schema: samples/schemas/crm-sqlserver.sql
SELECT TOP 25
       u.UserName                              AS Owner,
       a.AccountName,
       COUNT(DISTINCT o.OpportunityID)         AS OpenDeals,
       SUM(o.Amount * o.Probability / 100.0)   AS WeightedPipeline,
       MIN(o.CloseDate)                        AS NextClose,
       MAX(na.Subject)                         AS NextActivity
FROM dbo.Opportunities o WITH (NOLOCK)
INNER JOIN dbo.Accounts a ON a.AccountID = o.AccountID
INNER JOIN dbo.Users u ON u.UserID = o.OwnerUserID
OUTER APPLY (
    SELECT TOP 1 act.Subject
    FROM dbo.Activities act
    WHERE act.OpportunityID = o.OpportunityID
      AND act.CompletedDate IS NULL
    ORDER BY act.DueDate
) na
WHERE o.Stage NOT IN ('Closed Won', 'Closed Lost')
  AND o.CloseDate < DATEADD(month, 3, GETDATE())
  AND u.IsActive = 1
GROUP BY u.UserName, a.AccountName
ORDER BY WeightedPipeline DESC;
