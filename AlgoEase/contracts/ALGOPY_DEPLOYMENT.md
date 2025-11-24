# AlgoEase Bounty Contract - Algopy Deployment Guide

This document explains how to compile and deploy the Algopy-based bounty smart contract.

## Prerequisites

1. **Python 3.10+** installed
2. **PuyaPy (Algopy)** installed:
   ```bash
   pip install puya
   ```
3. **AlgoKit** installed (for deployment):
   ```bash
   pip install algokit-utils
   ```

## Contract Overview

The `AlgoEaseBountyContract` is a smart contract that manages multiple bounties with escrow functionality:

- **Create Bounty**: Creator deposits ALGOs to escrow (contract address)
- **Accept Bounty**: Freelancer accepts the bounty
- **Submit Bounty**: Freelancer submits completed work
- **Approve Bounty**: Creator/Verifier approves (status = APPROVED, funds stay in escrow)
- **Claim Bounty**: Freelancer claims payment (funds transferred from escrow to freelancer)
- **Reject Bounty**: Creator/Verifier rejects (funds immediately refunded to creator)
- **Refund Bounty**: Manual refund by creator/verifier before deadline
- **Auto Refund**: Automatic refund when deadline passes

## Compilation

To compile the Algopy contract to TEAL:

```bash
# From the contracts directory
puya compile algoease_bounty_contract.py
```

This will generate:
- `algoease_bounty_contract.arc32.json` - ARC-32 ABI specification
- `algoease_bounty_contract.approval.teal` - Approval program
- `algoease_bounty_contract.clear.teal` - Clear state program

## Deployment

### Using AlgoKit

```python
from algokit_utils import (
    ApplicationClient,
    get_algod_client,
    get_localnet_default_account,
    Network,
)
from algosdk.atomic_transaction_composer import TransactionWithSigner
from algosdk.transaction import PaymentTxn

# Get client and account
algod_client = get_algod_client(Network.TESTNET)  # or Network.MAINNET
creator = get_localnet_default_account(algod_client)

# Create application client
app_client = ApplicationClient(
    algod_client=algod_client,
    app_spec=app_spec,  # Load from arc32.json
    signer=creator,
)

# Deploy the contract
app_id, app_address, txid = app_client.create()
print(f"Contract deployed! App ID: {app_id}, Address: {app_address}")
```

### Manual Deployment

1. Compile the contract to get TEAL files
2. Use `algokit` or `algosdk` to deploy:

```python
from algosdk.v2client import algod
from algosdk import transaction, account

# Load compiled TEAL
with open("algoease_bounty_contract.approval.teal", "r") as f:
    approval_program = f.read()

with open("algoease_bounty_contract.clear.teal", "r") as f:
    clear_program = f.read()

# Compile TEAL
algod_client = algod.AlgodClient(token, url)
approval_result = algod_client.compile(approval_program)
clear_result = algod_client.compile(clear_program)

# Create application
sp = algod_client.suggested_params()
txn = transaction.ApplicationCreateTxn(
    sender=creator_address,
    sp=sp,
    on_complete=transaction.OnComplete.NoOpOC,
    approval_program=base64.b64decode(approval_result["result"]),
    clear_program=base64.b64decode(clear_result["result"]),
    global_schema=transaction.StateSchema(num_uints=1, num_byte_slices=0),  # Only bounty_count
    local_schema=transaction.StateSchema(num_uints=0, num_byte_slices=0),
)
```

## Usage Examples

### Create Bounty

```python
# Grouped transaction required:
# 1. Payment from creator to contract
# 2. Application call to create_bounty

payment_txn = PaymentTxn(
    sender=creator_address,
    receiver=contract_address,
    amount=1000000,  # 1 ALGO in microAlgos
    sp=sp,
)

app_call_txn = app_client.call(
    "create_bounty",
    payment=payment_txn,
    verifier=verifier_address,
    deadline=deadline_timestamp,
    task_description="Build a website",
)
```

### Accept Bounty

```python
app_client.call(
    "accept_bounty",
    bounty_id=0,
    signer=freelancer,
)
```

### Submit Bounty

```python
app_client.call(
    "submit_bounty",
    bounty_id=0,
    signer=freelancer,
)
```

### Approve Bounty

```python
app_client.call(
    "approve_bounty",
    bounty_id=0,
    signer=creator,  # or verifier
)
```

### Reject Bounty

```python
app_client.call(
    "reject_bounty",
    bounty_id=0,
    signer=creator,  # or verifier
)
```

### Claim Bounty

```python
app_client.call(
    "claim_bounty",
    bounty_id=0,
    signer=freelancer,
)
```

### Get Bounty Info

```python
result = app_client.call("get_bounty_info", bounty_id=0)
client, freelancer, verifier, amount, deadline, status, task_desc = result.return_value
```

## Box Storage Layout

Each bounty is stored in a box named `"bounty_" + bounty_id`:

- **Offset 0-31**: Client address (32 bytes)
- **Offset 32-63**: Freelancer address (32 bytes, zero if not accepted)
- **Offset 64-95**: Verifier address (32 bytes)
- **Offset 96-103**: Amount (8 bytes, uint64)
- **Offset 104-111**: Deadline (8 bytes, uint64, Unix timestamp)
- **Offset 112**: Status (1 byte, uint8)
- **Offset 113+**: Task description (variable length)

## Status Values

- `0` = OPEN - Bounty created, waiting for freelancer
- `1` = ACCEPTED - Freelancer accepted the bounty
- `2` = SUBMITTED - Freelancer submitted work
- `3` = APPROVED - Creator/Verifier approved, ready to claim
- `4` = CLAIMED - Funds claimed by freelancer
- `5` = REJECTED - Work rejected, refunded to creator
- `6` = REFUNDED - Funds refunded to creator (manual/auto refund)

## Security Features

1. **Access Control**: Only authorized parties can perform actions
2. **Escrow**: Funds locked in contract address until claim/refund
3. **State Validation**: Enforced state transitions
4. **Deadline Enforcement**: Prevents actions after deadline (except auto-refund)
5. **Box Storage**: Each bounty isolated in its own box

## Testing

Test the contract using AlgoKit's testing utilities or create test scripts that interact with a local Algorand node.

## Notes

- The contract uses box storage, so there's no limit on the number of concurrent bounties
- All amounts are in microAlgos (1 ALGO = 1,000,000 microAlgos)
- Deadlines are Unix timestamps (seconds since epoch)
- Inner transactions are used for secure fund transfers

