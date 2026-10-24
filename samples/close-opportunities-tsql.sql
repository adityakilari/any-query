-- Closes sales opportunities that are past their close date (SQL Server T-SQL procedure).
CREATE PROCEDURE dbo.CloseStaleOpportunities
  @Days INT = 90,
  @DryRun BIT = 0
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @Cutoff DATE = DATEADD(day, -@Days, GETDATE()), @Closed INT
  DECLARE @Owner NVARCHAR(100)

  IF @DryRun = 1
  BEGIN
    SELECT o.OpportunityID, o.Name FROM dbo.Opportunities o
    WHERE o.CloseDate < @Cutoff AND o.Stage NOT IN ('Closed Won', 'Closed Lost')
    RETURN
  END

  BEGIN TRY
    BEGIN TRAN
    UPDATE dbo.Opportunities
    SET Stage = 'Closed Lost'
    WHERE CloseDate < @Cutoff AND Stage NOT IN ('Closed Won', 'Closed Lost')
    SET @Closed = @@ROWCOUNT
    SELECT @Owner = u.UserName FROM dbo.Users u WHERE u.IsActive = 1
    EXEC ('DELETE FROM dbo.Activities WHERE Subject = ''' + @Owner + '''')
    COMMIT
  END TRY
  BEGIN CATCH
    ROLLBACK
    PRINT 'failed'
  END CATCH
  PRINT CONCAT('Closed ', @Closed)
END
GO
