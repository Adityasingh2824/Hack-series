# 🚨 URGENT: Run Database Migration

## Error
```
Could not find the 'create_transaction_id' column of 'bounties' in the schema cache
```

## Solution: Run the Migration in Supabase

### Step 1: Open Supabase SQL Editor
1. Go to your Supabase project dashboard: https://supabase.com/dashboard
2. Select your project
3. Click on **SQL Editor** in the left sidebar
4. Click **New Query**

### Step 2: Run the Migration
1. Copy the entire contents of `backend/migrations/add_transaction_ids.sql`
2. Paste it into the SQL Editor
3. Click **Run** (or press Ctrl+Enter / Cmd+Enter)

### Step 3: Verify the Migration
After running the migration, verify it worked by running this query:

```sql
-- Check if all transaction_id columns exist
SELECT column_name, data_type, is_nullable, character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'bounties' 
AND column_name LIKE '%transaction_id%'
ORDER BY column_name;
```

You should see these columns:
- `create_transaction_id`
- `accept_transaction_id`
- `approve_transaction_id`
- `reject_transaction_id`
- `claim_transaction_id`
- `refund_transaction_id`

### Step 4: Restart Your Backend
After running the migration, **restart your backend server** to clear the schema cache:

```bash
# Stop the backend (Ctrl+C)
# Then restart it
cd backend
npm start
```

### Step 5: Test
Try creating a bounty again. The error should be resolved.

---

## Quick Copy-Paste Migration

If you need the migration SQL quickly, here it is:

```sql
-- Add transaction_id columns safely (only if they don't exist)
DO $$ 
BEGIN
    -- Create transaction ID
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public'
        AND table_name = 'bounties' 
        AND column_name = 'create_transaction_id'
    ) THEN
        ALTER TABLE bounties ADD COLUMN create_transaction_id VARCHAR(64) NULL;
        RAISE NOTICE 'Added create_transaction_id column';
    END IF;
    
    -- Accept transaction ID
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public'
        AND table_name = 'bounties' 
        AND column_name = 'accept_transaction_id'
    ) THEN
        ALTER TABLE bounties ADD COLUMN accept_transaction_id VARCHAR(64) NULL;
    END IF;

    -- Approve transaction ID
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public'
        AND table_name = 'bounties' 
        AND column_name = 'approve_transaction_id'
    ) THEN
        ALTER TABLE bounties ADD COLUMN approve_transaction_id VARCHAR(64) NULL;
    END IF;

    -- Reject transaction ID
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public'
        AND table_name = 'bounties' 
        AND column_name = 'reject_transaction_id'
    ) THEN
        ALTER TABLE bounties ADD COLUMN reject_transaction_id VARCHAR(64) NULL;
    END IF;

    -- Claim transaction ID
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public'
        AND table_name = 'bounties' 
        AND column_name = 'claim_transaction_id'
    ) THEN
        ALTER TABLE bounties ADD COLUMN claim_transaction_id VARCHAR(64) NULL;
    END IF;

    -- Refund transaction ID
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public'
        AND table_name = 'bounties' 
        AND column_name = 'refund_transaction_id'
    ) THEN
        ALTER TABLE bounties ADD COLUMN refund_transaction_id VARCHAR(64) NULL;
    END IF;
END $$;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_bounties_create_transaction_id 
ON bounties(create_transaction_id) 
WHERE create_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bounties_accept_transaction_id 
ON bounties(accept_transaction_id) 
WHERE accept_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bounties_approve_transaction_id 
ON bounties(approve_transaction_id) 
WHERE approve_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bounties_reject_transaction_id 
ON bounties(reject_transaction_id) 
WHERE reject_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bounties_claim_transaction_id 
ON bounties(claim_transaction_id) 
WHERE claim_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bounties_refund_transaction_id 
ON bounties(refund_transaction_id) 
WHERE refund_transaction_id IS NOT NULL;
```

---

## Troubleshooting

### If you get "permission denied" error:
- Make sure you're logged into Supabase with the correct account
- Check that you have admin access to the project

### If columns already exist:
- The migration is idempotent (safe to run multiple times)
- It will skip columns that already exist

### If backend still shows error after migration:
1. **Restart the backend server** (this clears the schema cache)
2. Wait a few seconds for Supabase to update its schema cache
3. Try again

---

## Need Help?

If you're still having issues:
1. Check the Supabase logs in the dashboard
2. Verify the migration ran successfully using the verification query above
3. Make sure your backend is using the correct Supabase project

