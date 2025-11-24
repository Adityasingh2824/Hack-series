const express = require('express');
const router = express.Router();
const Bounty = require('../models/Bounty');
const { validateBounty } = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');

// Test endpoint to check all bounties in database
router.get('/test/all', async (req, res) => {
  try {
    console.log('🧪 Test endpoint: Fetching all bounties from database...');
    const allBounties = await Bounty.find({}, { limit: 100 });
    const bountyObjects = allBounties.map(bounty => 
      bounty.toObject ? bounty.toObject() : bounty
    );
    console.log('✅ Test endpoint: Found', bountyObjects.length, 'bounties');
    res.json({ 
      total: bountyObjects.length,
      bounties: bountyObjects,
      message: `Successfully fetched ${bountyObjects.length} bounties from database`
    });
  } catch (error) {
    console.error('❌ Test endpoint error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch bounties', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Test endpoint to check database connection
router.get('/test/connection', async (req, res) => {
  try {
    const { getSupabase } = require('../config/database');
    const supabase = getSupabase();
    
    // Try a simple query
    const { data, error } = await supabase
      .from('bounties')
      .select('id')
      .limit(1);
    
    if (error) {
      throw error;
    }
    
    res.json({
      status: 'connected',
      message: 'Database connection successful',
      tableExists: true,
      sampleCount: data ? data.length : 0
    });
  } catch (error) {
    console.error('❌ Database connection test failed:', error);
    res.status(500).json({
      status: 'error',
      message: 'Database connection failed',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Get all bounties with filtering and pagination
router.get('/', async (req, res) => {
  try {
    const {
      status,
      client,
      freelancer,
      minAmount,
      maxAmount,
      deadline,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    console.log('📥 Fetching all bounties with query:', req.query);

    // Build filter object for Supabase
    const filter = {};
    if (status) filter.status = status;
    if (client) filter.clientAddress = client;
    if (freelancer) filter.freelancerAddress = freelancer;
    if (minAmount || maxAmount) {
      filter.amount = {};
      if (minAmount) filter.amount.$gte = parseFloat(minAmount);
      if (maxAmount) filter.amount.$lte = parseFloat(maxAmount);
    }
    if (deadline) {
      filter.deadline = { $gte: new Date(deadline) };
    }

    console.log('🔍 Filter object:', JSON.stringify(filter, null, 2));

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);
    
    // Convert sortBy from camelCase to snake_case if needed
    const sortFieldMap = {
      'createdAt': 'created_at',
      'updatedAt': 'updated_at',
      'contractId': 'contract_id',
      'clientAddress': 'client_address',
      'freelancerAddress': 'freelancer_address',
      'verifierAddress': 'verifier_address'
    };
    const dbSortBy = sortFieldMap[sortBy] || sortBy;
    
    console.log('📊 Querying bounties with:', {
      filter,
      sort: { [dbSortBy]: sortOrder === 'desc' ? -1 : 1 },
      skip,
      limit: limitNum
    });
    
    const bounties = await Bounty.find(filter, {
      sort: { [dbSortBy]: sortOrder === 'desc' ? -1 : 1 },
      skip: skip,
      limit: limitNum,
      select: '-submissions' // Exclude submissions for list view
    });

    const total = await Bounty.countDocuments(filter);

    console.log('📊 Found bounties:', bounties.length, 'out of', total, 'total');

    // Convert bounties to objects for JSON response
    const bountyObjects = bounties.map(bounty => {
      if (typeof bounty.toObject === 'function') {
        return bounty.toObject();
      }
      return bounty;
    });

    if (bountyObjects.length > 0) {
      console.log('📋 First bounty sample:', JSON.stringify(bountyObjects[0], null, 2));
    }

    const responseData = {
      bounties: bountyObjects,
      pagination: {
        page: parseInt(page),
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    };

    console.log('✅ Returning', bountyObjects.length, 'bounties');
    
    // Ensure response format is correct - always return { bounties: [], pagination: {} }
    if (!responseData.bounties) {
      responseData.bounties = [];
    }
    if (!responseData.pagination) {
      responseData.pagination = {
        page: parseInt(page),
        limit: limitNum,
        total: 0,
        pages: 0
      };
    }
    
    res.json(responseData);
  } catch (error) {
    console.error('❌ Error fetching bounties:', error);
    console.error('❌ Error stack:', error.stack);
    // Return empty array instead of error to prevent frontend crashes
    res.status(500).json({ 
      error: 'Failed to fetch bounties', 
      message: error.message,
      bounties: [],
      pagination: {
        page: 1,
        limit: 10,
        total: 0,
        pages: 0
      }
    });
  }
});

// Get single bounty by ID (can be contract_id or database id)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('📥 Fetching bounty with ID:', id);
    
    // Try to find by contract_id first (numeric)
    let bounty = await Bounty.findOne({ contractId: id });
    
    // If not found, try to find by database id (UUID)
    if (!bounty) {
      bounty = await Bounty.findById(id);
    }
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }

    res.json(bounty.toObject ? bounty.toObject() : bounty);
  } catch (error) {
    console.error('Error fetching bounty:', error);
    res.status(500).json({ error: 'Failed to fetch bounty' });
  }
});

// Create new bounty - make auth optional if clientAddress is in body
router.post('/', async (req, res, next) => {
  // If clientAddress is provided in body, we can skip strict auth
  // Otherwise, use authenticate middleware
  if (req.body.clientAddress) {
    // Set req.user from body for compatibility
    req.user = { address: req.body.clientAddress };
    next();
  } else {
    // Use authenticate middleware
    authenticate(req, res, next);
  }
}, validateBounty, async (req, res) => {
  try {
    console.log('📥 Received bounty creation request:', {
      body: req.body,
      user: req.user,
      headers: {
        'content-type': req.headers['content-type'],
        'authorization': req.headers['authorization'] ? 'Present' : 'Missing'
      }
    });
    
    // Verify request body is parsed correctly
    if (!req.body || Object.keys(req.body).length === 0) {
      console.error('❌ Request body is empty or not parsed!');
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Request body is empty. Make sure Content-Type is application/json'
      });
    }

    // Prepare bounty data
    // Use clientAddress from body if provided, otherwise use auth token (req.user.address)
    const clientAddress = req.body.clientAddress || req.user?.address;
    
    if (!clientAddress) {
      return res.status(400).json({ 
        error: 'Client address required',
        message: 'Client address must be provided in request body or Authorization header'
      });
    }

    const bountyData = {
      title: req.body.title,
      description: req.body.description,
      amount: parseFloat(req.body.amount),
      // New contract doesn't use deadline - make it optional (null if not provided)
      deadline: req.body.deadline ? new Date(req.body.deadline).toISOString() : null,
      // New contract doesn't use verifier - set to null (only creator can approve/reject)
      verifierAddress: null,
      clientAddress: clientAddress, // Use from body or auth token
      status: 'open',
      requirements: req.body.requirements || [],
      tags: req.body.tags || [],
      submissions: [],
      // contractId will be set after smart contract creation
      // CRITICAL: Always process contractId if provided (even if null, to allow explicit null setting)
      // Convert to number if it's a string, validate it's numeric
      contractId: req.body.hasOwnProperty('contractId') ? (() => {
        const contractIdValue = req.body.contractId;
        // If it's null or undefined, keep it as null
        if (contractIdValue === null || contractIdValue === undefined || contractIdValue === '') {
          return null;
        }
        // Otherwise, try to convert to number
        const contractIdNum = typeof contractIdValue === 'string' ? parseInt(contractIdValue, 10) : contractIdValue;
        return (!isNaN(contractIdNum) && isFinite(contractIdNum) && contractIdNum >= 0) ? contractIdNum : null;
      })() : null,
      // Store transaction ID if provided (from frontend after on-chain creation)
      transactionId: req.body.transactionId || null,
      createTransactionId: req.body.transactionId || req.body.createTransactionId || null
    };

    console.log('💾 Bounty data to save:', JSON.stringify(bountyData, null, 2));
    console.log('💾 Bounty data details:', {
      title: bountyData.title,
      description: bountyData.description?.substring(0, 50) + '...',
      amount: bountyData.amount,
      deadline: bountyData.deadline,
      clientAddress: bountyData.clientAddress,
      verifierAddress: bountyData.verifierAddress,
      contractId: bountyData.contractId,
      transactionId: bountyData.transactionId,
      status: bountyData.status,
      requirements: bountyData.requirements?.length || 0,
      tags: bountyData.tags?.length || 0
    });

    // Validate required fields - new contract doesn't require deadline
    if (!bountyData.title || !bountyData.description || !bountyData.amount) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Title, description, and amount are required'
      });
    }

    // Validate amount
    if (bountyData.amount < 0.001) {
      return res.status(400).json({ 
        error: 'Invalid amount',
        message: 'Amount must be at least 0.001 ALGO'
      });
    }

    // New contract doesn't use deadline - validate only if provided (backward compatibility)
    if (bountyData.deadline) {
      const deadlineDate = new Date(bountyData.deadline);
      const now = new Date();
      const minDeadline = new Date(now.getTime() - 5 * 60 * 1000); // Allow 5 minutes in the past
      if (deadlineDate <= minDeadline) {
        return res.status(400).json({ 
          error: 'Invalid deadline',
          message: `Deadline must be in the future (received: ${deadlineDate.toISOString()}, now: ${now.toISOString()})`
        });
      }
    }

    // Validate addresses
    const addressRegex = /^[A-Z2-7]{58}$/;
    if (!addressRegex.test(bountyData.clientAddress)) {
      return res.status(400).json({ 
        error: 'Invalid client address',
        message: 'Client address must be a valid Algorand address'
      });
    }
    // New contract doesn't use verifier - skip validation (verifierAddress is always null)
    // Keeping this check for backward compatibility in case old data is sent
    if (bountyData.verifierAddress && !addressRegex.test(bountyData.verifierAddress)) {
      return res.status(400).json({ 
        error: 'Invalid verifier address',
        message: 'Verifier address must be a valid Algorand address'
      });
    }

    // CRITICAL: When creating a new bounty, we should ALWAYS create a new record
    // Only update if this is explicitly an update request (has contractId AND transaction ID matches)
    // If contractId is null/undefined/empty, ALWAYS create a new bounty - never update
    
    const hasContractId = bountyData.contractId !== null && 
                          bountyData.contractId !== undefined && 
                          bountyData.contractId !== '';
    
    console.log('🔍 Bounty creation check:', {
      hasContractId,
      contractId: bountyData.contractId,
      transactionId: bountyData.transactionId || bountyData.createTransactionId,
      title: bountyData.title?.substring(0, 30) + '...'
    });
    
    let existingBounty = null;
    let shouldUpdate = false;
    
    // ONLY check for existing bounty if contractId is provided AND not null
    // This ensures new bounties (with null contractId) are always created
    if (hasContractId) {
      try {
        existingBounty = await Bounty.findOne({ contractId: bountyData.contractId });
        if (existingBounty) {
          console.log('⚠️ Found existing bounty with contract_id:', bountyData.contractId);
          
          // Only update if transaction IDs match (same creation attempt being retried)
          // If transaction IDs don't match, this is a duplicate contractId - still update to avoid duplicates
          const existingTxId = existingBounty.create_transaction_id || existingBounty.createTransactionId;
          const newTxId = bountyData.transactionId || bountyData.createTransactionId;
          
          if (existingTxId && newTxId && existingTxId === newTxId) {
            console.log('📝 Same transaction ID - this is a retry, updating existing bounty');
            shouldUpdate = true;
          } else if (existingTxId && newTxId) {
            console.log('⚠️ Different transaction ID but same contractId - updating to avoid duplicate');
            shouldUpdate = true;
          } else {
            // No transaction ID match - but contractId exists, so update to avoid duplicate
            console.log('⚠️ Existing bounty found with contractId, updating to avoid duplicate');
            shouldUpdate = true;
          }
        } else {
          console.log('✅ No existing bounty found with contract_id:', bountyData.contractId, '- will create new');
        }
      } catch (findError) {
        console.warn('⚠️ Error checking for existing bounty:', findError);
        // On error, default to creating new bounty
        shouldUpdate = false;
      }
    } else {
      console.log('📝 No contractId provided - ALWAYS creating new bounty (contractId will be set after on-chain creation)');
      // CRITICAL: When contractId is null, NEVER check for existing bounties by transaction ID or any other field
      // This ensures each new bounty creation creates a new database record
      shouldUpdate = false;
      existingBounty = null;
      
      // Double-check: Even if someone tries to match by transaction ID, don't do it when contractId is null
      // This prevents accidentally updating an existing bounty when creating a new one
      console.log('🔒 Lock: contractId is null - creation mode enforced (no updates allowed)');
    }
    
    let savedBounty;
    let verifyBounty = null;
    
    try {
      // CRITICAL: Only update if we explicitly determined we should update
      // This prevents accidentally updating when we should create new
      if (shouldUpdate && existingBounty && hasContractId) {
        // Update existing bounty instead of creating new one
        console.log('📝 Updating existing bounty with contract_id:', bountyData.contractId);
        
        // Update fields that might have changed
        if (bountyData.title) existingBounty.title = bountyData.title;
        if (bountyData.description) existingBounty.description = bountyData.description;
        if (bountyData.amount) existingBounty.amount = bountyData.amount;
        if (bountyData.deadline) existingBounty.deadline = bountyData.deadline;
        if (bountyData.clientAddress) {
          existingBounty.client_address = bountyData.clientAddress;
          existingBounty.clientAddress = bountyData.clientAddress;
        }
        if (bountyData.verifierAddress) {
          existingBounty.verifier_address = bountyData.verifierAddress;
          existingBounty.verifierAddress = bountyData.verifierAddress;
        }
        // CRITICAL: Always update contractId if provided (even if it was already set)
        if (bountyData.contractId !== undefined && bountyData.contractId !== null) {
          const contractIdNum = typeof bountyData.contractId === 'string' ? parseInt(bountyData.contractId, 10) : bountyData.contractId;
          if (!isNaN(contractIdNum) && isFinite(contractIdNum) && contractIdNum >= 0) {
            existingBounty.contract_id = contractIdNum;
            existingBounty.contractId = contractIdNum;
            console.log('✅ Updated existing bounty contractId:', contractIdNum);
          }
        }
        // Update transaction ID if provided
        if (bountyData.transactionId || bountyData.createTransactionId) {
          existingBounty.create_transaction_id = bountyData.transactionId || bountyData.createTransactionId;
          existingBounty.createTransactionId = existingBounty.create_transaction_id;
        }
        // Don't overwrite status if it's already set (might be accepted, etc.)
        if (bountyData.status && existingBounty.status === 'open') {
          existingBounty.status = bountyData.status;
        }
        
        savedBounty = await existingBounty.save();
        console.log('✅ Existing bounty updated successfully!');
        console.log('✅ Updated bounty ID:', savedBounty.id);
        console.log('✅ Updated bounty contractId:', savedBounty.contractId);
      } else {
        // ALWAYS create new bounty if:
        // 1. No contractId provided (hasContractId is false)
        // 2. No existing bounty found
        // 3. shouldUpdate is false
        console.log('🆕 Creating NEW bounty (not updating existing)');
        console.log('🆕 Reason:', {
          hasContractId,
          foundExisting: !!existingBounty,
          shouldUpdate,
          contractId: bountyData.contractId
        });
        
        const bounty = new Bounty(bountyData);
        console.log('📦 Bounty object created, saving to database...');
        console.log('📦 Bounty data:', JSON.stringify(bountyData, null, 2));
        console.log('📦 Bounty object contract_id:', bounty.contract_id);
        console.log('📦 Bounty object contractId:', bounty.contractId);
        
        try {
          savedBounty = await bounty.save();
          console.log('✅ Bounty saved successfully!');
          console.log('✅ Saved bounty ID:', savedBounty.id);
          console.log('✅ Saved bounty contract_id:', savedBounty.contract_id);
          console.log('✅ Saved bounty contractId:', savedBounty.contractId);
          
          // CRITICAL: Verify the save actually worked
          if (!savedBounty || !savedBounty.id) {
            console.error('❌ CRITICAL: Bounty.save() returned without ID!');
            console.error('❌ savedBounty:', savedBounty);
            throw new Error('Bounty save failed - no ID returned from database');
          }
        } catch (saveError) {
          console.error('❌ Error during bounty.save():', saveError);
          console.error('❌ Save error details:', {
            message: saveError.message,
            code: saveError.code,
            details: saveError.details,
            hint: saveError.hint,
            stack: saveError.stack
          });
          throw saveError; // Re-throw to be caught by outer catch
        }
        
        // CRITICAL: If contract_id is missing, try to get it from the transaction ID
        // This is more reliable than using bounty_count - 1, which can be wrong if multiple bounties are created simultaneously
        let contractIdResolved = false;
        if (!savedBounty.contract_id || savedBounty.contract_id === null) {
          console.log('⚠️ ContractId is missing, attempting to fetch from blockchain...');
          console.log('⚠️ Bounty data contractId:', bountyData.contractId);
          console.log('⚠️ Saved bounty contract_id:', savedBounty.contract_id);
          console.log('⚠️ Transaction ID:', bountyData.transactionId || bountyData.createTransactionId);
          
          // First, try to get contractId from the transaction ID if we have it
          const transactionId = bountyData.transactionId || bountyData.createTransactionId;
          if (transactionId) {
            try {
              const algosdk = require('algosdk');
              const indexerClient = new algosdk.Indexer(
                process.env.ALGOD_TOKEN || '',
                process.env.INDEXER_SERVER || 'https://testnet-idx.algonode.cloud',
                process.env.ALGOD_PORT || ''
              );
              
              console.log(`🔍 Looking up transaction: ${transactionId}`);
              const txInfo = await indexerClient.lookupTransactionByID(transactionId).do();
              
              // Check global state delta for bounty_count change
              if (txInfo['global-state-delta']) {
                for (const delta of txInfo['global-state-delta']) {
                  const key = Buffer.from(delta.key, 'base64').toString('utf8');
                  if (key === 'bounty_count' && delta.value) {
                    const newCount = delta.value.uint || 0;
                    if (newCount > 0) {
                      const bountyId = newCount - 1; // New bounty ID is count - 1
                      console.log(`✅ Got bounty ID ${bountyId} from transaction state delta (count: ${newCount})`);
                      
                      // Verify this bounty matches by checking the box
                      try {
                        const appId = parseInt(process.env.CONTRACT_APP_ID || process.env.REACT_APP_CONTRACT_APP_ID || '749707697');
                        const prefix = Buffer.from('bounty_', 'utf8');
                        const bountyIdBytes = algosdk.encodeUint64(bountyId);
                        const boxNameBytes = Buffer.concat([prefix, Buffer.from(bountyIdBytes)]);
                        const boxNameBase64 = boxNameBytes.toString('base64');
                        
                        // Wait a bit for box to be indexed (retry with delay)
                        let boxValue = null;
                        for (let retry = 0; retry < 3; retry++) {
                          try {
                            if (retry > 0) {
                              console.log(`⏳ Waiting ${retry * 1000}ms for box to be indexed (retry ${retry}/3)...`);
                              await new Promise(resolve => setTimeout(resolve, retry * 1000));
                            }
                            boxValue = await indexerClient.lookupApplicationBoxByIDandName(
                              appId,
                              boxNameBase64
                            ).do();
                            if (boxValue && boxValue.value) break;
                          } catch (boxRetryError) {
                            if (retry === 2) throw boxRetryError;
                            continue;
                          }
                        }
                        
                        if (boxValue && boxValue.value) {
                          const boxData = Buffer.from(boxValue.value, 'base64');
                          const data = new Uint8Array(boxData);
                          
                          if (data.length >= 32) {
                            const boxClientAddr = algosdk.encodeAddress(data.slice(0, 32));
                            const savedClientAddr = (savedBounty.client_address || savedBounty.clientAddress || '').toUpperCase().trim();
                            const boxClientAddrUpper = boxClientAddr.toUpperCase().trim();
                            
                            console.log(`🔍 Verifying bounty match - Box client: ${boxClientAddrUpper}, Saved client: ${savedClientAddr}`);
                            
                            // If addresses match, this is the correct bounty
                            if (boxClientAddrUpper === savedClientAddr) {
                              console.log(`✅ Addresses match! Using contract_id: ${bountyId}`);
                              savedBounty.contract_id = bountyId;
                              savedBounty.contractId = bountyId;
                              await savedBounty.save();
                              console.log(`✅ Updated saved bounty with contract_id: ${bountyId}`);
                              // Success - contract_id is set, skip fallback
                              contractIdResolved = true;
                              break; // Exit the loop
                            } else {
                              console.warn(`⚠️ Addresses don't match. This might not be the correct bounty.`);
                              console.warn(`⚠️ Box client: ${boxClientAddrUpper}, Saved client: ${savedClientAddr}`);
                            }
                          }
                        }
                      } catch (boxError) {
                        console.warn('⚠️ Could not verify box, but using bounty ID from transaction:', boxError.message);
                      }
                      
                      // Use the bounty ID from transaction even if box verification fails
                      // (box might not be indexed yet)
                      if (!contractIdResolved) {
                        savedBounty.contract_id = bountyId;
                        savedBounty.contractId = bountyId;
                        await savedBounty.save();
                        console.log(`✅ Updated saved bounty with contract_id: ${bountyId} (from transaction)`);
                        // Success - contract_id is set, skip fallback
                        contractIdResolved = true;
                        break; // Exit the loop
                      }
                    }
                  }
                }
              }
            } catch (txError) {
              console.warn('⚠️ Could not get contract ID from transaction:', txError.message);
              // Continue to fallback method
            }
          }
          
          // Only use fallback if contractId wasn't resolved from transaction
          if (!contractIdResolved) {
            // Fallback: Try to get from contract state (less reliable for concurrent creations)
            try {
              const algosdk = require('algosdk');
              const algodClient = new algosdk.Algodv2(
                process.env.ALGOD_TOKEN || '',
                process.env.ALGOD_SERVER || 'https://testnet-api.algonode.cloud',
                process.env.ALGOD_PORT || ''
              );
              const appId = parseInt(process.env.CONTRACT_APP_ID || process.env.REACT_APP_CONTRACT_APP_ID || '749707697');
              console.log(`🔍 Fallback: Fetching contract state for app ID: ${appId}`);
              
              const appInfo = await algodClient.getApplicationByID(appId).do();
              const globalState = {};
              if (appInfo.params['global-state']) {
                appInfo.params['global-state'].forEach(state => {
                  const key = Buffer.from(state.key, 'base64').toString();
                  if (state.value.type === 1) {
                    globalState[key] = state.value.uint;
                  }
                });
              }
              console.log('📊 Contract global state:', globalState);
              
              const bountyCount = globalState['bounty_count'] || 0;
              console.log(`📊 Bounty count from contract: ${bountyCount}`);
              
              if (bountyCount > 0) {
                // Try to find the correct bounty by checking all recent boxes
                // Start from the latest and work backwards
                const indexerClient = new algosdk.Indexer(
                  process.env.ALGOD_TOKEN || '',
                  process.env.INDEXER_SERVER || 'https://testnet-idx.algonode.cloud',
                  process.env.ALGOD_PORT || ''
                );
                
                const savedClientAddr = (savedBounty.client_address || savedBounty.clientAddress || '').toUpperCase().trim();
                const savedAmount = Math.round(parseFloat(savedBounty.amount || 0) * 1000000);
                
                // Check the last few bounties to find the one that matches
                let foundBountyId = null;
                for (let i = bountyCount - 1; i >= Math.max(0, bountyCount - 5); i--) {
                  try {
                    const prefix = Buffer.from('bounty_', 'utf8');
                    const bountyIdBytes = algosdk.encodeUint64(i);
                    const boxNameBytes = Buffer.concat([prefix, Buffer.from(bountyIdBytes)]);
                    const boxNameBase64 = boxNameBytes.toString('base64');
                    
                    const boxValue = await indexerClient.lookupApplicationBoxByIDandName(
                      appId,
                      boxNameBase64
                    ).do();
                    
                    if (boxValue && boxValue.value) {
                      const boxData = Buffer.from(boxValue.value, 'base64');
                      const data = new Uint8Array(boxData);
                      
                      if (data.length >= 73) {
                        // Box format: client_addr(32) + freelancer_addr(32) + amount(8) + status(1) + task_desc(variable)
                        const boxClientAddr = algosdk.encodeAddress(data.slice(0, 32));
                        const boxAmount = algosdk.decodeUint64(new Uint8Array(data.slice(64, 72)));
                        const boxClientAddrUpper = boxClientAddr.toUpperCase().trim();
                        
                        // Check if this matches our bounty
                        if (boxClientAddrUpper === savedClientAddr && 
                            BigInt(savedAmount) === BigInt(boxAmount)) {
                          console.log(`✅ Found matching bounty! ID: ${i}, Client: ${boxClientAddrUpper}, Amount: ${savedAmount}`);
                          foundBountyId = i;
                          break;
                        }
                      }
                    }
                  } catch (boxError) {
                    // Box might not exist or not be indexed yet - continue checking
                    continue;
                  }
                }
                
                if (foundBountyId !== null) {
                  savedBounty.contract_id = foundBountyId;
                  savedBounty.contractId = foundBountyId;
                  await savedBounty.save();
                  console.log(`✅ Updated saved bounty with contract_id: ${foundBountyId} (matched by client and amount)`);
                } else {
                  // Last resort: use the latest bounty ID if we can't find a match
                  // This is less reliable but better than leaving it null
                  const latestBountyId = bountyCount - 1;
                  console.warn(`⚠️ Could not find matching bounty, using latest ID: ${latestBountyId}`);
                  console.warn(`⚠️ This may be incorrect if multiple bounties were created simultaneously`);
                  
                  // Check if this contract_id is already taken
                  const existingBountyWithId = await Bounty.findOne({ contractId: latestBountyId });
                  if (!existingBountyWithId || existingBountyWithId.id === savedBounty.id) {
                    // Safe to use this ID
                    savedBounty.contract_id = latestBountyId;
                    savedBounty.contractId = latestBountyId;
                    await savedBounty.save();
                    console.log(`✅ Updated saved bounty with contract_id: ${latestBountyId} (fallback)`);
                  } else {
                    console.error(`❌ Contract ID ${latestBountyId} is already taken by another bounty`);
                    console.error(`❌ This bounty will remain without a contract_id - manual intervention may be needed`);
                  }
                }
              } else {
                console.warn('⚠️ Bounty count is 0, cannot determine contract_id');
              }
            } catch (contractError) {
              console.error('❌ Could not fetch contract ID from contract state:', contractError);
              console.error('❌ Contract error details:', {
                message: contractError.message,
                stack: contractError.stack
              });
            }
          }
        } else {
          console.log(`✅ Contract_id already set: ${savedBounty.contract_id}`);
        }
      }
      
      console.log('✅ Bounty ID:', savedBounty.id);
      console.log('✅ Contract ID:', savedBounty.contract_id);
      console.log('✅ Client Address:', savedBounty.client_address);
      console.log('✅ Status:', savedBounty.status);
      
      // Verify the save by querying the database
      try {
        verifyBounty = await Bounty.findById(savedBounty.id);
        if (!verifyBounty) {
          console.error('❌ WARNING: Bounty was saved but cannot be retrieved from database!');
          throw new Error('Bounty save verification failed - bounty not found after save');
        }
        console.log('✅ Bounty save verified - can be retrieved from database');
        console.log('✅ Verified bounty contract_id:', verifyBounty.contract_id);
        
        // If contract_id is still missing after all attempts, log a critical warning
        if (!verifyBounty.contract_id || verifyBounty.contract_id === null) {
          console.error('❌ CRITICAL WARNING: Contract_id is still NULL after all attempts to fetch it!');
          console.error('❌ This bounty may need manual intervention to set contract_id');
          console.error('❌ Bounty ID:', verifyBounty.id);
          console.error('❌ Client Address:', verifyBounty.client_address);
        }
      } catch (verifyError) {
        console.error('❌ Error verifying saved bounty:', verifyError);
        // Don't fail the request if verification fails - the save might have succeeded
        // but there could be a delay in Supabase replication
        console.warn('⚠️ Continuing despite verification error - bounty may have been saved');
      }
    } catch (saveError) {
      console.error('❌ Error saving bounty to database:', saveError);
      console.error('❌ Save error details:', {
        message: saveError.message,
        code: saveError.code,
        details: saveError.details,
        hint: saveError.hint,
        stack: saveError.stack
      });
      
      // Check if it's a database connection error
      if (saveError.message && saveError.message.includes('Supabase client not initialized')) {
        console.error('❌ CRITICAL: Database not connected!');
        console.error('❌ Please check database configuration in backend/.env');
        return res.status(500).json({
          error: 'Database connection error',
          message: 'Database is not connected. Please check backend configuration.',
          details: 'Supabase client not initialized'
        });
      }
      
      // If it's a duplicate contract_id error, check if it's a real duplicate or a race condition
      if (saveError.code === '23505' || saveError.message.includes('duplicate') || saveError.message.includes('unique')) {
        console.log('🔄 Duplicate constraint detected, checking if this is a real duplicate...');
        
        // Check if the error is about contract_id uniqueness
        const isContractIdDuplicate = saveError.message?.includes('contract_id') || 
                                      saveError.details?.includes('contract_id') ||
                                      saveError.hint?.includes('contract_id');
        
        if (isContractIdDuplicate && bountyData.contractId !== null && bountyData.contractId !== undefined) {
          // This is a duplicate contract_id - find and return existing bounty
          try {
            const existingBounty = await Bounty.findOne({ contractId: bountyData.contractId });
            if (existingBounty) {
              console.log('✅ Found existing bounty with contract_id:', bountyData.contractId);
              
              // Check if transaction IDs match (same creation attempt)
              const existingTxId = existingBounty.create_transaction_id || existingBounty.createTransactionId;
              const newTxId = bountyData.transactionId || bountyData.createTransactionId;
              
              if (existingTxId && newTxId && existingTxId === newTxId) {
                // Same transaction - this is an idempotent retry, return existing
                console.log('✅ Same transaction ID - returning existing bounty (idempotent)');
                const existingBountyData = existingBounty.toObject ? existingBounty.toObject() : existingBounty;
                return res.status(200).json({
                  ...existingBountyData,
                  message: 'Bounty already exists with this contract ID and transaction ID',
                  smartContract: {
                    action: 'create_bounty',
                    required: {
                      payment: {
                        amount: existingBounty.amount,
                        to: process.env.REACT_APP_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS || 'ZS2EW3YGUDATK5OH4S7QUPMIJ4T6ROU6OFJEAGKFD2RSEHPSOCJ3BZBFLU',
                        note: 'AlgoEase: Bounty Payment'
                      },
                      appCall: {
                        method: 'create_bounty',
                        args: [
                          Math.round(existingBounty.amount * 1000000),
                          Math.floor(new Date(existingBounty.deadline).getTime() / 1000),
                          (existingBounty.title ? `${existingBounty.title}\n\n${existingBounty.description}` : existingBounty.description).slice(0, 1000)
                        ],
                        accounts: [existingBounty.verifierAddress || existingBounty.clientAddress]
                      }
                    }
                  }
                });
              } else {
                // Different transaction ID - this is a real duplicate contract_id
                // This shouldn't happen in normal flow, but handle it gracefully
                console.warn('⚠️ Duplicate contract_id with different transaction ID - this may indicate an issue');
                console.warn('⚠️ Existing txId:', existingTxId, 'New txId:', newTxId);
                
                // Return existing bounty but warn about the duplicate
                const existingBountyData = existingBounty.toObject ? existingBounty.toObject() : existingBounty;
                return res.status(200).json({
                  ...existingBountyData,
                  message: 'Bounty with this contract ID already exists. If you intended to create a new bounty, please check the contract ID.',
                  warning: 'Duplicate contract_id detected'
                });
              }
            }
          } catch (findError) {
            console.error('❌ Error finding existing bounty:', findError);
          }
        } else {
          // Not a contract_id duplicate - might be another unique constraint
          // In this case, we should still try to create a new bounty
          console.warn('⚠️ Duplicate constraint error but not related to contract_id:', saveError.message);
          console.warn('⚠️ This might be a database constraint issue - allowing creation to proceed');
        }
        
        // If we can't handle it as a duplicate, return error
        return res.status(409).json({
          error: 'Duplicate entry',
          message: saveError.message || 'A bounty with these details already exists',
          details: saveError.details || saveError.hint
        });
      }
      
      // Return detailed error for debugging
      return res.status(500).json({
        error: 'Database save failed',
        message: saveError.message,
        details: process.env.NODE_ENV === 'development' ? {
          code: saveError.code,
          hint: saveError.hint,
          details: saveError.details
        } : undefined
      });
    }

    // Use the saved bounty for response (use verified data if available, otherwise use saved)
    // Ensure we have the latest data, especially contract_id
    let finalBounty = savedBounty;
    if (verifyBounty) {
      finalBounty = verifyBounty;
    }
    
    // Double-check contract_id is in the response
    if (!finalBounty.contract_id && bountyData.contractId) {
      console.log('⚠️ Contract ID missing in response, attempting to reload...');
      try {
        const reloaded = await Bounty.findById(finalBounty.id);
        if (reloaded && reloaded.contract_id) {
          finalBounty = reloaded;
          console.log('✅ Reloaded bounty with contract_id:', reloaded.contract_id);
        }
      } catch (reloadError) {
        console.warn('⚠️ Could not reload bounty:', reloadError.message);
      }
    }
    
    const savedBountyData = (finalBounty && finalBounty.toObject) ? finalBounty.toObject() : (finalBounty || savedBounty);
    
    const responseData = {
      ...savedBountyData,
      smartContract: {
        action: 'create_bounty',
        required: {
          payment: {
            amount: savedBounty.amount,
            to: process.env.REACT_APP_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS || 'M4RDVCJZ3KESIMZB6V4Z2ZMWPTQ4SOWDPBMXNPHFHSYSVOILAPIIDBXN3Q', // Bounty Escrow Contract address
            note: 'AlgoEase: Bounty Payment'
          },
          appCall: {
            method: 'create_bounty',
            args: [
              Math.round(savedBounty.amount * 1000000), // Convert to microALGO
              (savedBounty.title ? `${savedBounty.title}\n\n${savedBounty.description}` : savedBounty.description).slice(0, 1000) // Task description
              // New contract: no deadline, no verifier
            ],
            accounts: [] // New contract: no accounts needed
          }
        }
      }
    };

    console.log('📤 Sending response with saved bounty data:', {
      id: responseData.id,
      contractId: responseData.contractId,
      status: responseData.status,
      hasId: !!responseData.id,
      hasContractId: !!responseData.contractId
    });
    
    // CRITICAL: Ensure we have an ID before sending response
    if (!responseData.id) {
      console.error('❌ CRITICAL: Response data missing ID!', responseData);
      // Try to reload the bounty one more time
      try {
        if (finalBounty && finalBounty.id) {
          const reloaded = await Bounty.findById(finalBounty.id);
          if (reloaded && reloaded.id) {
            const reloadedData = reloaded.toObject ? reloaded.toObject() : reloaded;
            responseData = {
              ...reloadedData,
              smartContract: responseData.smartContract
            };
            console.log('✅ Reloaded bounty with ID:', reloadedData.id);
          }
        }
      } catch (reloadError) {
        console.error('❌ Failed to reload bounty:', reloadError);
      }
      
      // If still no ID, return error but include the data we have
      if (!responseData.id) {
        return res.status(500).json({
          error: 'Bounty saved but missing ID in response',
          message: 'The bounty was saved to the database but the response is missing the ID. Please check the database.',
          savedData: responseData
        });
      }
    }
    
    console.log('✅ Sending successful response with bounty:', {
      id: responseData.id,
      contractId: responseData.contractId,
      title: responseData.title,
      status: responseData.status
    });
    
    res.status(201).json(responseData);
  } catch (error) {
    console.error('❌ Error creating bounty:', error);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ Error details:', {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });
    res.status(500).json({ 
      error: 'Failed to create bounty',
      message: error.message,
      details: error.details || error.hint || 'Unknown error'
    });
  }
});

// Update bounty (only by client)
router.put('/:id', authenticate, async (req, res) => {
  try {
    // Try to find by contract_id first, then by database id
    let bounty = await Bounty.findOne({ contractId: req.params.id });
    if (!bounty) {
      bounty = await Bounty.findById(req.params.id);
    }
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }

    // Allow update if client address matches OR if updating contract_id (for post-creation sync)
    const isUpdatingContractId = req.body.contractId && !bounty.contract_id && !bounty.contractId;
    const clientAddr = (bounty.clientAddress || bounty.client_address || '').toUpperCase().trim();
    const userAddr = (req.user?.address || '').toUpperCase().trim();
    
    if (!isUpdatingContractId && clientAddr !== userAddr) {
      return res.status(403).json({ error: 'Not authorized to update this bounty' });
    }

    if (bounty.status !== 'open' && !isUpdatingContractId) {
      return res.status(400).json({ error: 'Cannot update bounty that is not open' });
    }

    // Update bounty fields
    // CRITICAL: Always update contractId if provided (even if null, to allow clearing)
    if (req.body.hasOwnProperty('contractId')) {
      const contractIdValue = req.body.contractId;
      console.log('💾 Updating contractId:', {
        old: bounty.contract_id,
        new: contractIdValue,
        type: typeof contractIdValue
      });
      
      // Validate contractId is numeric if provided
      if (contractIdValue !== null && contractIdValue !== undefined && contractIdValue !== '') {
        const contractIdNum = typeof contractIdValue === 'string' ? parseInt(contractIdValue, 10) : contractIdValue;
        if (!isNaN(contractIdNum) && isFinite(contractIdNum) && contractIdNum >= 0) {
          bounty.contract_id = contractIdNum;
          bounty.contractId = contractIdNum;
          console.log('✅ ContractId validated and set:', contractIdNum);
        } else {
          console.error('❌ Invalid contractId value:', contractIdValue, '(expected numeric)');
          return res.status(400).json({ 
            error: 'Invalid contract ID',
            message: 'Contract ID must be a valid number'
          });
        }
      } else {
        // Allow setting to null to clear contract_id
        bounty.contract_id = null;
        bounty.contractId = null;
        console.log('⚠️ ContractId set to null');
      }
    }
    if (req.body.status) {
      bounty.status = req.body.status;
    }
    // Allow other fields to be updated
    Object.keys(req.body).forEach(key => {
      if (key !== 'contractId' && key !== 'id' && key !== 'contract_id') {
        const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        if (bounty.hasOwnProperty(snakeKey) || bounty.hasOwnProperty(key)) {
          bounty[snakeKey] = req.body[key];
          bounty[key] = req.body[key];
        }
      }
    });
    
    await bounty.save();
    
    // Verify contract_id was saved if it was updated
    if (req.body.hasOwnProperty('contractId')) {
      const expectedContractId = req.body.contractId !== null && req.body.contractId !== undefined && req.body.contractId !== '' 
        ? (typeof req.body.contractId === 'string' ? parseInt(req.body.contractId, 10) : req.body.contractId)
        : null;
      
      if (bounty.contract_id !== expectedContractId) {
        console.warn('⚠️ Contract ID may not have been saved correctly. Expected:', expectedContractId, 'Got:', bounty.contract_id);
        // Try to reload to get the latest data
        try {
          const reloaded = await Bounty.findById(bounty.id);
          if (reloaded && reloaded.contract_id === expectedContractId) {
            bounty = reloaded;
            console.log('✅ Reloaded bounty with correct contract_id:', reloaded.contract_id);
          }
        } catch (reloadError) {
          console.warn('⚠️ Could not reload bounty:', reloadError.message);
        }
      } else {
        console.log('✅ Contract ID verified in saved bounty:', bounty.contract_id);
      }
    }
    
    const responseData = bounty.toObject ? bounty.toObject() : bounty;
    console.log('📤 Sending updated bounty response:', {
      id: responseData.id,
      contractId: responseData.contractId,
      contract_id: responseData.contract_id
    });

    res.json(responseData);
  } catch (error) {
    console.error('Error updating bounty:', error);
    res.status(500).json({ error: 'Failed to update bounty', message: error.message });
  }
});

// Submit work for bounty
router.post('/:id/submit', authenticate, async (req, res) => {
  try {
    const { description, links } = req.body;
    
    // Try to find by contract_id first, then by database id
    let bounty = await Bounty.findOne({ contractId: req.params.id });
    if (!bounty) {
      bounty = await Bounty.findById(req.params.id);
    }
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }

    if (bounty.status !== 'accepted') {
      return res.status(400).json({ error: 'Bounty must be accepted before submitting work' });
    }

    // Verify freelancer address matches
    const bountyObj = bounty.toObject ? bounty.toObject() : bounty;
    const rawFreelancerAddr = bounty.freelancerAddress || bounty.freelancer_address || 
                              bountyObj.freelancerAddress || bountyObj.freelancer_address ||
                              bounty.freelancer || bountyObj.freelancer;
    const freelancerAddr = rawFreelancerAddr ? (rawFreelancerAddr || '').toUpperCase().trim() : null;
    const userAddr = (req.user.address || '').toUpperCase().trim();
    
    console.log('🔍 Checking freelancer for submission:', {
      rawFreelancerAddr,
      freelancerAddr,
      userAddr,
      hasFreelancer: !!freelancerAddr,
      match: freelancerAddr ? freelancerAddr === userAddr : 'no freelancer set',
      bountyId: req.params.id,
      bountyStatus: bounty.status,
      bountyObject: {
        freelancerAddress: bounty.freelancerAddress,
        freelancer_address: bounty.freelancer_address,
        id: bounty.id,
        contractId: bounty.contract_id || bounty.contractId
      }
    });

    // Verify freelancer matches
    if (freelancerAddr && freelancerAddr !== userAddr) {
      return res.status(403).json({ 
        error: 'Only the freelancer who accepted the bounty can submit work',
        expected: freelancerAddr,
        received: userAddr
      });
    }
    
    // If no freelancer address is set, set it to the current user
    if (!freelancerAddr) {
      console.log('📝 No freelancer address set, setting it to current user:', userAddr);
      bounty.freelancerAddress = req.user.address;
      bounty.freelancer_address = req.user.address;
      await bounty.save();
    }

    // Validate contract ID exists
    const contractId = bounty.contract_id || bounty.contractId;
    if (!contractId) {
      return res.status(400).json({ error: 'Bounty does not have a contract ID' });
    }

    // Store submission data
    const submission = {
      freelancerAddress: req.user.address,
      description,
      links: links || []
    };

    bounty.submissions.push(submission);
    bounty.status = 'submitted'; // Update status to submitted
    await bounty.save();

    res.json({ 
      message: 'Work submitted successfully', 
      submission,
      bounty: bounty.toObject ? bounty.toObject() : bounty,
      smartContract: {
        action: 'submit_bounty',
        required: {
          appCall: {
            method: 'submit_bounty',
            args: [contractId],
            accounts: []
          }
        }
      }
    });
  } catch (error) {
    console.error('Error submitting work:', error);
    res.status(500).json({ error: 'Failed to submit work', message: error.message });
  }
});

// Get user's bounties
router.get('/user/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { type = 'all' } = req.query;

    console.log('📥 Fetching user bounties:', {
      address,
      type,
      url: req.url
    });

    let filter = {};
    if (type === 'created') {
      filter.clientAddress = address;
    } else if (type === 'accepted') {
      filter.freelancerAddress = address;
    } else {
      filter.$or = [
        { clientAddress: address },
        { freelancerAddress: address }
      ];
    }

    console.log('🔍 Filter:', JSON.stringify(filter, null, 2));

    const bounties = await Bounty.find(filter, {
      sort: { created_at: -1 },
      select: '-submissions'
    });

    console.log('📊 Found bounties:', bounties.length);
    if (bounties.length > 0) {
      console.log('📋 First bounty sample:', JSON.stringify(bounties[0].toObject ? bounties[0].toObject() : bounties[0], null, 2));
    }

    const bountyObjects = bounties.map(bounty => 
      bounty.toObject ? bounty.toObject() : bounty
    );

    console.log('✅ Returning', bountyObjects.length, 'bounties');
    res.json(bountyObjects);
  } catch (error) {
    console.error('❌ Error fetching user bounties:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to fetch user bounties', message: error.message });
  }
});

// Smart contract interaction endpoints
router.post('/:id/accept', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    console.log('📥 Accepting bounty with ID:', id);
    
    // Validate that id is not an address (addresses are 58 chars, UUIDs are 36, contract IDs are numeric)
    // If it looks like an address, it's definitely not a valid ID
    if (id && id.length === 58 && /^[A-Z2-7]{58}$/.test(id)) {
      return res.status(400).json({ 
        error: 'Invalid bounty ID',
        message: 'The provided ID appears to be an Algorand address, not a bounty ID. Please use the bounty database ID or contract ID.'
      });
    }
    
    // Try to find by contract_id first (only if id is numeric), then by database id
    let bounty = null;
    const contractIdNum = parseInt(id, 10);
    if (!isNaN(contractIdNum) && isFinite(contractIdNum)) {
      // id is numeric, try finding by contract_id
      bounty = await Bounty.findOne({ contractId: contractIdNum });
    }
    
    // If not found by contract_id, try by database id (UUID)
    if (!bounty) {
      bounty = await Bounty.findById(id);
    }
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }

    // Check status case-insensitively
    const bountyStatus = (bounty.status || '').toLowerCase().trim();
    const hasFreelancer = !!(bounty.freelancerAddress || bounty.freelancer_address);
    
    console.log('🔍 Checking bounty status for acceptance:', {
      rawStatus: bounty.status,
      normalizedStatus: bountyStatus,
      bountyId: id,
      isOpen: bountyStatus === 'open',
      hasFreelancer: hasFreelancer,
      freelancerAddress: bounty.freelancerAddress || bounty.freelancer_address
    });

    // Allow acceptance if:
    // 1. Status is 'open' (case-insensitive), OR
    // 2. Status is 'open' but has no freelancer set (might be a data inconsistency)
    if (bountyStatus !== 'open') {
      // If status is not 'open' but also has no freelancer, allow acceptance
      // (might be a data sync issue)
      if (!hasFreelancer) {
        console.warn('⚠️ Bounty status is not "open" but has no freelancer. Allowing acceptance:', {
          status: bounty.status,
          normalizedStatus: bountyStatus
        });
        // Continue - we'll update the status to 'accepted' below
      } else {
        console.error('❌ Bounty is not open for acceptance:', {
          status: bounty.status,
          normalizedStatus: bountyStatus,
          bountyId: id,
          hasFreelancer: hasFreelancer
        });
        return res.status(400).json({ 
          error: 'Bounty is not open for acceptance',
          details: {
            currentStatus: bounty.status,
            requiredStatus: 'open',
            hasFreelancer: hasFreelancer
          }
        });
      }
    }

    // Validate contract ID exists and is numeric
    const contractId = bounty.contract_id || bounty.contractId;
    if (!contractId) {
      return res.status(400).json({ error: 'Bounty does not have a contract ID. Please wait for the contract to be created.' });
    }
    
    // Ensure contract_id is numeric (not an address or string)
    const validatedContractId = typeof contractId === 'string' ? parseInt(contractId, 10) : contractId;
    if (isNaN(validatedContractId) || !isFinite(validatedContractId)) {
      console.error('❌ Invalid contract_id in bounty:', contractId, '(expected numeric)');
      return res.status(400).json({ 
        error: 'Invalid contract ID',
        message: 'The bounty has an invalid contract ID. Please contact support.'
      });
    }

    // Update bounty with freelancer - ensure both camelCase and snake_case are set
    const freelancerAddr = req.user.address;
    console.log('💾 Setting freelancer address:', {
      address: freelancerAddr,
      bountyId: id,
      contractId: validatedContractId,
      currentFreelancer: bounty.freelancerAddress || bounty.freelancer_address
    });
    
    // Ensure contract_id is set correctly (numeric)
    bounty.contract_id = validatedContractId;
    bounty.contractId = validatedContractId;
    bounty.freelancerAddress = freelancerAddr;
    bounty.freelancer_address = freelancerAddr;
    bounty.status = 'accepted';
    
    console.log('💾 Bounty before save:', {
      id: bounty.id,
      contractId: bounty.contract_id,
      freelancerAddress: bounty.freelancerAddress,
      freelancer_address: bounty.freelancer_address,
      status: bounty.status
    });
    
    await bounty.save();
    
    // Reload to verify it was saved correctly
    let savedBounty = null;
    if (!isNaN(validatedContractId) && isFinite(validatedContractId)) {
      savedBounty = await Bounty.findOne({ contractId: validatedContractId });
    }
    if (!savedBounty) {
      savedBounty = await Bounty.findById(bounty.id);
    }
    
    console.log('✅ Bounty after save:', {
      id: savedBounty?.id,
      contractId: savedBounty?.contract_id || savedBounty?.contractId,
      freelancerAddress: savedBounty?.freelancerAddress,
      freelancer_address: savedBounty?.freelancer_address,
      status: savedBounty?.status
    });

    res.json({
      message: 'Bounty accepted successfully',
      bounty: savedBounty ? (savedBounty.toObject ? savedBounty.toObject() : savedBounty) : null,
      smartContract: {
        action: 'accept_bounty',
        required: {
          appCall: {
            method: 'accept_bounty',
            args: [validatedContractId], // Use validated numeric contract ID
            accounts: []
          }
        }
      }
    });
  } catch (error) {
    console.error('Error accepting bounty:', error);
    res.status(500).json({ error: 'Failed to accept bounty', message: error.message });
  }
});

// Update transaction ID for a bounty action
router.patch('/:id/transaction', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { transactionId, action, contractId } = req.body; // action: 'accept', 'approve', 'reject', 'claim', 'refund'
    
    if (!transactionId || !action) {
      return res.status(400).json({ error: 'transactionId and action are required' });
    }
    
    // Validate action
    const validActions = ['create', 'accept', 'submit', 'approve', 'reject', 'claim', 'refund'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
    }
    
    // Find bounty
    let bounty = null;
    const contractIdNum = parseInt(id, 10);
    if (!isNaN(contractIdNum) && isFinite(contractIdNum)) {
      bounty = await Bounty.findOne({ contractId: contractIdNum });
    }
    if (!bounty) {
      bounty = await Bounty.findById(id);
    }
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }
    
    // CRITICAL: If contractId is provided, update it (especially for 'create' action)
    if (contractId !== undefined && contractId !== null && contractId !== '') {
      const newContractIdNum = typeof contractId === 'string' ? parseInt(contractId, 10) : contractId;
      if (!isNaN(newContractIdNum) && isFinite(newContractIdNum) && newContractIdNum >= 0) {
        console.log('💾 Updating contract_id:', {
          old: bounty.contract_id,
          new: newContractIdNum,
          action: action
        });
        bounty.contract_id = newContractIdNum;
        bounty.contractId = newContractIdNum;
      }
    }
    
    // Update the appropriate transaction ID field
    const transactionFieldMap = {
      'create': 'create_transaction_id',
      'accept': 'accept_transaction_id',
      'submit': 'submit_transaction_id',
      'approve': 'approve_transaction_id',
      'reject': 'reject_transaction_id',
      'claim': 'claim_transaction_id',
      'refund': 'refund_transaction_id'
    };
    
    const fieldName = transactionFieldMap[action];
    
    console.log('💾 Updating transaction ID:', {
      bountyId: id,
      action: action,
      fieldName: fieldName,
      transactionId: transactionId,
      contractId: contractId,
      currentValue: bounty[fieldName]
    });
    
    bounty[fieldName] = transactionId;
    
    // Also set camelCase version for consistency
    const camelCaseField = fieldName.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
    bounty[camelCaseField] = transactionId;
    
    console.log('💾 Bounty object before save:', {
      id: bounty.id,
      contract_id: bounty.contract_id,
      [fieldName]: bounty[fieldName],
      [camelCaseField]: bounty[camelCaseField]
    });
    
    await bounty.save();
    
    // Reload to verify it was saved
    const updatedBounty = await Bounty.findById(bounty.id);
    
    console.log('✅ Transaction ID and contract_id saved:', {
      fieldName: fieldName,
      savedValue: updatedBounty ? updatedBounty[fieldName] : 'NOT FOUND',
      contract_id: updatedBounty ? updatedBounty.contract_id : 'NOT FOUND',
      bountyId: updatedBounty?.id
    });
    
    res.json({
      message: `Transaction ID updated for ${action}`,
      transactionId: transactionId,
      action: action,
      contractId: updatedBounty ? updatedBounty.contract_id : null,
      bounty: updatedBounty ? (updatedBounty.toObject ? updatedBounty.toObject() : updatedBounty) : null
    });
  } catch (error) {
    console.error('❌ Error updating transaction ID:', error);
    console.error('❌ Error details:', {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      stack: error.stack
    });
    res.status(500).json({ 
      error: 'Failed to update transaction ID', 
      message: error.message,
      details: error.details || error.hint
    });
  }
});

router.post('/:id/approve', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    console.log('📥 Approving bounty with ID:', id);
    
    // Try to find by contract_id first, then by database id
    let bounty = await Bounty.findOne({ contractId: id });
    if (!bounty) {
      bounty = await Bounty.findById(id);
    }
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }

    // New contract: Only creator (client) can approve (no verifier)
    const clientAddr = (bounty.clientAddress || bounty.client_address || '').toUpperCase().trim();
    const userAddr = (req.user.address || '').toUpperCase().trim();
    
    if (clientAddr !== userAddr) {
      return res.status(403).json({ error: 'Only the creator can approve this bounty' });
    }

    if (bounty.status !== 'submitted') {
      return res.status(400).json({ error: 'Bounty must be submitted before approval' });
    }

    // Validate contract ID exists
    if (!bounty.contract_id && !bounty.contractId) {
      return res.status(400).json({ error: 'Bounty does not have a contract ID' });
    }

    // Update bounty status to 'approved' (funds stay in escrow, freelancer must claim)
    // Note: This is called AFTER the contract transaction succeeds in the frontend
    bounty.status = 'approved';
    await bounty.save();

    const contractId = bounty.contract_id || bounty.contractId;
    res.json({
      message: 'Bounty approved successfully - freelancer can now claim the funds',
      bounty: bounty.toObject ? bounty.toObject() : bounty,
      smartContract: {
        action: 'approve_bounty',
        required: {
          appCall: {
            method: 'approve_bounty',
            args: [contractId],
            accounts: [] // No accounts needed - just changes status
          }
        }
      }
    });
  } catch (error) {
    console.error('Error approving bounty:', error);
    res.status(500).json({ error: 'Failed to approve bounty', message: error.message });
  }
});

router.post('/:id/reject', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    console.log('📥 Rejecting bounty with ID:', id);
    
    // Try to find by contract_id first, then by database id
    let bounty = await Bounty.findOne({ contractId: id });
    if (!bounty) {
      bounty = await Bounty.findById(id);
    }
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }

    // New contract: Only creator (client) can reject (no verifier)
    const clientAddr = (bounty.clientAddress || bounty.client_address || '').toUpperCase().trim();
    const userAddr = (req.user.address || '').toUpperCase().trim();
    
    if (clientAddr !== userAddr) {
      return res.status(403).json({ error: 'Only the creator can reject this bounty' });
    }

    // Can reject if status is submitted or accepted
    if (bounty.status !== 'submitted' && bounty.status !== 'accepted') {
      return res.status(400).json({ error: 'Bounty must be accepted or submitted before rejection' });
    }

    // Validate contract ID exists
    if (!bounty.contract_id && !bounty.contractId) {
      return res.status(400).json({ error: 'Bounty does not have a contract ID' });
    }

    // Update bounty status to rejected (we use reject_bounty function on contract)
    bounty.status = 'rejected';
    await bounty.save();

    const contractId = bounty.contract_id || bounty.contractId;
    res.json({
      message: 'Bounty rejected successfully',
      smartContract: {
        action: 'reject_bounty',
        required: {
          appCall: {
            method: 'reject_bounty',
            args: [contractId],
            accounts: []
          }
        }
      }
    });
  } catch (error) {
    console.error('Error rejecting bounty:', error);
    res.status(500).json({ error: 'Failed to reject bounty', message: error.message });
  }
});

router.post('/:id/claim', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    console.log('📥 Claiming bounty with ID:', id);
    
    // Try to find by contract_id first, then by database id
    let bounty = await Bounty.findOne({ contractId: id });
    if (!bounty) {
      bounty = await Bounty.findById(id);
    }
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }

    if (bounty.freelancerAddress !== req.user.address && bounty.freelancer_address !== req.user.address) {
      return res.status(403).json({ error: 'Only the freelancer can claim this bounty' });
    }

    if (bounty.status !== 'approved') {
      return res.status(400).json({ error: 'Bounty must be approved before claiming' });
    }

    // Validate contract ID exists
    if (!bounty.contract_id && !bounty.contractId) {
      return res.status(400).json({ error: 'Bounty does not have a contract ID' });
    }

    // Update bounty status
    bounty.status = 'claimed';
    await bounty.save();

    const contractId = bounty.contract_id || bounty.contractId;
    res.json({
      message: 'Bounty claimed successfully',
      smartContract: {
        action: 'claim',
        required: {
          appCall: {
            method: 'claim',
            args: [contractId],
            accounts: []
          }
        }
      }
    });
  } catch (error) {
    console.error('Error claiming bounty:', error);
    res.status(500).json({ error: 'Failed to claim bounty', message: error.message });
  }
});

router.post('/:id/refund', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    console.log('📥 Refunding bounty with ID:', id);
    
    // Try to find by contract_id first, then by database id
    let bounty = await Bounty.findOne({ contractId: id });
    if (!bounty) {
      bounty = await Bounty.findById(id);
    }
    
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }

    // New contract: Only creator (client) can refund (no verifier)
    const clientAddr = bounty.clientAddress || bounty.client_address;
    
    if (clientAddr !== req.user.address) {
      return res.status(403).json({ error: 'Only the creator can refund this bounty' });
    }

    if (bounty.status === 'claimed' || bounty.status === 'refunded' || bounty.status === 'rejected') {
      return res.status(400).json({ error: 'Bounty cannot be refunded' });
    }

    // Validate contract ID exists
    if (!bounty.contract_id && !bounty.contractId) {
      return res.status(400).json({ error: 'Bounty does not have a contract ID' });
    }

    // Update status to refunded
    bounty.status = 'refunded';
    await bounty.save();

    const contractId = bounty.contract_id || bounty.contractId;
    res.json({
      message: 'Bounty refunded successfully',
      smartContract: {
        action: 'refund',
        required: {
          appCall: {
            method: 'refund',
            args: [contractId],
            accounts: []
          }
        }
      }
    });
  } catch (error) {
    console.error('Error refunding bounty:', error);
    res.status(500).json({ error: 'Failed to refund bounty', message: error.message });
  }
});

router.post('/:id/auto-refund', async (req, res) => {
  // New contract doesn't support auto-refund (no deadline field)
  return res.status(400).json({ 
    error: 'Auto-refund not supported',
    message: 'The new contract does not support auto-refund because it does not use deadlines. Use the reject or refund endpoints instead.'
  });
});

/**
 * Fetch contract ID from blockchain for a bounty
 * POST /api/bounties/:id/fetch-contract-id
 * This endpoint attempts to fetch the contract ID (bounty ID) from the blockchain
 * by checking the transaction ID or by matching the bounty with on-chain data
 */
router.post('/:id/fetch-contract-id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('📥 Fetching contract ID from blockchain for bounty:', id);
    
    // Find bounty by database ID
    let bounty = await Bounty.findById(id);
    if (!bounty) {
      return res.status(404).json({ error: 'Bounty not found' });
    }
    
    // If contract ID already exists, return it
    if (bounty.contract_id && bounty.contract_id !== null) {
      return res.json({
        message: 'Contract ID already exists',
        contractId: bounty.contract_id,
        bounty: bounty.toObject ? bounty.toObject() : bounty
      });
    }
    
    // Try to fetch from transaction ID first
    const transactionId = bounty.create_transaction_id || bounty.createTransactionId;
    if (transactionId) {
      try {
        const algosdk = require('algosdk');
        const indexerClient = new algosdk.Indexer(
          process.env.ALGOD_TOKEN || '',
          process.env.INDEXER_SERVER || 'https://testnet-idx.algonode.cloud',
          process.env.ALGOD_PORT || ''
        );
        
        console.log(`🔍 Looking up transaction: ${transactionId}`);
        const txInfo = await indexerClient.lookupTransactionByID(transactionId).do();
        
        // Check global state delta for bounty_count change
        if (txInfo['global-state-delta']) {
          for (const delta of txInfo['global-state-delta']) {
            const key = Buffer.from(delta.key, 'base64').toString('utf8');
            if (key === 'bounty_count' && delta.value) {
              const newCount = delta.value.uint || 0;
              if (newCount > 0) {
                const bountyId = newCount - 1; // New bounty ID is count - 1
                console.log(`✅ Got bounty ID ${bountyId} from transaction state delta (count: ${newCount})`);
                
                // Verify this bounty matches by checking the box
                try {
                  const appId = parseInt(process.env.CONTRACT_APP_ID || process.env.REACT_APP_CONTRACT_APP_ID || '749707697');
                  const prefix = Buffer.from('bounty_', 'utf8');
                  const bountyIdBytes = algosdk.encodeUint64(bountyId);
                  const boxNameBytes = Buffer.concat([prefix, Buffer.from(bountyIdBytes)]);
                  const boxNameBase64 = boxNameBytes.toString('base64');
                  
                  // Wait a bit for box to be indexed (retry with delay)
                  let boxValue = null;
                  for (let retry = 0; retry < 5; retry++) {
                    try {
                      if (retry > 0) {
                        console.log(`⏳ Waiting ${retry * 1000}ms for box to be indexed (retry ${retry}/5)...`);
                        await new Promise(resolve => setTimeout(resolve, retry * 1000));
                      }
                      boxValue = await indexerClient.lookupApplicationBoxByIDandName(
                        appId,
                        boxNameBase64
                      ).do();
                      if (boxValue && boxValue.value) break;
                    } catch (boxRetryError) {
                      if (retry === 4) throw boxRetryError;
                      continue;
                    }
                  }
                  
                  if (boxValue && boxValue.value) {
                    const boxData = Buffer.from(boxValue.value, 'base64');
                    const data = new Uint8Array(boxData);
                    
                    if (data.length >= 32) {
                      const boxClientAddr = algosdk.encodeAddress(data.slice(0, 32));
                      const savedClientAddr = (bounty.client_address || bounty.clientAddress || '').toUpperCase().trim();
                      const boxClientAddrUpper = boxClientAddr.toUpperCase().trim();
                      
                      console.log(`🔍 Verifying bounty match - Box client: ${boxClientAddrUpper}, Saved client: ${savedClientAddr}`);
                      
                      // If addresses match, this is the correct bounty
                      if (boxClientAddrUpper === savedClientAddr) {
                        console.log(`✅ Addresses match! Using contract_id: ${bountyId}`);
                        bounty.contract_id = bountyId;
                        bounty.contractId = bountyId;
                        await bounty.save();
                        console.log(`✅ Updated bounty with contract_id: ${bountyId}`);
                        
                        return res.json({
                          message: 'Contract ID fetched successfully from transaction',
                          contractId: bountyId,
                          source: 'transaction_state_delta',
                          bounty: bounty.toObject ? bounty.toObject() : bounty
                        });
                      } else {
                        console.warn(`⚠️ Addresses don't match. This might not be the correct bounty.`);
                      }
                    }
                  }
                } catch (boxError) {
                  console.warn('⚠️ Could not verify box, but using bounty ID from transaction:', boxError.message);
                }
                
                // Use the bounty ID from transaction even if box verification fails
                bounty.contract_id = bountyId;
                bounty.contractId = bountyId;
                await bounty.save();
                console.log(`✅ Updated bounty with contract_id: ${bountyId} (from transaction)`);
                
                return res.json({
                  message: 'Contract ID fetched successfully from transaction',
                  contractId: bountyId,
                  source: 'transaction_state_delta',
                  verified: false,
                  bounty: bounty.toObject ? bounty.toObject() : bounty
                });
              }
            }
          }
        }
      } catch (txError) {
        console.warn('⚠️ Could not get contract ID from transaction:', txError.message);
      }
    }
    
    // Fallback: Try to match by checking recent bounties on-chain
    try {
      const algosdk = require('algosdk');
      const algodClient = new algosdk.Algodv2(
        process.env.ALGOD_TOKEN || '',
        process.env.ALGOD_SERVER || 'https://testnet-api.algonode.cloud',
        process.env.ALGOD_PORT || ''
      );
      const appId = parseInt(process.env.CONTRACT_APP_ID || process.env.REACT_APP_CONTRACT_APP_ID || '749707697');
      
      const appInfo = await algodClient.getApplicationByID(appId).do();
      const globalState = {};
      if (appInfo.params['global-state']) {
        appInfo.params['global-state'].forEach(state => {
          const key = Buffer.from(state.key, 'base64').toString();
          if (state.value.type === 1) {
            globalState[key] = state.value.uint;
          }
        });
      }
      
      const bountyCount = globalState['bounty_count'] || 0;
      console.log(`📊 Bounty count from contract: ${bountyCount}`);
      
      if (bountyCount > 0) {
        const indexerClient = new algosdk.Indexer(
          process.env.ALGOD_TOKEN || '',
          process.env.INDEXER_SERVER || 'https://testnet-idx.algonode.cloud',
          process.env.ALGOD_PORT || ''
        );
        
        const savedClientAddr = (bounty.client_address || bounty.clientAddress || '').toUpperCase().trim();
        const savedAmount = Math.round(parseFloat(bounty.amount || 0) * 1000000);
        
        // Check the last few bounties to find the one that matches
        let foundBountyId = null;
        for (let i = bountyCount - 1; i >= Math.max(0, bountyCount - 10); i--) {
          try {
            const prefix = Buffer.from('bounty_', 'utf8');
            const bountyIdBytes = algosdk.encodeUint64(i);
            const boxNameBytes = Buffer.concat([prefix, Buffer.from(bountyIdBytes)]);
            const boxNameBase64 = boxNameBytes.toString('base64');
            
            const boxValue = await indexerClient.lookupApplicationBoxByIDandName(
              appId,
              boxNameBase64
            ).do();
            
            if (boxValue && boxValue.value) {
              const boxData = Buffer.from(boxValue.value, 'base64');
              const data = new Uint8Array(boxData);
              
              if (data.length >= 73) {
                // Box format: client_addr(32) + freelancer_addr(32) + amount(8) + status(1) + task_desc(variable)
                const boxClientAddr = algosdk.encodeAddress(data.slice(0, 32));
                const boxAmount = algosdk.decodeUint64(new Uint8Array(data.slice(64, 72)));
                const boxClientAddrUpper = boxClientAddr.toUpperCase().trim();
                
                // Check if this matches our bounty
                if (boxClientAddrUpper === savedClientAddr && 
                    BigInt(savedAmount) === BigInt(boxAmount)) {
                  console.log(`✅ Found matching bounty! ID: ${i}, Client: ${boxClientAddrUpper}, Amount: ${savedAmount}`);
                  foundBountyId = i;
                  break;
                }
              }
            }
          } catch (boxError) {
            // Box might not exist or not be indexed yet - continue checking
            continue;
          }
        }
        
        if (foundBountyId !== null) {
          bounty.contract_id = foundBountyId;
          bounty.contractId = foundBountyId;
          await bounty.save();
          console.log(`✅ Updated bounty with contract_id: ${foundBountyId} (matched by client and amount)`);
          
          return res.json({
            message: 'Contract ID fetched successfully by matching on-chain data',
            contractId: foundBountyId,
            source: 'box_matching',
            bounty: bounty.toObject ? bounty.toObject() : bounty
          });
        }
      }
    } catch (contractError) {
      console.error('❌ Could not fetch contract ID from contract state:', contractError);
    }
    
    // If we couldn't find it, return error
    return res.status(404).json({
      error: 'Contract ID not found',
      message: 'Could not find the contract ID on the blockchain. The bounty may not have been created on-chain yet, or the transaction ID is missing.',
      suggestions: [
        'Ensure the bounty was created on-chain',
        'Check that the transaction ID is correct',
        'Wait a few moments and try again (blockchain indexing may be delayed)'
      ]
    });
  } catch (error) {
    console.error('❌ Error fetching contract ID:', error);
    res.status(500).json({ 
      error: 'Failed to fetch contract ID', 
      message: error.message 
    });
  }
});

module.exports = router;
