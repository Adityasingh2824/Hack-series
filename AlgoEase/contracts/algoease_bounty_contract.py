"""
AlgoEase Bounty Smart Contract - Algopy Version

Multi-bounty escrow platform with complete workflow:
- Create bounty: Creator deposits funds to escrow (contract address)
- Accept bounty: Freelancer accepts the bounty
- Submit bounty: Freelancer submits completed work
- Approve bounty: Creator/Verifier approves submission (status = APPROVED, funds remain in escrow)
- Claim bounty: Freelancer claims payment after approval (transfers funds from escrow to freelancer)
- Reject bounty: Creator/Verifier rejects work, refunds to creator immediately

Uses Algopy (PuyaPy) for contract development.
Uses box storage to support multiple concurrent bounties.

Flow:
1. Create -> funds locked in escrow (contract address)
2. Accept -> freelancer accepts
3. Submit -> freelancer submits work
4. Approve -> creator/verifier approves (status = APPROVED, funds stay in escrow)
5. Claim -> freelancer claims funds (transfers from escrow to freelancer's account)

OR

4. Reject -> creator/verifier rejects (funds immediately refunded to creator)
"""

from algopy import (
    ARC4Contract,
    arc4,
    Account,
    UInt64,
    Txn,
    gtxn,
    itxn,
    Global,
    op,
)


# Status constants
STATUS_OPEN = UInt64(0)          # Bounty created, waiting for freelancer
STATUS_ACCEPTED = UInt64(1)      # Freelancer accepted the bounty
STATUS_SUBMITTED = UInt64(2)     # Freelancer submitted work
STATUS_APPROVED = UInt64(3)      # Creator/Verifier approved, ready to claim
STATUS_CLAIMED = UInt64(4)       # Funds claimed by freelancer
STATUS_REJECTED = UInt64(5)      # Work rejected, refunded to creator
STATUS_REFUNDED = UInt64(6)      # Funds refunded to creator (manual/auto refund)


class AlgoEaseBountyContract(ARC4Contract):
    """Smart contract for managing multiple bounties with escrow"""

    def __init__(self) -> None:
        # Initialize global state - bounty counter
        self.bounty_count = UInt64(0)

    @arc4.abimethod()
    def create_bounty(
        self,
        payment: gtxn.PaymentTransaction,
        verifier: Account,
        deadline: UInt64,
        task_description: arc4.String,
    ) -> UInt64:
        """Create a new bounty with escrow funding

        Requires grouped transaction:
        - Gtxn[0]: Payment from creator to contract address (escrow)
        - Gtxn[1]: Application call with this method

        Args:
            payment: Payment transaction funding the escrow (must be Gtxn[0])
            verifier: Account that can approve/reject (can be same as creator)
            deadline: Unix timestamp deadline for the bounty
            task_description: Description of the task/work required

        Returns:
            Bounty ID
        """
        # Verify this is a grouped transaction
        assert Global.group_size == UInt64(2), "Must be grouped transaction"
        assert Txn.group_index == UInt64(1), "Must be second transaction in group"

        # Verify the payment is to this contract (escrow)
        assert payment.receiver == Global.current_application_address, "Payment must be to contract"
        assert payment.sender == Txn.sender, "Payment sender must match transaction sender"

        # Validate amount
        amount = payment.amount
        assert amount > UInt64(0), "Amount must be greater than 0"

        # Validate deadline is in the future
        assert deadline > Global.latest_timestamp, "Deadline must be in the future"

        # Generate unique bounty ID
        bounty_id = self.bounty_count
        self.bounty_count += UInt64(1)

        # Create box name: "bounty_" + bounty_id (8 bytes prefix + 8 bytes ID = 16 bytes)
        box_name = op.concat(arc4.String("bounty_").bytes, op.itob(bounty_id))

        # Box data layout:
        #   - client_addr: 32 bytes (offset 0)
        #   - freelancer_addr: 32 bytes (offset 32, zero address if not accepted)
        #   - verifier_addr: 32 bytes (offset 64)
        #   - amount: 8 bytes (offset 96)
        #   - deadline: 8 bytes (offset 104)
        #   - status: 1 byte (offset 112)
        #   - task_desc: variable length (offset 113+)
        # Minimum size: 113 bytes

        # Calculate box size (113 bytes + task description length)
        task_desc_bytes = task_description.bytes
        task_desc_len = op.len(task_desc_bytes)
        box_size = UInt64(113) + task_desc_len

        # Create box
        op.Box.create(box_name, box_size)

        # Store client address (bytes 0-31)
        op.Box.put(box_name, UInt64(0), Txn.sender.bytes)

        # Store freelancer address as zero (bytes 32-63) - not accepted yet
        zero_address = op.bzero(UInt64(32))
        op.Box.put(box_name, UInt64(32), zero_address)

        # Store verifier address (bytes 64-95)
        op.Box.put(box_name, UInt64(64), verifier.bytes)

        # Store amount (bytes 96-103)
        op.Box.put(box_name, UInt64(96), op.itob(amount))

        # Store deadline (bytes 104-111)
        op.Box.put(box_name, UInt64(104), op.itob(deadline))

        # Store status as OPEN (byte 112)
        op.Box.put(box_name, UInt64(112), op.itob(STATUS_OPEN))

        # Store task description (bytes 113+)
        op.Box.put(box_name, UInt64(113), task_desc_bytes)

        return bounty_id

    @arc4.abimethod()
    def accept_bounty(
        self,
        bounty_id: UInt64,
    ) -> arc4.Bool:
        """Accept a bounty (freelancer commits to work)

        Args:
            bounty_id: ID of the bounty to accept

        Returns:
            True if acceptance successful
        """
        # Get box name
        box_name = op.concat(arc4.String("bounty_").bytes, op.itob(bounty_id))

        # Verify box exists and get size
        box_exists, box_size = op.Box.length(box_name)
        assert box_exists, "Bounty not found"

        # Read bounty data from box
        client = Account(op.Box.extract(box_name, UInt64(0), UInt64(32)))
        freelancer = Account(op.Box.extract(box_name, UInt64(32), UInt64(32)))
        deadline = op.btoi(op.Box.extract(box_name, UInt64(104), UInt64(8)))
        status = op.btoi(op.Box.extract(box_name, UInt64(112), UInt64(1)))

        # Check status is OPEN
        assert status == STATUS_OPEN, "Bounty must be OPEN to accept"

        # Check deadline hasn't passed
        assert Global.latest_timestamp < deadline, "Bounty deadline has passed"

        # Check freelancer is not zero address
        zero_address = op.bzero(UInt64(32))
        assert Txn.sender.bytes != zero_address, "Invalid sender address"

        # Check freelancer is not the client
        assert Txn.sender != client, "Client cannot accept their own bounty"

        # Update box with new freelancer and status
        # Only update the fields that change - other data remains intact
        op.Box.put(box_name, UInt64(32), Txn.sender.bytes)  # Set freelancer
        op.Box.put(box_name, UInt64(112), op.itob(STATUS_ACCEPTED))  # Set status to ACCEPTED

        return arc4.Bool(True)

    @arc4.abimethod()
    def submit_bounty(
        self,
        bounty_id: UInt64,
    ) -> arc4.Bool:
        """Submit completed work (freelancer only)

        Args:
            bounty_id: ID of the bounty to submit

        Returns:
            True if submission successful
        """
        # Get box name
        box_name = op.concat(arc4.String("bounty_").bytes, op.itob(bounty_id))

        # Verify box exists
        box_exists, _ = op.Box.length(box_name)
        assert box_exists, "Bounty not found"

        # Read bounty data from box
        freelancer = Account(op.Box.extract(box_name, UInt64(32), UInt64(32)))
        status = op.btoi(op.Box.extract(box_name, UInt64(112), UInt64(1)))

        # Check status is ACCEPTED
        assert status == STATUS_ACCEPTED, "Bounty must be ACCEPTED to submit"

        # Check caller is the freelancer
        assert Txn.sender == freelancer, "Only assigned freelancer can submit"

        # Update status to SUBMITTED
        op.Box.put(box_name, UInt64(112), op.itob(STATUS_SUBMITTED))

        return arc4.Bool(True)

    @arc4.abimethod()
    def approve_bounty(
        self,
        bounty_id: UInt64,
    ) -> arc4.Bool:
        """Approve bounty completion (creator or verifier only)

        Changes status to APPROVED. Funds remain in escrow until freelancer claims.

        Args:
            bounty_id: ID of the bounty to approve

        Returns:
            True if approval successful
        """
        # Get box name
        box_name = op.concat(arc4.String("bounty_").bytes, op.itob(bounty_id))

        # Verify box exists
        box_exists, _ = op.Box.length(box_name)
        assert box_exists, "Bounty not found"

        # Read bounty data from box
        client = Account(op.Box.extract(box_name, UInt64(0), UInt64(32)))
        verifier = Account(op.Box.extract(box_name, UInt64(64), UInt64(32)))
        status = op.btoi(op.Box.extract(box_name, UInt64(112), UInt64(1)))

        # Check status is SUBMITTED
        assert status == STATUS_SUBMITTED, "Bounty must be SUBMITTED to approve"

        # Check caller is creator or verifier
        assert (Txn.sender == client) or (Txn.sender == verifier), "Only creator or verifier can approve"

        # Update status to APPROVED (funds stay in escrow)
        op.Box.put(box_name, UInt64(112), op.itob(STATUS_APPROVED))

        return arc4.Bool(True)

    @arc4.abimethod()
    def reject_bounty(
        self,
        bounty_id: UInt64,
    ) -> arc4.Bool:
        """Reject bounty completion (creator or verifier only)

        Immediately refunds funds from escrow back to creator.

        Args:
            bounty_id: ID of the bounty to reject

        Returns:
            True if rejection successful
        """
        # Get box name
        box_name = op.concat(arc4.String("bounty_").bytes, op.itob(bounty_id))

        # Verify box exists
        box_exists, _ = op.Box.length(box_name)
        assert box_exists, "Bounty not found"

        # Read bounty data from box
        client = Account(op.Box.extract(box_name, UInt64(0), UInt64(32)))
        verifier = Account(op.Box.extract(box_name, UInt64(64), UInt64(32)))
        amount = op.btoi(op.Box.extract(box_name, UInt64(96), UInt64(8)))
        status = op.btoi(op.Box.extract(box_name, UInt64(112), UInt64(1)))

        # Check status is SUBMITTED or ACCEPTED (can reject at either stage)
        assert (status == STATUS_SUBMITTED) or (status == STATUS_ACCEPTED), "Bounty must be SUBMITTED or ACCEPTED to reject"

        # Check caller is creator or verifier
        assert (Txn.sender == client) or (Txn.sender == verifier), "Only creator or verifier can reject"

        # Validate amount
        assert amount > UInt64(0), "Invalid amount"

        # Update status to REJECTED first
        op.Box.put(box_name, UInt64(112), op.itob(STATUS_REJECTED))

        # Send refund from escrow back to creator
        itxn.Payment(
            receiver=client,
            amount=amount,
            fee=UInt64(0),  # Caller pays fee
        ).submit()

        return arc4.Bool(True)

    @arc4.abimethod()
    def claim_bounty(
        self,
        bounty_id: UInt64,
    ) -> arc4.Bool:
        """Claim bounty payment (freelancer only, after approval)

        Transfers funds from escrow to freelancer's account.

        Args:
            bounty_id: ID of the bounty to claim

        Returns:
            True if claim successful
        """
        # Get box name
        box_name = op.concat(arc4.String("bounty_").bytes, op.itob(bounty_id))

        # Verify box exists
        box_exists, _ = op.Box.length(box_name)
        assert box_exists, "Bounty not found"

        # Read bounty data from box
        freelancer = Account(op.Box.extract(box_name, UInt64(32), UInt64(32)))
        amount = op.btoi(op.Box.extract(box_name, UInt64(96), UInt64(8)))
        status = op.btoi(op.Box.extract(box_name, UInt64(112), UInt64(1)))

        # Check status is APPROVED
        assert status == STATUS_APPROVED, "Bounty must be APPROVED to claim"

        # Check caller is the freelancer
        assert Txn.sender == freelancer, "Only assigned freelancer can claim"

        # Validate amount
        assert amount > UInt64(0), "Invalid amount"

        # Update status to CLAIMED first
        op.Box.put(box_name, UInt64(112), op.itob(STATUS_CLAIMED))

        # Send payment to freelancer from escrow
        itxn.Payment(
            receiver=freelancer,
            amount=amount,
            fee=UInt64(0),  # Caller pays fee
        ).submit()

        return arc4.Bool(True)

    @arc4.abimethod()
    def refund_bounty(
        self,
        bounty_id: UInt64,
    ) -> arc4.Bool:
        """Manual refund (creator or verifier only, before deadline)

        Refunds funds from escrow back to creator.

        Args:
            bounty_id: ID of the bounty to refund

        Returns:
            True if refund successful
        """
        # Get box name
        box_name = op.concat(arc4.String("bounty_").bytes, op.itob(bounty_id))

        # Verify box exists
        box_exists, _ = op.Box.length(box_name)
        assert box_exists, "Bounty not found"

        # Read bounty data from box
        client = Account(op.Box.extract(box_name, UInt64(0), UInt64(32)))
        verifier = Account(op.Box.extract(box_name, UInt64(64), UInt64(32)))
        amount = op.btoi(op.Box.extract(box_name, UInt64(96), UInt64(8)))
        deadline = op.btoi(op.Box.extract(box_name, UInt64(104), UInt64(8)))
        status = op.btoi(op.Box.extract(box_name, UInt64(112), UInt64(1)))

        # Check status is not CLAIMED, REFUNDED, or REJECTED
        assert status != STATUS_CLAIMED, "Bounty already claimed"
        assert status != STATUS_REFUNDED, "Bounty already refunded"
        assert status != STATUS_REJECTED, "Bounty already rejected"

        # Check deadline hasn't passed (manual refund only before deadline)
        assert Global.latest_timestamp < deadline, "Deadline has passed, use auto_refund"

        # Check caller is client or verifier
        assert (Txn.sender == client) or (Txn.sender == verifier), "Only creator or verifier can refund"

        # Validate amount
        assert amount > UInt64(0), "Invalid amount"

        # Update status to REFUNDED
        op.Box.put(box_name, UInt64(112), op.itob(STATUS_REFUNDED))

        # Send refund to client
        itxn.Payment(
            receiver=client,
            amount=amount,
            fee=UInt64(0),  # Caller pays fee
        ).submit()

        return arc4.Bool(True)

    @arc4.abimethod()
    def auto_refund(
        self,
        bounty_id: UInt64,
    ) -> arc4.Bool:
        """Automatic refund when deadline has passed (anyone can call)

        Args:
            bounty_id: ID of the bounty to auto-refund

        Returns:
            True if auto-refund successful
        """
        # Get box name
        box_name = op.concat(arc4.String("bounty_").bytes, op.itob(bounty_id))

        # Verify box exists
        box_exists, _ = op.Box.length(box_name)
        assert box_exists, "Bounty not found"

        # Read bounty data from box
        client = Account(op.Box.extract(box_name, UInt64(0), UInt64(32)))
        amount = op.btoi(op.Box.extract(box_name, UInt64(96), UInt64(8)))
        deadline = op.btoi(op.Box.extract(box_name, UInt64(104), UInt64(8)))
        status = op.btoi(op.Box.extract(box_name, UInt64(112), UInt64(1)))

        # Check status is not CLAIMED, REFUNDED, or REJECTED
        assert status != STATUS_CLAIMED, "Bounty already claimed"
        assert status != STATUS_REFUNDED, "Bounty already refunded"
        assert status != STATUS_REJECTED, "Bounty already rejected"

        # Check deadline has passed
        assert Global.latest_timestamp >= deadline, "Deadline has not passed yet"

        # Validate amount
        assert amount > UInt64(0), "Invalid amount"

        # Update status to REFUNDED
        op.Box.put(box_name, UInt64(112), op.itob(STATUS_REFUNDED))

        # Send refund to client
        itxn.Payment(
            receiver=client,
            amount=amount,
            fee=UInt64(0),  # Caller pays fee
        ).submit()

        return arc4.Bool(True)

    @arc4.abimethod()
    def get_bounty_info(
        self,
        bounty_id: UInt64,
    ) -> arc4.Tuple[Account, Account, Account, UInt64, UInt64, UInt64, arc4.String]:
        """Get bounty information

        Args:
            bounty_id: ID of the bounty

        Returns:
            Tuple of (client, freelancer, verifier, amount, deadline, status, task_description)
        """
        # Get box name
        box_name = op.concat(arc4.String("bounty_").bytes, op.itob(bounty_id))

        # Verify box exists and get size
        box_exists, box_size = op.Box.length(box_name)
        assert box_exists, "Bounty not found"

        # Read bounty data from box
        client = Account(op.Box.extract(box_name, UInt64(0), UInt64(32)))
        freelancer = Account(op.Box.extract(box_name, UInt64(32), UInt64(32)))
        verifier = Account(op.Box.extract(box_name, UInt64(64), UInt64(32)))
        amount = op.btoi(op.Box.extract(box_name, UInt64(96), UInt64(8)))
        deadline = op.btoi(op.Box.extract(box_name, UInt64(104), UInt64(8)))
        status = op.btoi(op.Box.extract(box_name, UInt64(112), UInt64(1)))
        
        # Calculate task description length (box_size - 113 bytes for fixed fields)
        task_desc_len = box_size - UInt64(113)
        task_desc_bytes = op.Box.extract(box_name, UInt64(113), task_desc_len)
        task_description = arc4.String(task_desc_bytes)

        return arc4.Tuple((
            client,
            freelancer,
            verifier,
            amount,
            deadline,
            status,
            task_description,
        ))

    @arc4.abimethod()
    def get_bounty_count(self) -> UInt64:
        """Get total number of bounties created

        Returns:
            Total bounty count
        """
        return self.bounty_count

