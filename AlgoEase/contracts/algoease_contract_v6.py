"""
AlgoEase Smart Contract V6 - Bounty Escrow Platform with Escrow and Claim Flow

This contract manages bounties with the following features:
- Create bounty: Client deposits funds to escrow (contract address) - funds are locked
- Accept bounty: Freelancer accepts the bounty
- Submit bounty: Freelancer submits completed work
- Approve bounty: Creator/Verifier approves submission (status changes to APPROVED, funds remain in escrow)
- Claim bounty: Freelancer claims payment after approval (transfers funds from escrow to freelancer)
- Reject bounty: Creator/Verifier rejects work, refunds to creator
- Refund bounty: Manual refund by client or verifier
- Auto refund: Automatic refund when deadline passes

Uses box storage to support multiple concurrent bounties.

Flow:
1. Create -> funds locked in escrow (contract address)
2. Accept -> freelancer accepts
3. Submit -> freelancer submits work
4. Approve -> creator/verifier approves (status changes to APPROVED, funds stay locked in escrow)
5. Claim -> freelancer claims funds (transfers from escrow to freelancer's account)
"""

from pyteal import *

# ============================================================================
# Global State Keys
# ============================================================================
BOUNTY_COUNT = Bytes("bounty_count")  # Counter for bounty IDs

# ============================================================================
# Status Constants
# ============================================================================
STATUS_OPEN = Int(0)          # Bounty created, waiting for freelancer
STATUS_ACCEPTED = Int(1)      # Freelancer accepted the bounty
STATUS_SUBMITTED = Int(6)     # Freelancer submitted work
STATUS_APPROVED = Int(2)      # Creator/Verifier approved, ready to claim
STATUS_CLAIMED = Int(3)       # Funds claimed by freelancer
STATUS_REFUNDED = Int(4)      # Funds refunded to creator
STATUS_REJECTED = Int(5)      # Work rejected, refunded to creator

# ============================================================================
# Box Storage Layout (per bounty)
# ============================================================================
# Box name: "bounty_" + Itob(bounty_id) (8 bytes prefix + 8 bytes ID = 16 bytes)
# Box data (packed):
#   - client_addr: 32 bytes
#   - freelancer_addr: 32 bytes (zero address if not accepted)
#   - verifier_addr: 32 bytes
#   - amount: 8 bytes (uint64)
#   - deadline: 8 bytes (uint64)
#   - status: 1 byte (uint8)
#   - task_desc: variable length bytes
# Total: 113 bytes + task_desc length

BOX_PREFIX = Bytes("bounty_")
CLIENT_OFFSET = Int(0)
FREELANCER_OFFSET = Int(32)
VERIFIER_OFFSET = Int(64)
AMOUNT_OFFSET = Int(96)
DEADLINE_OFFSET = Int(104)
STATUS_OFFSET = Int(112)
TASK_DESC_OFFSET = Int(113)

ZERO_ADDR = Global.zero_address()

# ============================================================================
# Helper Functions
# ============================================================================

def get_bounty_box_name(bounty_id: Expr) -> Expr:
    """Generate box name: "bounty_" + Itob(bounty_id)"""
    return Concat(BOX_PREFIX, Itob(bounty_id))

def status_to_bytes(status: Expr) -> Expr:
    """Convert status integer to 1 byte representation"""
    # Itob produces 8 bytes, extract only the last byte (offset 7)
    return Extract(Itob(status), Int(7), Int(1))

# ============================================================================
# Main Approval Program
# ============================================================================

def approval_program():
    """Main approval program"""
    return Cond(
        [Txn.application_id() == Int(0), handle_creation()],
        [Txn.on_completion() == OnComplete.DeleteApplication, handle_deletion()],
        [Txn.on_completion() == OnComplete.UpdateApplication, Return(Int(0))],  # Immutable
        [Txn.on_completion() == OnComplete.CloseOut, Return(Int(1))],
        [Txn.on_completion() == OnComplete.OptIn, Return(Int(1))],
        [Txn.on_completion() == OnComplete.NoOp, handle_noop()],
    )

def handle_creation():
    """Initialize contract on creation"""
    return Seq([
        App.globalPut(BOUNTY_COUNT, Int(0)),
        Return(Int(1))
    ])

def handle_deletion():
    """Prevent deletion if any bounties exist"""
    return Seq([
        Assert(App.globalGet(BOUNTY_COUNT) == Int(0)),
        Return(Int(1))
    ])

def handle_noop():
    """Handle application calls"""
    method = Txn.application_args[0]
    return Cond(
        [method == Bytes("create_bounty"), create_bounty()],
        [method == Bytes("accept_bounty"), accept_bounty()],
        [method == Bytes("submit_bounty"), submit_bounty()],
        [method == Bytes("approve_bounty"), approve_bounty()],
        [method == Bytes("reject_bounty"), reject_bounty()],
        [method == Bytes("claim_bounty"), claim_bounty()],
        [method == Bytes("refund"), refund_bounty()],
        [method == Bytes("auto_refund"), auto_refund()],
    )

# ============================================================================
# Bounty Operations
# ============================================================================

def create_bounty():
    """
    Create a new bounty.
    Funds go to escrow (contract address) and are locked.
    Requires grouped transaction:
    - Gtxn[0]: Payment from client to contract address (escrow)
    - Gtxn[1]: Application call with args: [method, amount, deadline, task_desc]
               and accounts: [verifier_addr]
    """
    bounty_id = ScratchVar(TealType.uint64)
    amount = ScratchVar(TealType.uint64)
    deadline = ScratchVar(TealType.uint64)
    box_name = ScratchVar(TealType.bytes)
    
    return Seq([
        # Validate transaction group
        Assert(Global.group_size() == Int(2)),
        Assert(Txn.group_index() == Int(1)),
        
        # Validate arguments
        Assert(Txn.application_args.length() == Int(4)),
        Assert(Txn.accounts.length() >= Int(1)),  # Verifier address required
        
        # Validate payment transaction
        Assert(Gtxn[0].type_enum() == TxnType.Payment),
        Assert(Gtxn[0].sender() == Txn.sender()),
        Assert(Gtxn[0].receiver() == Global.current_application_address()),  # Escrow = contract address
        
        # Parse arguments
        amount.store(Btoi(Txn.application_args[1])),
        deadline.store(Btoi(Txn.application_args[2])),
        
        # Validate amount
        Assert(amount.load() > Int(0)),
        Assert(Gtxn[0].amount() == amount.load()),
        
        # Validate deadline
        Assert(deadline.load() > Global.latest_timestamp()),
        
        # Get new bounty ID
        bounty_id.store(App.globalGet(BOUNTY_COUNT)),
        box_name.store(get_bounty_box_name(bounty_id.load())),
        
        # Create bounty box with packed data
        App.box_put(
            box_name.load(),
            Concat(
                Txn.sender(),                    # client (32 bytes)
                BytesZero(Int(32)),              # freelancer (32 bytes, zero)
                Txn.accounts[0],                 # verifier (32 bytes)
                Itob(amount.load()),             # amount (8 bytes)
                Itob(deadline.load()),           # deadline (8 bytes)
                status_to_bytes(STATUS_OPEN),    # status (1 byte)
                Txn.application_args[3]          # task_desc (variable)
            )
        ),
        
        # Increment bounty counter
        App.globalPut(BOUNTY_COUNT, bounty_id.load() + Int(1)),
        
        Return(Int(1))
    ])

def accept_bounty():
    """
    Accept a bounty (freelancer commits to work).
    Args: [method, bounty_id]
    """
    bounty_id = ScratchVar(TealType.uint64)
    box_name = ScratchVar(TealType.bytes)
    box_data = ScratchVar(TealType.bytes)
    status = ScratchVar(TealType.uint64)
    deadline = ScratchVar(TealType.uint64)
    
    return Seq([
        # Validate arguments
        Assert(Txn.application_args.length() == Int(2)),
        
        # Parse bounty_id
        bounty_id.store(Btoi(Txn.application_args[1])),
        box_name.store(get_bounty_box_name(bounty_id.load())),
        
        # Read box (check exists and get value)
        (box_maybe := App.box_get(box_name.load())),
        Assert(box_maybe.hasValue()),
        box_data.store(box_maybe.value()),
        
        # Check status is OPEN
        status.store(Btoi(Extract(box_data.load(), STATUS_OFFSET, Int(1)))),
        Assert(status.load() == STATUS_OPEN),
        
        # Check deadline hasn't passed
        deadline.store(Btoi(Extract(box_data.load(), DEADLINE_OFFSET, Int(8)))),
        Assert(Global.latest_timestamp() < deadline.load()),
        
        # Check freelancer is not zero address
        Assert(Txn.sender() != ZERO_ADDR),
        
        # Check freelancer is not the client
        Assert(Txn.sender() != Extract(box_data.load(), CLIENT_OFFSET, Int(32))),
        
        # Update box with new freelancer and status
        App.box_put(
            box_name.load(),
            Concat(
                Extract(box_data.load(), CLIENT_OFFSET, Int(32)),
                Txn.sender(),  # new freelancer
                Extract(box_data.load(), VERIFIER_OFFSET, Int(32)),
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),
                Extract(box_data.load(), DEADLINE_OFFSET, Int(8)),
                status_to_bytes(STATUS_ACCEPTED),  # new status (1 byte)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)
            )
        ),
        
        Return(Int(1))
    ])

def submit_bounty():
    """
    Submit completed work (freelancer only).
    Changes status from ACCEPTED to SUBMITTED.
    Args: [method, bounty_id]
    """
    bounty_id = ScratchVar(TealType.uint64)
    box_name = ScratchVar(TealType.bytes)
    box_data = ScratchVar(TealType.bytes)
    status = ScratchVar(TealType.uint64)
    freelancer = ScratchVar(TealType.bytes)
    
    return Seq([
        # Validate arguments
        Assert(Txn.application_args.length() == Int(2)),
        
        # Parse bounty_id
        bounty_id.store(Btoi(Txn.application_args[1])),
        box_name.store(get_bounty_box_name(bounty_id.load())),
        
        # Read box
        (box_maybe := App.box_get(box_name.load())),
        Assert(box_maybe.hasValue()),
        box_data.store(box_maybe.value()),
        
        # Check status is ACCEPTED
        status.store(Btoi(Extract(box_data.load(), STATUS_OFFSET, Int(1)))),
        Assert(status.load() == STATUS_ACCEPTED),
        
        # Get freelancer address
        freelancer.store(Extract(box_data.load(), FREELANCER_OFFSET, Int(32))),
        
        # Check caller is the freelancer
        Assert(Txn.sender() == freelancer.load()),
        
        # Update box with new status (SUBMITTED)
        App.box_put(
            box_name.load(),
            Concat(
                Extract(box_data.load(), CLIENT_OFFSET, Int(32)),
                freelancer.load(),
                Extract(box_data.load(), VERIFIER_OFFSET, Int(32)),
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),
                Extract(box_data.load(), DEADLINE_OFFSET, Int(8)),
                status_to_bytes(STATUS_SUBMITTED),  # new status (1 byte)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)
            )
        ),
        
        Return(Int(1))
    ])

def approve_bounty():
    """
    Approve bounty completion (creator or verifier only).
    Changes status from SUBMITTED to APPROVED.
    Funds remain in escrow - freelancer must claim them.
    Args: [method, bounty_id]
    """
    bounty_id = ScratchVar(TealType.uint64)
    box_name = ScratchVar(TealType.bytes)
    box_data = ScratchVar(TealType.bytes)
    status = ScratchVar(TealType.uint64)
    client = ScratchVar(TealType.bytes)
    verifier = ScratchVar(TealType.bytes)
    
    return Seq([
        # Validate arguments
        Assert(Txn.application_args.length() == Int(2)),
        
        # Parse bounty_id
        bounty_id.store(Btoi(Txn.application_args[1])),
        box_name.store(get_bounty_box_name(bounty_id.load())),
        
        # Read box
        (box_maybe := App.box_get(box_name.load())),
        Assert(box_maybe.hasValue()),
        box_data.store(box_maybe.value()),
        
        # Check status is SUBMITTED
        status.store(Btoi(Extract(box_data.load(), STATUS_OFFSET, Int(1)))),
        Assert(status.load() == STATUS_SUBMITTED),
        
        # Get addresses from box
        client.store(Extract(box_data.load(), CLIENT_OFFSET, Int(32))),
        verifier.store(Extract(box_data.load(), VERIFIER_OFFSET, Int(32))),
        
        # Check caller is creator (client) or verifier
        Assert(Or(
            Txn.sender() == client.load(),
            Txn.sender() == verifier.load()
        )),
        
        # Update box with new status (APPROVED) - NO FUND TRANSFER
        # Funds stay locked in escrow until freelancer claims
        App.box_put(
            box_name.load(),
            Concat(
                client.load(),
                Extract(box_data.load(), FREELANCER_OFFSET, Int(32)),
                verifier.load(),
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),
                Extract(box_data.load(), DEADLINE_OFFSET, Int(8)),
                status_to_bytes(STATUS_APPROVED),  # new status (1 byte)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)
            )
        ),
        
        Return(Int(1))
    ])

def reject_bounty():
    """
    Reject bounty completion (creator or verifier only).
    Sends inner transaction from escrow back to creator's address.
    REQUIRES creator address in accounts array (Txn.accounts[0]).
    Args: [method, bounty_id]
    Accounts: [creator_addr] - must match stored client address
    """
    bounty_id = ScratchVar(TealType.uint64)
    box_name = ScratchVar(TealType.bytes)
    box_data = ScratchVar(TealType.bytes)
    status = ScratchVar(TealType.uint64)
    amount = ScratchVar(TealType.uint64)
    client = ScratchVar(TealType.bytes)
    client_from_accounts = ScratchVar(TealType.bytes)
    verifier = ScratchVar(TealType.bytes)
    
    return Seq([
        # Validate arguments
        Assert(Txn.application_args.length() == Int(2)),
        
        # Validate accounts array - must have creator/client address
        Assert(Txn.accounts.length() >= Int(1)),
        client_from_accounts.store(Txn.accounts[0]),
        
        # Parse bounty_id
        bounty_id.store(Btoi(Txn.application_args[1])),
        box_name.store(get_bounty_box_name(bounty_id.load())),
        
        # Read box
        (box_maybe := App.box_get(box_name.load())),
        Assert(box_maybe.hasValue()),
        box_data.store(box_maybe.value()),
        
        # Check status is SUBMITTED or ACCEPTED (can reject at either stage)
        status.store(Btoi(Extract(box_data.load(), STATUS_OFFSET, Int(1)))),
        Assert(Or(
            status.load() == STATUS_SUBMITTED,
            status.load() == STATUS_ACCEPTED
        )),
        
        # Get addresses from box
        client.store(Extract(box_data.load(), CLIENT_OFFSET, Int(32))),
        verifier.store(Extract(box_data.load(), VERIFIER_OFFSET, Int(32))),
        
        # Check caller is creator or verifier
        Assert(Or(
            Txn.sender() == client.load(),
            Txn.sender() == verifier.load()
        )),
        
        # CRITICAL: Validate creator address from accounts array matches stored client address
        Assert(client_from_accounts.load() == client.load()),
        
        # Get amount
        amount.store(Btoi(Extract(box_data.load(), AMOUNT_OFFSET, Int(8)))),
        Assert(amount.load() > Int(0)),
        
        # Inner transaction: Send refund from escrow back to creator
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.Payment,
            TxnField.sender: Global.current_application_address(),  # Escrow = contract address
            TxnField.receiver: client.load(),  # Creator from accounts array (validated)
            TxnField.amount: amount.load(),
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),
        
        # Update box with new status
        App.box_put(
            box_name.load(),
            Concat(
                client.load(),
                Extract(box_data.load(), FREELANCER_OFFSET, Int(32)),
                verifier.load(),
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),
                Extract(box_data.load(), DEADLINE_OFFSET, Int(8)),
                status_to_bytes(STATUS_REJECTED),  # new status (rejected) (1 byte)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)
            )
        ),
        
        Return(Int(1))
    ])

def claim_bounty():
    """
    Claim bounty payment (freelancer only, after approval).
    Transfers funds from escrow to freelancer's account.
    Args: [method, bounty_id]
    """
    bounty_id = ScratchVar(TealType.uint64)
    box_name = ScratchVar(TealType.bytes)
    box_data = ScratchVar(TealType.bytes)
    status = ScratchVar(TealType.uint64)
    amount = ScratchVar(TealType.uint64)
    freelancer = ScratchVar(TealType.bytes)
    
    return Seq([
        # Validate arguments
        Assert(Txn.application_args.length() == Int(2)),
        
        # Parse bounty_id
        bounty_id.store(Btoi(Txn.application_args[1])),
        box_name.store(get_bounty_box_name(bounty_id.load())),
        
        # Read box
        (box_maybe := App.box_get(box_name.load())),
        Assert(box_maybe.hasValue()),
        box_data.store(box_maybe.value()),
        
        # Check status is APPROVED
        status.store(Btoi(Extract(box_data.load(), STATUS_OFFSET, Int(1)))),
        Assert(status.load() == STATUS_APPROVED),
        
        # Get freelancer and amount
        freelancer.store(Extract(box_data.load(), FREELANCER_OFFSET, Int(32))),
        amount.store(Btoi(Extract(box_data.load(), AMOUNT_OFFSET, Int(8)))),
        
        # Check caller is freelancer
        Assert(Txn.sender() == freelancer.load()),
        Assert(amount.load() > Int(0)),
        
        # Send payment to freelancer from escrow
        # Set fee to minimum (1000 microAlgos) - outer transaction must cover this
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.Payment,
            TxnField.sender: Global.current_application_address(),  # Escrow = contract address
            TxnField.receiver: freelancer.load(),
            TxnField.amount: amount.load(),
            TxnField.fee: Int(1000),  # Minimum fee for inner transaction (paid by outer transaction)
        }),
        InnerTxnBuilder.Submit(),
        
        # Update box with new status
        App.box_put(
            box_name.load(),
            Concat(
                Extract(box_data.load(), CLIENT_OFFSET, Int(32)),
                freelancer.load(),
                Extract(box_data.load(), VERIFIER_OFFSET, Int(32)),
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),
                Extract(box_data.load(), DEADLINE_OFFSET, Int(8)),
                status_to_bytes(STATUS_CLAIMED),  # new status (1 byte)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)
            )
        ),
        
        Return(Int(1))
    ])

def refund_bounty():
    """
    Manual refund (client or verifier only, before deadline).
    Args: [method, bounty_id]
    """
    bounty_id = ScratchVar(TealType.uint64)
    box_name = ScratchVar(TealType.bytes)
    box_data = ScratchVar(TealType.bytes)
    status = ScratchVar(TealType.uint64)
    amount = ScratchVar(TealType.uint64)
    client = ScratchVar(TealType.bytes)
    deadline = ScratchVar(TealType.uint64)
    
    return Seq([
        # Validate arguments
        Assert(Txn.application_args.length() == Int(2)),
        
        # Parse bounty_id
        bounty_id.store(Btoi(Txn.application_args[1])),
        box_name.store(get_bounty_box_name(bounty_id.load())),
        
        # Read box
        (box_maybe := App.box_get(box_name.load())),
        Assert(box_maybe.hasValue()),
        box_data.store(box_maybe.value()),
        
        # Check status is not CLAIMED, REFUNDED, or REJECTED
        status.store(Btoi(Extract(box_data.load(), STATUS_OFFSET, Int(1)))),
        Assert(status.load() != STATUS_CLAIMED),
        Assert(status.load() != STATUS_REFUNDED),
        Assert(status.load() != STATUS_REJECTED),
        
        # Check deadline hasn't passed (manual refund only before deadline)
        deadline.store(Btoi(Extract(box_data.load(), DEADLINE_OFFSET, Int(8)))),
        Assert(Global.latest_timestamp() < deadline.load()),
        
        # Get client and verifier
        client.store(Extract(box_data.load(), CLIENT_OFFSET, Int(32))),
        
        # Check caller is client or verifier
        Assert(Or(
            Txn.sender() == client.load(),
            Txn.sender() == Extract(box_data.load(), VERIFIER_OFFSET, Int(32))
        )),
        
        # Get amount
        amount.store(Btoi(Extract(box_data.load(), AMOUNT_OFFSET, Int(8)))),
        Assert(amount.load() > Int(0)),
        
        # Send refund to client
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.Payment,
            TxnField.sender: Global.current_application_address(),
            TxnField.receiver: client.load(),
            TxnField.amount: amount.load(),
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),
        
        # Update box with new status
        App.box_put(
            box_name.load(),
            Concat(
                client.load(),
                Extract(box_data.load(), FREELANCER_OFFSET, Int(32)),
                Extract(box_data.load(), VERIFIER_OFFSET, Int(32)),
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),
                Extract(box_data.load(), DEADLINE_OFFSET, Int(8)),
                status_to_bytes(STATUS_REFUNDED),  # new status (1 byte)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)
            )
        ),
        
        Return(Int(1))
    ])

def auto_refund():
    """
    Automatic refund when deadline has passed (anyone can call).
    Args: [method, bounty_id]
    """
    bounty_id = ScratchVar(TealType.uint64)
    box_name = ScratchVar(TealType.bytes)
    box_data = ScratchVar(TealType.bytes)
    status = ScratchVar(TealType.uint64)
    amount = ScratchVar(TealType.uint64)
    client = ScratchVar(TealType.bytes)
    deadline = ScratchVar(TealType.uint64)
    
    return Seq([
        # Validate arguments
        Assert(Txn.application_args.length() == Int(2)),
        
        # Parse bounty_id
        bounty_id.store(Btoi(Txn.application_args[1])),
        box_name.store(get_bounty_box_name(bounty_id.load())),
        
        # Read box
        (box_maybe := App.box_get(box_name.load())),
        Assert(box_maybe.hasValue()),
        box_data.store(box_maybe.value()),
        
        # Check status is not CLAIMED, REFUNDED, or REJECTED
        status.store(Btoi(Extract(box_data.load(), STATUS_OFFSET, Int(1)))),
        Assert(status.load() != STATUS_CLAIMED),
        Assert(status.load() != STATUS_REFUNDED),
        Assert(status.load() != STATUS_REJECTED),
        
        # Check deadline has passed
        deadline.store(Btoi(Extract(box_data.load(), DEADLINE_OFFSET, Int(8)))),
        Assert(Global.latest_timestamp() >= deadline.load()),
        
        # Get amount and client
        amount.store(Btoi(Extract(box_data.load(), AMOUNT_OFFSET, Int(8)))),
        client.store(Extract(box_data.load(), CLIENT_OFFSET, Int(32))),
        Assert(amount.load() > Int(0)),
        
        # Send refund to client
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.Payment,
            TxnField.sender: Global.current_application_address(),
            TxnField.receiver: client.load(),
            TxnField.amount: amount.load(),
            TxnField.fee: Int(0),
        }),
        InnerTxnBuilder.Submit(),
        
        # Update box with new status
        App.box_put(
            box_name.load(),
            Concat(
                client.load(),
                Extract(box_data.load(), FREELANCER_OFFSET, Int(32)),
                Extract(box_data.load(), VERIFIER_OFFSET, Int(32)),
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),
                Extract(box_data.load(), DEADLINE_OFFSET, Int(8)),
                status_to_bytes(STATUS_REFUNDED),  # new status (1 byte)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)
            )
        ),
        
        Return(Int(1))
    ])

# ============================================================================
# Clear State Program
# ============================================================================

def clear_state_program():
    """Clear state program - allow opt-out"""
    return Return(Int(1))

# ============================================================================
# Compilation
# ============================================================================

if __name__ == "__main__":
    approval_teal = compileTeal(approval_program(), mode=Mode.Application, version=8)
    clear_teal = compileTeal(clear_state_program(), mode=Mode.Application, version=8)

    with open("algoease_approval_v6.teal", "w") as f:
        f.write(approval_teal)

    with open("algoease_clear_v6.teal", "w") as f:
        f.write(clear_teal)

    print("Smart contracts compiled successfully!")
    print("Files created:")
    print("  - algoease_approval_v6.teal")
    print("  - algoease_clear_v6.teal")

