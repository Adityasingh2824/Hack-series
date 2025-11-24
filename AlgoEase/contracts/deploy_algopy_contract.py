#!/usr/bin/env python3
"""
Deployment script for AlgoEase Bounty Contract (Algopy version)

This script compiles and deploys the Algopy smart contract.
Note: Requires Python 3.12+ for PuyaPy
"""

import os
import sys
from pathlib import Path
from algokit_utils import (
    ApplicationClient,
    get_algod_client,
    get_localnet_default_account,
    Network,
)
from algosdk.atomic_transaction_composer import TransactionWithSigner
from algosdk.transaction import PaymentTxn
from algosdk.encoding import decode_address, encode_address
from algosdk import mnemonic as mn
from algosdk.account import generate_account
from algosdk.wallet import Wallet
import json

# Try to import the contract (will work after compilation)
try:
    from algoease_bounty_contract import AlgoEaseBountyContract
except ImportError:
    print("⚠️  Contract not compiled yet. Please run: puya compile algoease_bounty_contract.py")
    sys.exit(1)


def compile_contract():
    """Compile the Algopy contract using PuyaPy"""
    print("🔨 Compiling Algopy contract...")
    
    # Check if puya is installed
    try:
        import subprocess
        import sys
        from pathlib import Path as PathLib
        
        # Try to find puyapy executable
        python_exe = sys.executable
        python_dir = PathLib(python_exe).parent
        scripts_dir = python_dir / "Scripts"
        puyapy_exe = scripts_dir / "puyapy.exe"
        
        # Use Python module approach if executable not found
        if not puyapy_exe.exists():
            print("⚠️  puyapy.exe not found, using Python module approach...")
            result = subprocess.run(
                [python_exe, "-m", "puya", "compile", "algoease_bounty_contract.py"],
                cwd=Path(__file__).parent,
                capture_output=True,
                text=True
            )
        else:
            result = subprocess.run(
                [str(puyapy_exe), "compile", "algoease_bounty_contract.py"],
                cwd=Path(__file__).parent,
                capture_output=True,
                text=True
            )
        
        if result.returncode != 0:
            print(f"❌ Compilation failed: {result.stderr}")
            print(f"📄 stdout: {result.stdout}")
            return False
        
        print("✅ Contract compiled successfully!")
        if result.stdout:
            print(f"📄 Output: {result.stdout}")
        return True
    except FileNotFoundError:
        print("❌ PuyaPy not found. Please install: pip install puya")
        print("⚠️  Note: PuyaPy requires Python 3.12+")
        return False
    except Exception as e:
        print(f"❌ Compilation error: {e}")
        import traceback
        traceback.print_exc()
        return False


def load_contract_spec():
    """Load the compiled contract specification"""
    contract_dir = Path(__file__).parent
    arc32_file = contract_dir / "algoease_bounty_contract.arc32.json"
    
    if not arc32_file.exists():
        print(f"❌ Contract specification not found: {arc32_file}")
        print("   Please compile the contract first: puya compile algoease_bounty_contract.py")
        return None
    
    with open(arc32_file, 'r') as f:
        return json.load(f)


def load_creator_mnemonic():
    """Load creator mnemonic from environment or contract.env"""
    # Try environment variables first
    mnemonic = os.getenv('REACT_APP_CREATOR_MNEMONIC') or os.getenv('CREATOR_MNEMONIC')
    
    # If not found, try loading from contract.env
    if not mnemonic:
        contract_env = Path(__file__).parent.parent / 'contract.env'
        if contract_env.exists():
            with open(contract_env, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        key, value = line.split('=', 1)
                        if key.strip() in ['REACT_APP_CREATOR_MNEMONIC', 'CREATOR_MNEMONIC']:
                            mnemonic = value.strip().strip('"').strip("'")
                            break
    
    return mnemonic


def deploy_contract(network: Network = Network.TESTNET):
    """Deploy the Algopy contract"""
    print(f"🚀 Deploying contract to {network}...")
    
    # Compile first
    if not compile_contract():
        return None
    
    # Load contract spec
    app_spec = load_contract_spec()
    if not app_spec:
        return None
    
    try:
        # Get client and account
        algod_client = get_algod_client(network)
        
        # Create signer based on network
        if network == Network.LOCALNET:
            signer = get_localnet_default_account(algod_client)
        else:
            # For testnet/mainnet, load mnemonic and create signer
            mnemonic = load_creator_mnemonic()
            if not mnemonic:
                print("⚠️  Creator mnemonic not found!")
                print("   Please set REACT_APP_CREATOR_MNEMONIC or CREATOR_MNEMONIC")
                print("   environment variable, or add it to contract.env")
                return None
            
            # Create signer from mnemonic
            from algosdk.account import account_from_private_key
            from algosdk.mnemonic import to_private_key
            private_key = to_private_key(mnemonic)
            signer = account_from_private_key(private_key)
            print(f"✅ Loaded creator account: {signer.address}")
        
        # Create application client
        app_client = ApplicationClient(
            algod_client=algod_client,
            app_spec=app_spec,
            signer=signer,
        )
        
        # Deploy the contract
        print("📝 Creating application...")
        app_id, app_address, txid = app_client.create()
        
        print("✅ Contract deployed successfully!")
        print(f"   App ID: {app_id}")
        print(f"   App Address: {app_address}")
        print(f"   Transaction ID: {txid}")
        
        return {
            'app_id': app_id,
            'app_address': app_address,
            'txid': txid,
            'network': str(network)
        }
        
    except Exception as e:
        print(f"❌ Deployment failed: {e}")
        import traceback
        traceback.print_exc()
        return None


def main():
    """Main deployment function"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Deploy AlgoEase Bounty Contract')
    parser.add_argument(
        '--network',
        choices=['localnet', 'testnet', 'mainnet'],
        default='testnet',
        help='Network to deploy to (default: testnet)'
    )
    
    args = parser.parse_args()
    
    network_map = {
        'localnet': Network.LOCALNET,
        'testnet': Network.TESTNET,
        'mainnet': Network.MAINNET
    }
    
    network = network_map[args.network]
    
    result = deploy_contract(network)
    
    if result:
        print("\n📋 Deployment Summary:")
        print(f"   Network: {result['network']}")
        print(f"   App ID: {result['app_id']}")
        print(f"   App Address: {result['app_address']}")
        print(f"\n💡 Update your .env files with:")
        print(f"   REACT_APP_CONTRACT_APP_ID={result['app_id']}")
        print(f"   REACT_APP_CONTRACT_ADDRESS={result['app_address']}")
    else:
        print("\n❌ Deployment failed. Please check the errors above.")
        sys.exit(1)


if __name__ == "__main__":
    main()


