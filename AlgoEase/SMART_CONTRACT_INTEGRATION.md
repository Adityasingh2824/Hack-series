# Smart Contract Integration Guide

This document explains how the smart contract is integrated with the frontend and backend.

## Architecture Overview

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│  Frontend   │────────▶│   Backend    │────────▶│  Database   │
│  (React)    │         │  (Express)   │         │  (Supabase) │
└──────┬──────┘         └──────┬───────┘         └─────────────┘
       │                       │
       │                       │
       ▼                       ▼
┌─────────────────────────────────────┐
│     Algorand Smart Contract         │
│     (App ID: 749689686)             │
└─────────────────────────────────────┘
```

## Integration Flow

### 1. Bounty Creation

**Frontend → Smart Contract → Backend → Database**

1. User fills form and clicks "Deploy bounty"
2. Frontend calls `createBounty()` from `WalletContext`
3. Smart contract transaction is created, signed, and submitted
4. Transaction is confirmed on-chain
5. Frontend gets `bountyId` from contract state (`bounty_count - 1`)
6. Frontend sends bounty data to backend API:
   ```javascript
   POST /api/bounties
   {
     title, description, amount, deadline,
     clientAddress, verifierAddress,
     contractId: bountyId,  // ← From contract
     transactionId: txId    // ← From transaction
   }
   ```
7. Backend saves to database with `contract_id`
8. Frontend updates transaction ID:
   ```javascript
   PATCH /api/bounties/:id/transaction
   {
     transactionId: txId,
     action: 'create',
     contractId: bountyId  // ← Ensures contract_id is saved
   }
   ```

### 2. Bounty Acceptance

**Frontend → Backend → Smart Contract → Backend**

1. Freelancer clicks "Accept bounty"
2. Frontend calls backend API:
   ```javascript
   POST /api/bounties/:id/accept
   ```
3. Backend updates database status to 'accepted'
4. Frontend calls smart contract:
   ```javascript
   acceptBounty(contractBountyId)
   ```
5. Transaction is signed and submitted
6. Frontend updates backend with transaction ID:
   ```javascript
   PATCH /api/bounties/:id/transaction
   {
     transactionId: txId,
     action: 'accept',
     contractId: contractBountyId
   }
   ```

### 3. Work Submission

**Frontend → Backend**

1. Freelancer submits work
2. Frontend calls backend API:
   ```javascript
   POST /api/bounties/:id/submit
   {
     description, links
   }
   ```
3. Backend updates database status to 'submitted'
4. Frontend can optionally call smart contract:
   ```javascript
   submitBounty(contractBountyId)
   ```

### 4. Work Approval

**Frontend → Smart Contract → Backend**

1. Client/Verifier clicks "Approve work"
2. Frontend calls smart contract:
   ```javascript
   approveBounty(contractBountyId, freelancerAddress)
   ```
3. Transaction transfers funds to freelancer
4. Frontend updates backend:
   ```javascript
   POST /api/bounties/:id/approve
   ```
5. Frontend stores transaction ID:
   ```javascript
   PATCH /api/bounties/:id/transaction
   {
     transactionId: txId,
     action: 'approve',
     contractId: contractBountyId
   }
   ```

### 5. Work Rejection

**Frontend → Backend → Smart Contract → Backend**

1. Client/Verifier clicks "Reject work"
2. Frontend calls backend API:
   ```javascript
   POST /api/bounties/:id/reject
   ```
3. Backend updates database status to 'rejected'
4. Frontend calls smart contract:
   ```javascript
   rejectBounty(contractBountyId, clientAddress)
   ```
5. Transaction refunds funds to client
6. Frontend stores transaction ID:
   ```javascript
   PATCH /api/bounties/:id/transaction
   {
     transactionId: txId,
     action: 'reject',
     contractId: contractBountyId
   }
   ```

### 6. Claim Payment

**Frontend → Smart Contract → Backend**

1. Freelancer clicks "Claim payment"
2. Frontend calls smart contract:
   ```javascript
   claimBounty(contractBountyId, freelancerAddress)
   ```
3. Transaction transfers funds (if not already transferred)
4. Frontend updates backend:
   ```javascript
   POST /api/bounties/:id/claim
   ```
5. Frontend stores transaction ID:
   ```javascript
   PATCH /api/bounties/:id/transaction
   {
     transactionId: txId,
     action: 'claim',
     contractId: contractBountyId
   }
   ```

## Key Files

### Frontend

- **`frontend/src/utils/contractUtils.js`**: Smart contract interaction utilities
- **`frontend/src/contexts/WalletContext.js`**: Wallet and contract state management
- **`frontend/src/utils/api.js`**: Backend API service
- **`frontend/src/pages/CreateBounty.js`**: Bounty creation flow
- **`frontend/src/pages/BountyDetail.js`**: Bounty actions (accept, approve, reject, claim)

### Backend

- **`backend/routes/bounties.js`**: Bounty CRUD and action endpoints
- **`backend/routes/contracts.js`**: Contract info endpoints
- **`backend/models/Bounty.js`**: Database model with contract_id handling

## Contract ID Flow

The `contract_id` (bounty ID on-chain) is critical for integration:

1. **Created on-chain**: When bounty is created, contract returns `bounty_count - 1`
2. **Sent to backend**: Frontend includes `contractId` in API calls
3. **Stored in database**: Backend saves as `contract_id` (BIGINT)
4. **Used for operations**: All contract calls use `contract_id` to identify the bounty

## Environment Variables

### Frontend (.env)
```env
REACT_APP_API_URL=http://localhost:5000/api
REACT_APP_CONTRACT_APP_ID=749689686
REACT_APP_CONTRACT_ADDRESS=GJR2ZOTCUS6JK63T3V47KYPZ7ZEKOIVTESQEQOUZCXIA3E35QR46NC46TM
REACT_APP_ALGOD_URL=https://testnet-api.algonode.cloud
REACT_APP_INDEXER_URL=https://testnet-idx.algonode.cloud
```

### Backend (.env)
```env
PORT=5000
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-key
CONTRACT_APP_ID=749689686
CONTRACT_ADDRESS=GJR2ZOTCUS6JK63T3V47KYPZ7ZEKOIVTESQEQOUZCXIA3E35QR46NC46TM
ALGOD_SERVER=https://testnet-api.algonode.cloud
```

## Testing the Integration

1. **Create a bounty**:
   - Fill form and submit
   - Check browser console for contract transaction
   - Verify `contract_id` is saved in database

2. **Accept a bounty**:
   - Click "Accept" as freelancer
   - Verify backend status updates
   - Verify contract transaction succeeds

3. **Approve work**:
   - Submit work as freelancer
   - Approve as client/verifier
   - Verify funds transfer on-chain
   - Verify backend status updates

4. **Claim payment**:
   - After approval, claim as freelancer
   - Verify funds received
   - Verify backend status updates

## Troubleshooting

### Contract ID is NULL
- Run fix script: `node backend/scripts/fix-contract-ids-from-chain.js`
- Check frontend sends `contractId` in API calls
- Check backend logs for `contract_id` save operations

### Transaction fails
- Check wallet has sufficient balance
- Verify contract ID is correct
- Check contract state matches database state

### Backend not updating
- Check API calls include auth token
- Verify backend routes are working
- Check database connection

## Next Steps

1. Ensure all contract operations sync with backend
2. Add error handling for failed transactions
3. Implement retry logic for network issues
4. Add transaction status tracking
5. Implement webhook notifications for contract events

