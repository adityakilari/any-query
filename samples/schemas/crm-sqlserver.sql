USE [CRM]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Accounts](
	[AccountID] [int] IDENTITY(1,1) NOT NULL,
	[AccountName] [nvarchar](200) NOT NULL,
	[Industry] [nvarchar](100) NULL,
	[AnnualRevenue] [money] NULL,
	[Website] [nvarchar](255) NULL,
	[OwnerUserID] [int] NOT NULL,
	[CreatedDate] [datetime2](7) NOT NULL,
	[ModifiedDate] [datetime2](7) NULL,
 CONSTRAINT [PK_Accounts] PRIMARY KEY CLUSTERED
(
	[AccountID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
) ON [PRIMARY]
GO
CREATE TABLE [dbo].[Contacts](
	[ContactID] [int] IDENTITY(1,1) NOT NULL,
	[AccountID] [int] NULL,
	[FirstName] [nvarchar](100) NOT NULL,
	[LastName] [nvarchar](100) NOT NULL,
	[Email] [nvarchar](255) NULL,
	[Phone] [varchar](30) NULL,
	[JobTitle] [nvarchar](100) NULL,
	[IsPrimary] [bit] NOT NULL,
	[CreatedDate] [datetime2](7) NOT NULL,
 CONSTRAINT [PK_Contacts] PRIMARY KEY CLUSTERED ([ContactID] ASC)
) ON [PRIMARY]
GO
CREATE TABLE [dbo].[Opportunities](
	[OpportunityID] [int] IDENTITY(1,1) NOT NULL,
	[AccountID] [int] NOT NULL,
	[PrimaryContactID] [int] NULL,
	[Name] [nvarchar](200) NOT NULL,
	[Stage] [nvarchar](50) NOT NULL,
	[Amount] [decimal](18, 2) NULL,
	[Probability] [float] NULL,
	[CloseDate] [date] NULL,
	[ExpectedRevenue]  AS ([Amount]*[Probability]/(100)) PERSISTED,
	[OwnerUserID] [int] NOT NULL,
	[CreatedDate] [datetime2](7) NOT NULL,
 CONSTRAINT [PK_Opportunities] PRIMARY KEY CLUSTERED ([OpportunityID] ASC)
) ON [PRIMARY]
GO
CREATE TABLE [dbo].[Users](
	[UserID] [int] IDENTITY(1,1) NOT NULL,
	[UserName] [nvarchar](100) NOT NULL,
	[Email] [nvarchar](255) NOT NULL,
	[IsActive] [bit] NOT NULL,
 CONSTRAINT [PK_Users] PRIMARY KEY CLUSTERED ([UserID] ASC),
 CONSTRAINT [UQ_Users_Email] UNIQUE NONCLUSTERED ([Email] ASC)
) ON [PRIMARY]
GO
CREATE TABLE [dbo].[Activities](
	[ActivityID] [bigint] IDENTITY(1,1) NOT NULL,
	[OpportunityID] [int] NULL,
	[ContactID] [int] NULL,
	[ActivityType] [nvarchar](20) NOT NULL,
	[Subject] [nvarchar](255) NOT NULL,
	[DueDate] [datetime2](7) NULL,
	[CompletedDate] [datetime2](7) NULL,
 CONSTRAINT [PK_Activities] PRIMARY KEY CLUSTERED ([ActivityID] ASC)
) ON [PRIMARY]
GO
ALTER TABLE [dbo].[Accounts] ADD  CONSTRAINT [DF_Accounts_CreatedDate]  DEFAULT (sysutcdatetime()) FOR [CreatedDate]
GO
ALTER TABLE [dbo].[Contacts] ADD  DEFAULT ((0)) FOR [IsPrimary]
GO
ALTER TABLE [dbo].[Contacts]  WITH CHECK ADD  CONSTRAINT [FK_Contacts_Accounts] FOREIGN KEY([AccountID])
REFERENCES [dbo].[Accounts] ([AccountID])
GO
ALTER TABLE [dbo].[Contacts] CHECK CONSTRAINT [FK_Contacts_Accounts]
GO
ALTER TABLE [dbo].[Opportunities]  WITH CHECK ADD  CONSTRAINT [FK_Opportunities_Accounts] FOREIGN KEY([AccountID])
REFERENCES [dbo].[Accounts] ([AccountID])
ON DELETE CASCADE
GO
ALTER TABLE [dbo].[Opportunities]  WITH CHECK ADD  CONSTRAINT [FK_Opportunities_Contacts] FOREIGN KEY([PrimaryContactID])
REFERENCES [dbo].[Contacts] ([ContactID])
GO
ALTER TABLE [dbo].[Accounts]  WITH CHECK ADD  CONSTRAINT [FK_Accounts_Users] FOREIGN KEY([OwnerUserID])
REFERENCES [dbo].[Users] ([UserID])
GO
ALTER TABLE [dbo].[Activities]  WITH CHECK ADD  CONSTRAINT [FK_Activities_Opportunities] FOREIGN KEY([OpportunityID])
REFERENCES [dbo].[Opportunities] ([OpportunityID])
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Companies we sell to or partner with.' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'Accounts'
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Sales stage: Prospecting, Qualification, Proposal, Negotiation, Closed Won, Closed Lost.' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'Opportunities', @level2type=N'COLUMN',@level2name=N'Stage'
GO
