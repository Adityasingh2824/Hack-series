# Database Fix for Contract ID Storage

## Problem
The `contract_id` column was not being stored properly in the database, causing bounties to have NULL values.

## Solution
Two migration files have been created to fix the database schema:

### Option 1: Fix Existing Table (Recommended - Preserves Data)
**File:** `FIX_EXISTING_TABLE.sql`

This migration:
- ✅ Ensures `contract_id` column exists
- ✅ Converts `contract_id` to BIGINT type (supports large numbers)
- ✅ Makes `contract_id` nullable (allows NULL)
- ✅ Adds UNIQUE constraint (prevents duplicates, allows NULL)
- ✅ Creates index for fast queries
- ✅ Adds all missing transaction ID columns
- ✅ Updates status constraint
- ✅ **PRESERVES ALL EXISTING DATA**

### Option 2: Complete Rewrite (Fresh Start - Deletes Data)
**File:** `COMPLETE_DATABASE_REWRITE.sql`

This migration:
- ✅ Creates a fresh `bounties` table
- ✅ Properly configured `contract_id` as BIGINT
- ✅ All indexes and constraints
- ✅ RLS policies
- ⚠️ **WILL DELETE ALL EXISTING DATA**

## How to Run

### Step 1: Open Supabase Dashboard
1. Go to https://app.supabase.com
2. Select your project
3. Click on "SQL Editor" in the left sidebar

### Step 2: Run the Migration
1. Click "New Query"
2. Copy the contents of `FIX_EXISTING_TABLE.sql` (recommended)
3. Paste into the SQL Editor
4. Click "Run" or press `Ctrl+Enter`

### Step 3: Verify
After running the migration, verify it worked by running:

```sql
-- Check contract_id column
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'bounties' AND column_name = 'contract_id';

-- Should show:
-- column_name: contract_id
-- data_type: bigint
-- is_nullable: YES
```

## What Changed

### Database Schema
- `contract_id` is now **BIGINT** (was INT, which was too small)
- `contract_id` is **nullable** (allows NULL for bounties not yet on-chain)
- `contract_id` has **UNIQUE constraint** (prevents duplicates, allows NULL)
- `contract_id` has **index** for fast queries

### Backend Code
- `Bounty` model now always includes `contract_id` in save operations
- Enhanced logging to track `contract_id` saves
- Automatic fetching from contract state if missing

## After Migration

1. **Restart your backend server** to ensure all changes are loaded
2. **Test creating a new bounty** - `contract_id` should now be saved correctly
3. **Check existing bounties** - they will still have NULL `contract_id` if they don't exist on-chain

## Fixing Existing Bounties

If you have existing bounties with NULL `contract_id`, you can:

1. **Run the fix script:**
   ```bash
   cd backend
   node scripts/fix-missing-contract-ids.js
   ```

2. **Or manually update** bounties that exist on-chain:
   ```sql
   UPDATE bounties 
   SET contract_id = 5  -- Replace with actual contract ID
   WHERE id = 'your-bounty-id';
   ```

## Troubleshooting

### If migration fails:
- Check Supabase logs for errors
- Ensure you have proper permissions
- Try running sections of the migration one at a time

### If contract_id still not saving:
- Check backend logs for errors
- Verify the migration ran successfully
- Ensure backend is restarted after migration

## Support

If you encounter issues:
1. Check backend logs for detailed error messages
2. Verify database schema matches expected structure
3. Ensure environment variables are set correctly

