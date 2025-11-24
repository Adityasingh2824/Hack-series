"""
AlgoEase Bounty Escrow Smart Contract

Multi-bounty escrow platform with complete workflow:
- Create bounty: Creator deposits funds to escrow (contract address)
- Accept bounty: Freelancer accepts the bounty
- Submit bounty: Freelancer submits completed work
- Approve bounty: Creator approves submission (status = APPROVED, funds remain in escrow)
- Claim bounty: Freelancer claims payment after approval (transfers funds from escrow to freelancer)
- Reject bounty: Creator rejects work, funds immediately refunded to creator

Uses PyTeal for contract development.
Uses box storage to support multiple concurrent bounties.

Flow:
1. Create -> funds locked in escrow (contract address)
2. Accept -> freelancer accepts
3. Submit -> freelancer submits work
4. Approve -> creator approves (status = APPROVED, funds stay in escrow)
5. Claim -> freelancer claims funds (transfers from escrow to freelancer's account)

OR

4. Reject -> creator rejects (funds immediately refunded to creator)
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
STATUS_SUBMITTED = Int(2)     # Freelancer submitted work
STATUS_APPROVED = Int(3)      # Creator approved, ready to claim
STATUS_CLAIMED = Int(4)       # Funds claimed by freelancer
STATUS_REJECTED = Int(5)      # Work rejected, refunded to creator

# ============================================================================
# Box Storage Layout (per bounty)
# ============================================================================
# Box name: "bounty_" + Itob(bounty_id) (8 bytes prefix + 8 bytes ID = 16 bytes)
# Box data (packed):
#   - creator_addr: 32 bytes (offset 0)
#   - freelancer_addr: 32 bytes (offset 32, zero address if not accepted)
#   - amount: 8 bytes (offset 64)
#   - status: 1 byte (offset 72)
#   - task_desc: variable length bytes (offset 73+)
# Total: 73 bytes + task_desc length

BOX_PREFIX = Bytes("bounty_")
CREATOR_OFFSET = Int(0)
FREELANCER_OFFSET = Int(32)
AMOUNT_OFFSET = Int(64)
STATUS_OFFSET = Int(72)
TASK_DESC_OFFSET = Int(73)

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
    )

# ============================================================================
# Bounty Operations
# ============================================================================

def create_bounty():
    """
    Create a new bounty.
    Funds go to escrow (contract address) and are locked.
    Requires grouped transaction:
    - Gtxn[0]: Payment from creator to contract address (escrow)
    - Gtxn[1]: Application call with args: [method, amount, task_desc]
    """
    bounty_id = ScratchVar(TealType.uint64)
    amount = ScratchVar(TealType.uint64)
    box_name = ScratchVar(TealType.bytes)
    task_desc = ScratchVar(TealType.bytes)
    
    return Seq([
        # Validate transaction group
        Assert(Global.group_size() == Int(2)),
        Assert(Txn.group_index() == Int(1)),
        
        # Validate arguments - must have method, amount, and task description
        Assert(Txn.application_args.length() == Int(3)),
        
        # Validate payment transaction
        Assert(Gtxn[0].type_enum() == TxnType.Payment),
        Assert(Gtxn[0].sender() == Txn.sender()),
        Assert(Gtxn[0].receiver() == Global.current_application_address()),  # Escrow = contract address
        
        # Parse arguments
        amount.store(Btoi(Txn.application_args[1])),
        task_desc.store(Txn.application_args[2]),
        
        # Validate amount
        Assert(amount.load() > Int(0)),
        Assert(Gtxn[0].amount() == amount.load()),
        
        # Get new bounty ID
        bounty_id.store(App.globalGet(BOUNTY_COUNT)),
        box_name.store(get_bounty_box_name(bounty_id.load())),
        
        # Calculate box size: 73 bytes (fixed) + task_desc length
        # Create bounty box with packed data
        App.box_put(
            box_name.load(),
            Concat(
                Txn.sender(),                    # creator (32 bytes)
                BytesZero(Int(32)),              # freelancer (32 bytes, zero)
                Itob(amount.load()),             # amount (8 bytes)
                status_to_bytes(STATUS_OPEN),    # status (1 byte)
                task_desc.load()                 # task_desc (variable)
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
    creator = ScratchVar(TealType.bytes)
    
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
        
        # Get creator address
        creator.store(Extract(box_data.load(), CREATOR_OFFSET, Int(32))),
        
        # Check freelancer is not zero address
        Assert(Txn.sender() != ZERO_ADDR),
        
        # Check freelancer is not the creator
        Assert(Txn.sender() != creator.load()),
        
        # Update box with new freelancer and status
        App.box_put(
            box_name.load(),
            Concat(
                creator.load(),                          # creator (unchanged)
                Txn.sender(),                            # new freelancer (32 bytes)
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),  # amount (unchanged)
                status_to_bytes(STATUS_ACCEPTED),       # new status (1 byte)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)  # task_desc (unchanged)
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
                Extract(box_data.load(), CREATOR_OFFSET, Int(32)),  # creator (unchanged)
                freelancer.load(),                                   # freelancer (unchanged)
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),    # amount (unchanged)
                status_to_bytes(STATUS_SUBMITTED),                  # new status (1 byte)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)  # task_desc (unchanged)
            )
        ),
        
        Return(Int(1))
    ])

def approve_bounty():
    """
    Approve bounty completion (creator only).
    Changes status from SUBMITTED to CLAIMED and transfers funds from escrow to freelancer.
    This automatically pays the freelancer upon approval - no separate claim step needed.
    Args: [method, bounty_id]
    """
    bounty_id = ScratchVar(TealType.uint64)
    box_name = ScratchVar(TealType.bytes)
    box_data = ScratchVar(TealType.bytes)
    status = ScratchVar(TealType.uint64)
    creator = ScratchVar(TealType.bytes)
    freelancer = ScratchVar(TealType.bytes)
    amount = ScratchVar(TealType.uint64)
    
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
        
        # Get creator, freelancer, and amount from box
        creator.store(Extract(box_data.load(), CREATOR_OFFSET, Int(32))),
        freelancer.store(Extract(box_data.load(), FREELANCER_OFFSET, Int(32))),
        amount.store(Btoi(Extract(box_data.load(), AMOUNT_OFFSET, Int(8)))),
        
        # Check caller is creator
        Assert(Txn.sender() == creator.load()),
        
        # Validate amount and freelancer
        Assert(amount.load() > Int(0)),
        Assert(freelancer.load() != ZERO_ADDR),
        
        # Update status to CLAIMED first (before transfer)
        App.box_put(
            box_name.load(),
            Concat(
                creator.load(),                                    # creator (unchanged)
                freelancer.load(),                                 # freelancer (unchanged)
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),  # amount (unchanged)
                status_to_bytes(STATUS_CLAIMED),                  # new status: CLAIMED (funds transferred)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)  # task_desc (unchanged)
            )
        ),
        
        # Inner transaction: Transfer funds from escrow to freelancer
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.Payment,
            TxnField.sender: Global.current_application_address(),  # Escrow = contract address
            TxnField.receiver: freelancer.load(),  # Freelancer address
            TxnField.amount: amount.load(),
            TxnField.fee: Int(0),  # Caller pays fee
        }),
        InnerTxnBuilder.Submit(),
        
        Return(Int(1))
    ])

def reject_bounty():
    """
    Reject bounty completion (creator only).
    Sends inner transaction from escrow back to creator's address.
    Args: [method, bounty_id]
    """
    bounty_id = ScratchVar(TealType.uint64)
    box_name = ScratchVar(TealType.bytes)
    box_data = ScratchVar(TealType.bytes)
    status = ScratchVar(TealType.uint64)
    amount = ScratchVar(TealType.uint64)
    creator = ScratchVar(TealType.bytes)
    
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
        
        # Check status is SUBMITTED (can only reject after submission)
        status.store(Btoi(Extract(box_data.load(), STATUS_OFFSET, Int(1)))),
        Assert(status.load() == STATUS_SUBMITTED),
        
        # Get addresses and amount from box
        creator.store(Extract(box_data.load(), CREATOR_OFFSET, Int(32))),
        amount.store(Btoi(Extract(box_data.load(), AMOUNT_OFFSET, Int(8)))),
        
        # Check caller is creator
        Assert(Txn.sender() == creator.load()),
        
        # Validate amount
        Assert(amount.load() > Int(0)),
        
        # Update status to REJECTED first (before transfer)
        App.box_put(
            box_name.load(),
            Concat(
                creator.load(),                                    # creator (unchanged)
                Extract(box_data.load(), FREELANCER_OFFSET, Int(32)),  # freelancer (unchanged)
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),       # amount (unchanged)
                status_to_bytes(STATUS_REJECTED),                # new status (rejected)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)  # task_desc (unchanged)
            )
        ),
        
        # Inner transaction: Send refund from escrow back to creator
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.Payment,
            TxnField.sender: Global.current_application_address(),  # Escrow = contract address
            TxnField.receiver: creator.load(),  # Creator address
            TxnField.amount: amount.load(),
            TxnField.fee: Int(0),  # Caller pays fee
        }),
        InnerTxnBuilder.Submit(),
        
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
        
        # Update status to CLAIMED first (before transfer)
        App.box_put(
            box_name.load(),
            Concat(
                Extract(box_data.load(), CREATOR_OFFSET, Int(32)),  # creator (unchanged)
                freelancer.load(),                                   # freelancer (unchanged)
                Extract(box_data.load(), AMOUNT_OFFSET, Int(8)),    # amount (unchanged)
                status_to_bytes(STATUS_CLAIMED),                    # new status (1 byte)
                Extract(box_data.load(), TASK_DESC_OFFSET, Len(box_data.load()) - TASK_DESC_OFFSET)  # task_desc (unchanged)
            )
        ),
        
        # Send payment to freelancer from escrow
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.Payment,
            TxnField.sender: Global.current_application_address(),  # Escrow = contract address
            TxnField.receiver: freelancer.load(),
            TxnField.amount: amount.load(),
            TxnField.fee: Int(0),  # Caller pays fee
        }),
        InnerTxnBuilder.Submit(),
        
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

    with open("algoease_bounty_escrow_approval.teal", "w") as f:
        f.write(approval_teal)

    with open("algoease_bounty_escrow_clear.teal", "w") as f:
        f.write(clear_teal)

    print("Smart contracts compiled successfully!")
    print("Files created:")
    print("  - algoease_bounty_escrow_approval.teal")
    print("  - algoease_bounty_escrow_clear.teal")

