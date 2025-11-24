# 🚨 URGENT: Run This Migration Now

## Problem
The database constraint doesn't allow the 'submitted' status, causing errors when submitting work.

## Solution
Run the migration to add 'submitted' to the allowed status values.

## Steps to Fix

### 1. Open Supabase SQL Editor
1. Go to your Supabase dashboard: https://supabase.com
2. Select your AlgoEase project
3. Click **"SQL Editor"** in the left sidebar
4. Click **"New query"**

### 2. Copy and Run This SQL

Copy the entire contents of `RUN_THIS_MIGRATION.sql` and paste it into the SQL editor, then click **"Run"**.

Or copy this directly:

```sql
-- Drop the existing check constraint
ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_status_check;

-- Add the new check constraint with 'submitted' status (V5 contract)
ALTER TABLE bounties ADD CONSTRAINT bounties_status_check 
  CHECK (status IN ('open', 'accepted', 'submitted', 'approved', 'claimed', 'refunded', 'rejected'));
```

### 3. Verify It Worked

Run this query to verify:

```sql
SELECT conname, pg_get_constraintdef(oid) as constraint_definition
FROM pg_constraint
WHERE conrelid = 'bounties'::regclass
AND conname = 'bounties_status_check';
```

You should see `'submitted'` in the list of allowed statuses.

### 4. Test
After running the migration, try submitting work again. The error should be resolved!

## Quick Copy-Paste SQL

```sql
ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_status_check;
ALTER TABLE bounties ADD CONSTRAINT bounties_status_check 
  CHECK (status IN ('open', 'accepted', 'submitted', 'approved', 'claimed', 'refunded', 'rejected'));
```

