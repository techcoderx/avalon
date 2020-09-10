var CryptoJS = require('crypto-js')
const { randomBytes } = require('crypto')
const secp256k1 = require('secp256k1')
const bs58 = require('base-x')(config.b58Alphabet)
const series = require('run-series')
const cloneDeep = require('clone-deep')
const transaction = require('./transaction.js')
const notifications = require('./notifications.js')
var GrowInt = require('growint')
var default_replay_output = 100
var replay_output = process.env.REPLAY_OUTPUT || default_replay_output

class Block {
    constructor(index, phash, timestamp, txs, miner, missedBy, dist, burn, signature, hash) {
        this._id = index
        this.phash = phash.toString()
        this.timestamp = timestamp
        this.txs = txs
        this.miner = miner
        if (missedBy) this.missedBy = missedBy
        if (dist) this.dist = dist
        if (burn) this.burn = burn
        this.hash = hash
        this.signature = signature
    }
}

chain = {
    restoredBlocks: 0,
    schedule: null,
    recentBlocks: [],
    recentTxs: {},
    getNewKeyPair: () => {
        let privKey, pubKey
        do {
            privKey = randomBytes(config.randomBytesLength)
            pubKey = secp256k1.publicKeyCreate(privKey)
        } while (!secp256k1.privateKeyVerify(privKey))
    
        return {
            pub: bs58.encode(pubKey),        
            priv: bs58.encode(privKey)
        }
    },
    getGenesisBlock: () => {
        return new Block(
            0,
            '0',
            0,
            [],
            config.masterName,
            null,
            null,
            null,
            '0000000000000000000000000000000000000000000000000000000000000000',
            config.originHash
        )
    },
    prepareBlock: () => {
        var previousBlock = chain.getLatestBlock()
        var nextIndex = previousBlock._id + 1
        var nextTimestamp = new Date().getTime()
        // grab all transactions and sort by ts
        var txs = []
        var mempool = transaction.pool.sort(function(a,b){return a.ts-b.ts})
        loopOne:
        for (let i = 0; i < mempool.length; i++) {
            if (txs.length === config.maxTxPerBlock)
                break
            for (let y = 0; y < txs.length; y++)
                if (txs[y].sender === mempool[i].sender)
                    continue loopOne
            txs.push(mempool[i])
        }

        loopTwo:
        for (let i = 0; i < mempool.length; i++) {
            if (txs.length === config.maxTxPerBlock)
                break
            for (let y = 0; y < txs.length; y++)
                if (txs[y].hash === mempool[i].hash)
                    continue loopTwo
            txs.push(mempool[i])
        }
        txs = txs.sort(function(a,b){return a.ts-b.ts})
        transaction.removeFromPool(txs)
        var miner = process.env.NODE_OWNER
        return new Block(nextIndex, previousBlock.hash, nextTimestamp, txs, miner)
    },
    hashAndSignBlock: (block) => {
        var nextHash = chain.calculateHash(block._id, block.phash, block.timestamp, block.txs, block.miner, block.missedBy, block.distributed, block.burned)
        var signature = secp256k1.ecdsaSign(Buffer.from(nextHash, 'hex'), bs58.decode(process.env.NODE_OWNER_PRIV))
        signature = bs58.encode(signature.signature)
        return new Block(block._id, block.phash, block.timestamp, block.txs, block.miner, block.missedBy, block.distributed, block.burned, signature, nextHash)
        
    },
    canMineBlock: (cb) => {
        if (chain.shuttingDown) {
            cb(true, null); return
        }
        var newBlock = chain.prepareBlock()
        // run the transactions and validation
        // pre-validate our own block (not the hash and signature as we dont have them yet)
        // nor transactions because we will filter them on execution later
        chain.isValidNewBlock(newBlock, false, false, function(isValid) {
            if (!isValid) {
                cb(true, newBlock); return
            }
            cb(null, newBlock)
        })
    },
    mineBlock: (cb) => {
        if (chain.shuttingDown) return
        chain.canMineBlock(function(err, newBlock) {
            if (err) {
                cb(true, newBlock); return
            }

            // at this point transactions in the pool seem all validated
            // BUT with a different ts and without checking for double spend
            // so we will execute transactions in order and revalidate after each execution
            chain.executeBlockTransactions(newBlock, true, false, function(validTxs, distributed, burned) {
                cache.rollback()
                // and only add the valid txs to the new block
                newBlock.txs = validTxs

                if (distributed) newBlock.distributed = distributed
                if (burned) newBlock.burned = burned

                // always record the failure of others
                if (chain.schedule.shuffle[(newBlock._id-1)%config.leaders].name !== process.env.NODE_OWNER)
                    newBlock.missedBy = chain.schedule.shuffle[(newBlock._id-1)%config.leaders].name

                // hash and sign the block with our private key
                newBlock = chain.hashAndSignBlock(newBlock)
                
                // push the new block to consensus possible blocks
                // and go straight to end of round 0 to skip re-validating the block
                var possBlock = {
                    block: newBlock
                }
                for (let r = 0; r < config.consensusRounds; r++)
                    possBlock[r] = []

                logr.debug('Mined a new block, proposing to consensus')

                possBlock[0].push(process.env.NODE_OWNER)
                consensus.possBlocks.push(possBlock)
                consensus.endRound(0, newBlock)
                cb(null, newBlock)
            })
        })
    },
    validateAndAddBlock: (newBlock, revalidate, cb) => {
        // when we receive an outside block and check whether we should add it to our chain or not
        if (chain.shuttingDown) return
        chain.isValidNewBlock(newBlock, revalidate, revalidate, function(isValid) {
            if (!isValid) {
                logr.error('Invalid block')
                cb(true, newBlock); return
            }
            // straight execution
            chain.executeBlockTransactions(newBlock, false, true, function(validTxs, distributed, burned) {
                // if any transaction is wrong, thats a fatal error
                // transactions should have been verified in isValidNewBlock
                if (newBlock.txs.length !== validTxs.length) {
                    logr.fatal('Invalid tx(s) in block found after starting execution')
                    cb(true, newBlock); return
                }

                // error if distributed or burned computed amounts are different than the reported one
                var blockDist = newBlock.dist || 0
                if (blockDist !== distributed) {
                    logr.error('Wrong dist amount', blockDist, distributed)
                    cb(true, newBlock); return
                }
                var blockBurn = newBlock.burn || 0
                if (blockBurn !== burned) {
                    logr.error('Wrong burn amount', blockBurn, burned)
                    cb(true, newBlock); return
                }

                // remove all transactions from this block from our transaction pool
                transaction.removeFromPool(newBlock.txs)

                chain.addBlock(newBlock, function() {
                    // and broadcast to peers (if not replaying)
                    if (!p2p.recovering)
                        p2p.broadcastBlock(newBlock)

                    // process notifications (non blocking)
                    notifications.processBlock(newBlock)

                    // emit event to confirm new transactions in the http api
                    for (let i = 0; i < newBlock.txs.length; i++)
                        transaction.eventConfirmation.emit(newBlock.txs[i].hash)

                    cb(null, newBlock)
                })
            })

            
        })
    },
    minerWorker: (block) => {
        if (p2p.recovering) return
        clearTimeout(chain.worker)

        if (chain.schedule.shuffle.length === 0) {
            logr.fatal('All leaders gave up their stake? Chain is over')
            process.exit(1)
        }

        var mineInMs = null
        // if we are the next scheduled witness, try to mine in time
        if (chain.schedule.shuffle[(block._id)%config.leaders].name === process.env.NODE_OWNER)
            mineInMs = config.blockTime
        // else if the scheduled leaders miss blocks
        // backups witnesses are available after each block time intervals
        else for (let i = 1; i < 2*config.leaders; i++)
            if (chain.recentBlocks[chain.recentBlocks.length - i]
            && chain.recentBlocks[chain.recentBlocks.length - i].miner === process.env.NODE_OWNER) {
                mineInMs = (i+1)*config.blockTime
                break
            }

        if (mineInMs) {
            mineInMs -= (new Date().getTime()-block.timestamp)
            mineInMs += 20
            logr.debug('Trying to mine in '+mineInMs+'ms')
            consensus.observer = false
            if (mineInMs < config.blockTime/2) {
                logr.warn('Slow performance detected, will not try to mine next block')
                return
            }
            chain.worker = setTimeout(function(){
                chain.mineBlock(function(error, finalBlock) {
                    if (error)
                        logr.warn('miner worker trying to mine but couldnt', finalBlock)
                })
            }, mineInMs)
        }
            
    },
    addBlock: (block, cb) => {
        // add the block in our own db
        db.collection('blocks').insertOne(block, function(err) {
            if (err) throw err
            // push cached accounts and contents to mongodb
            
            chain.cleanMemory()

            // update the config if an update was scheduled
            config = require('./config.js').read(block._id)

            eco.nextBlock()

            if (!p2p.recovering) {
                // if block id is mult of n leaders, reschedule next n blocks
                if (block._id % config.leaders === 0) 
                    chain.minerSchedule(block, function(minerSchedule) {
                        chain.schedule = minerSchedule
                        chain.recentBlocks.push(block)
                        chain.minerWorker(block)
                        chain.output(block)
                        cache.writeToDisk(function() {})
                        cb(true)
                    })
                else {
                    chain.recentBlocks.push(block)
                    chain.minerWorker(block)
                    chain.output(block)
                    cache.writeToDisk(function() {})
                    cb(true)
                }
            } else {
                // if we are recovering we wait for mongo to update
                cache.writeToDisk(function() {
                    if (block._id % config.leaders === 0) 
                        chain.minerSchedule(block, function(minerSchedule) {
                            chain.schedule = minerSchedule
                            chain.recentBlocks.push(block)
                            chain.minerWorker(block)
                            chain.output(block)
                            
                            cb(true)
                        })
                    else {
                        chain.recentBlocks.push(block)
                        chain.minerWorker(block)
                        chain.output(block)
                        cb(true)
                    }
                })
            }
        })
    },
    output: (block,rebuilding) => {
        chain.nextOutput.txs += block.txs.length
        if (block.dist)
            chain.nextOutput.dist += block.dist
        if (block.burn)
            chain.nextOutput.burn += block.burn

        if (block._id%replay_output === 0 || (!rebuilding && !p2p.recovering)) {
            var output = ''
            if (rebuilding)
                output += 'Rebuilt '

            output += '#'+block._id

            if (rebuilding)
                output += '/' + chain.restoredBlocks

            output += '  by '+block.miner

            output += '  '+chain.nextOutput.txs+' tx'
            if (chain.nextOutput.txs>1)
                output += 's'
            

            output += '  dist: '+chain.nextOutput.dist
            output += '  burn: '+chain.nextOutput.burn
            output += '  delay: '+ (new Date().getTime() - block.timestamp)

            if (block.missedBy)
                output += '  MISS: '+block.missedBy

            logr.info(output)
            chain.nextOutput = {
                txs: 0,
                dist: 0,
                burn: 0
            }
        }
            
    },
    nextOutput: {
        txs: 0,
        dist: 0,
        burn: 0
    },
    isValidPubKey: (key) => {
        try {
            return secp256k1.publicKeyVerify(bs58.decode(key))
        } catch (error) {
            return false
        }
    },
    isValidSignature: (user, txType, hash, sign, cb) => {
        // verify signature and bandwidth
        cache.findOne('accounts', {name: user}, function(err, account) {
            if (err) throw err
            if (!account) {
                cb(false); return
            }
            // main key can authorize all transactions
            var allowedPubKeys = [account.pub]
            // add all secondary keys having this transaction type as allowed keys
            if (account.keys && typeof txType === 'number' && Number.isInteger(txType))
                for (let i = 0; i < account.keys.length; i++) 
                    if (account.keys[i].types.indexOf(txType) > -1)
                        allowedPubKeys.push(account.keys[i].pub)

            // if there is no transaction type
            // it means we are verifying a block signature
            // so only the leader key is allowed
            if (txType === null)
                if (account.pub_leader)
                    allowedPubKeys = [account.pub_leader]
                else
                    allowedPubKeys = []
            
            for (let i = 0; i < allowedPubKeys.length; i++) {
                var bufferHash = Buffer.from(hash, 'hex')
                var b58sign = bs58.decode(sign)
                var b58pub = bs58.decode(allowedPubKeys[i])
                if (secp256k1.ecdsaVerify(b58sign, bufferHash, b58pub)) {
                    cb(account)
                    return
                }
            }
            cb(false)
        })
    },
    isValidHashAndSignature: (newBlock, cb) => {
        // and that the hash is correct
        var theoreticalHash = chain.calculateHashForBlock(newBlock)
        if (theoreticalHash !== newBlock.hash) {
            logr.debug(typeof (newBlock.hash) + ' ' + typeof theoreticalHash)
            logr.error('invalid hash: ' + theoreticalHash + ' ' + newBlock.hash)
            cb(false); return
        }

        // finally, verify the signature of the miner
        chain.isValidSignature(newBlock.miner, null, newBlock.hash, newBlock.signature, function(legitUser) {
            if (!legitUser) {
                logr.error('invalid miner signature')
                cb(false); return
            }
            cb(true)
        })
    },
    isValidBlockTxs: (newBlock, cb) => {
        chain.executeBlockTransactions(newBlock, true, false, function(validTxs) {
            cache.rollback()
            if (validTxs.length !== newBlock.txs.length) {
                logr.error('invalid block transaction')
                cb(false); return
            }
            cb(true)
        })
    },
    isValidNewBlock: (newBlock, verifyHashAndSignature, verifyTxValidity, cb) => {
        // verify all block fields one by one
        if (!newBlock._id || typeof newBlock._id !== 'number') {
            logr.error('invalid block _id')
            cb(false); return
        }
        if (!newBlock.phash || typeof newBlock.phash !== 'string') {
            logr.error('invalid block phash')
            cb(false); return
        }
        if (!newBlock.timestamp || typeof newBlock.timestamp !== 'number') {
            logr.error('invalid block timestamp')
            cb(false); return
        }
        if (!newBlock.txs || typeof newBlock.txs !== 'object' || !Array.isArray(newBlock.txs)) {
            logr.error('invalid block txs')
            cb(false); return
        }
        if (newBlock.txs.length > config.maxTxPerBlock) {
            logr.error('invalid block too many txs')
            cb(false); return
        }
        if (!newBlock.miner || typeof newBlock.miner !== 'string') {
            logr.error('invalid block miner')
            cb(false); return
        }
        if (verifyHashAndSignature && (!newBlock.hash || typeof newBlock.hash !== 'string')) {
            logr.error('invalid block hash')
            cb(false); return
        }
        if (verifyHashAndSignature && (!newBlock.signature || typeof newBlock.signature !== 'string')) {
            logr.error('invalid block signature')
            cb(false); return
        }
        if (newBlock.missedBy && typeof newBlock.missedBy !== 'string') 
            logr.error('invalid block missedBy')
           

        // verify that its indeed the next block
        var previousBlock = chain.getLatestBlock()
        if (previousBlock._id + 1 !== newBlock._id) {
            logr.error('invalid index')
            cb(false); return
        }
        // from the same chain
        if (previousBlock.hash !== newBlock.phash) {
            logr.error('invalid phash')
            cb(false); return
        }

        // check if miner isnt trying to fast forward time
        // this might need to be tuned in the future to allow for network delay / clocks desync / etc
        if (newBlock.timestamp > new Date().getTime() + config.maxDrift) {
            logr.error('timestamp from the future', newBlock.timestamp, new Date().getTime())
            cb(false); return
        }

        // check if miner is normal scheduled one
        var minerPriority = 0
        if (chain.schedule.shuffle[(newBlock._id-1)%config.leaders].name === newBlock.miner) 
            minerPriority = 1
        // allow miners of n blocks away
        // to mine after (n+1)*blockTime as 'backups'
        // so that the network can keep going even if 1,2,3...n node(s) have issues
        else
            for (let i = 1; i <= config.leaders; i++) {
                if (!chain.recentBlocks[chain.recentBlocks.length - i])
                    break
                if (chain.recentBlocks[chain.recentBlocks.length - i].miner === newBlock.miner) {
                    minerPriority = i+1
                    break
                }
            }
                

        if (minerPriority === 0) {
            logr.debug('unauthorized miner')
            cb(false); return
        }

        // check if new block isnt too early
        if (newBlock.timestamp - previousBlock.timestamp < minerPriority*config.blockTime) {
            logr.debug('block too early for miner with priority #'+minerPriority)
            cb(false); return
        }

        if (!verifyTxValidity) {
            if (!verifyHashAndSignature) {
                cb(true); return
            }
            chain.isValidHashAndSignature(newBlock, function(isValid) {
                if (!isValid) {
                    cb(false); return
                }
                cb(true)
            })
        } else
            chain.isValidBlockTxs(newBlock, function(isValid) {
                if (!isValid) {
                    cb(false); return
                }
                if (!verifyHashAndSignature) {
                    cb(true); return
                }
                chain.isValidHashAndSignature(newBlock, function(isValid) {
                    if (!isValid) {
                        cb(false); return
                    }
                    cb(true)
                })
            })
    },
    executeBlockTransactions: (block, revalidate, isFinal, cb) => {
        // revalidating transactions in orders if revalidate = true
        // adding transaction to recent transactions (to prevent tx re-use) if isFinal = true
        var executions = []
        for (let i = 0; i < block.txs.length; i++) 
            executions.push(function(callback) {
                var tx = block.txs[i]
                if (revalidate)
                    transaction.isValid(tx, block.timestamp, function(isValid, error) {
                        if (isValid) 
                            transaction.execute(tx, block.timestamp, function(executed, distributed, burned) {
                                if (!executed) {
                                    logr.fatal('Tx execution failure', tx)
                                    process.exit(1)
                                }
                                if (isFinal)
                                    chain.recentTxs[tx.hash] = tx
                                callback(null, {
                                    executed: executed,
                                    distributed: distributed,
                                    burned: burned
                                })
                            })
                        else {
                            logr.debug(error, tx)
                            callback(null, false)
                        }
                    })
                else
                    transaction.execute(tx, block.timestamp, function(executed, distributed, burned) {
                        if (!executed)
                            logr.fatal('Tx execution failure', tx)
                        if (isFinal)
                            chain.recentTxs[tx.hash] = tx
                        callback(null, {
                            executed: executed,
                            distributed: distributed,
                            burned: burned
                        })
                    })
                i++
            })
        
        var blockTimeBefore = new Date().getTime()
        series(executions, function(err, results) {
            var string = 'executed'
            if(revalidate) string = 'validated & '+string
            logr.debug('Block '+string+' in '+(new Date().getTime()-blockTimeBefore)+'ms')
            if (err) throw err
            var executedSuccesfully = []
            var distributedInBlock = 0
            var burnedInBlock = 0
            for (let i = 0; i < results.length; i++) {
                if (results[i].executed)
                    executedSuccesfully.push(block.txs[i])
                if (results[i].distributed)
                    distributedInBlock += results[i].distributed
                if (results[i].burned)
                    burnedInBlock += results[i].burned
            }

            // add rewards for the leader who mined this block
            chain.leaderRewards(block.miner, block.timestamp, function(dist) {
                distributedInBlock += dist
                distributedInBlock = Math.round(distributedInBlock*1000) / 1000
                burnedInBlock = Math.round(burnedInBlock*1000) / 1000
                cb(executedSuccesfully, distributedInBlock, burnedInBlock)
            })
        })
    },
    minerSchedule: (block, cb) => {
        var hash = block.hash
        var rand = parseInt('0x'+hash.substr(hash.length-config.leaderShufflePrecision))
        if (!p2p.recovering)
            logr.debug('Generating schedule... NRNG: ' + rand)
        var miners = chain.generateLeaders(true, config.leaders, 0)
        miners = miners.sort(function(a,b) {
            if(a.name < b.name) return -1
            if(a.name > b.name) return 1
            return 0
        })
        var shuffledMiners = []
        while (miners.length > 0) {
            var i = rand%miners.length
            shuffledMiners.push(miners[i])
            miners.splice(i, 1)
        }
        
        var y = 0
        while (shuffledMiners.length < config.leaders) {
            shuffledMiners.push(shuffledMiners[y])
            y++
        }

        cb({
            block: block,
            shuffle: shuffledMiners
        })
    },
    generateLeaders: (withLeaderPub, limit, start) => {
        var leaders = []
        for (const key in cache.accounts) {
            if (!cache.accounts[key].node_appr || cache.accounts[key].node_appr <= 0)
                continue
            if (withLeaderPub && !cache.accounts[key].pub_leader)
                continue
            var newLeader = cloneDeep(cache.accounts[key])
            leaders.push({
                name: newLeader.name,
                pub: newLeader.pub,
                pub_leader: newLeader.pub_leader,
                balance: newLeader.balance,
                approves: newLeader.approves,
                node_appr: newLeader.node_appr,
                json: newLeader.json,
            })
        }
        leaders = leaders.sort(function(a,b) {
            return b.node_appr - a.node_appr
        })
        return leaders.slice(start, limit)

        // the old mongodb query used instead
        // var query = {
        //     $and: [{
        //         pub_leader: {$exists: true}
        //     }, {
        //         node_appr: {$gt: 0}
        //     }]
        // }
        // if (!withLeaderPub)
        //     query['$and'].splice(0,1)
        // db.collection('accounts').find(query,{
        //     sort: {node_appr: -1, name: -1},
        //     limit: limit
        // }).project({
        //     name: 1,
        //     pub: 1,
        //     pub_leader: 1,
        //     balance: 1,
        //     approves: 1,
        //     node_appr: 1,
        //     json: 1,
        // }).toArray(function(err, accounts) {
        //     if (err) throw err
        //     cb(accounts)
        // })
    },
    leaderRewards: (name, ts, cb) => {
        // rewards leaders with 'free' voting power in the network
        cache.findOne('accounts', {name: name}, function(err, account) {
            var newBalance = account.balance + config.leaderReward
            var newVt = new GrowInt(account.vt, {growth:account.balance/(config.vtGrowth)}).grow(ts)
            if (!newVt) 
                logr.debug('error growing grow int', account, ts)
            
            if (config.leaderRewardVT) {
                newVt.v += config.leaderRewardVT
                account.vt = newVt
            }

            if (config.leaderReward > 0 || config.leaderRewardVT > 0)
                cache.updateOne('accounts', 
                    {name: account.name},
                    {$set: {
                        vt: newVt,
                        balance: newBalance
                    }},
                    function(err) {
                        if (err) throw err
                        if (config.leaderReward > 0)
                            transaction.updateGrowInts(account, ts, function() {
                                transaction.adjustNodeAppr(account, config.leaderReward, function() {
                                    cb(config.leaderReward)
                                })
                            })
                        else
                            cb(0)
                    }
                )
            else cb(0)
        })
    },
    calculateHashForBlock: (block) => {
        return chain.calculateHash(block._id, block.phash, block.timestamp, block.txs, block.miner, block.missedBy, block.dist, block.burn)
    },
    calculateHash: (index, phash, timestamp, txs, miner, missedBy, distributed, burned) => {
        var string = index + phash + timestamp + txs + miner
        if (missedBy) string += missedBy
        if (distributed) string += distributed
        if (burned) string += burned

        return CryptoJS.SHA256(string).toString()
    },    
    getLatestBlock: () => {
        return chain.recentBlocks[chain.recentBlocks.length-1]
    },    
    getFirstMemoryBlock: () => {
        return chain.recentBlocks[0]
    },
    cleanMemory: () => {
        chain.cleanMemoryBlocks()
        chain.cleanMemoryTx()
    },
    cleanMemoryBlocks: () => {
        if (config.ecoBlocksIncreasesSoon) {
            logr.trace('Keeping old blocks in memory because ecoBlocks is changing soon')
            return
        }
            
        var extraBlocks = chain.recentBlocks.length - config.ecoBlocks
        while (extraBlocks > 0) {
            chain.recentBlocks.splice(0,1)
            extraBlocks--
        }
    },
    cleanMemoryTx: () => {
        for (const hash in chain.recentTxs)
            if (chain.recentTxs[hash].ts + config.txExpirationTime < chain.getLatestBlock().timestamp)
                delete chain.recentTxs[hash]
    },
    rebuildState: (blockNum,cb) => {
        // If chain shutting down, stop rebuilding and output last number for resuming
        if (chain.shuttingDown)
            return cb(null,blockNum)
            
        // Genesis block is handled differently
        if (blockNum === 0) {
            chain.recentBlocks = [chain.getGenesisBlock()]
            chain.minerSchedule(chain.getGenesisBlock(),(sch) => {
                chain.schedule = sch
                chain.rebuildState(blockNum+1,cb)
            })
            return
        }

        db.collection('blocks').findOne({ _id: blockNum },(e,blockToRebuild) => {
            if (e)
                return cb(e,blockNum)
            if (!blockToRebuild)
                // Rebuild is complete
                return cb(null,blockNum)
            
            // Validate block and transactions, then execute them
            chain.isValidNewBlock(blockToRebuild,true,true,(isValid) => {
                if (!isValid)
                    return cb(true, blockNum)
                chain.executeBlockTransactions(blockToRebuild,false,true,(validTxs,dist,burn) => {
                    // if any transaction is wrong, thats a fatal error
                    // transactions should have been verified in isValidNewBlock
                    if (blockToRebuild.txs.length !== validTxs.length) {
                        logr.fatal('Invalid tx(s) in block found after starting execution')
                        return cb('Invalid tx(s) in block found after starting execution', blockNum)
                    }

                    // error if distributed or burned computed amounts are different than the reported one
                    let blockDist = blockToRebuild.dist || 0
                    if (blockDist !== dist)
                        return cb('Wrong dist amount ' + blockDist + ' ' + dist, blockNum)

                    let blockBurn = blockToRebuild.burn || 0
                    if (blockBurn !== burn) 
                        return cb('Wrong burn amount ' + blockBurn + ' ' + burn, blockNum)
                    
                    // update the config if an update was scheduled
                    config = require('./config.js').read(blockToRebuild._id)
                    eco.nextBlock()
                    chain.cleanMemory()

                    cache.writeToDisk(() => {
                        if (blockToRebuild._id % config.leaders === 0) 
                            chain.minerSchedule(blockToRebuild, function(minerSchedule) {
                                chain.schedule = minerSchedule
                                chain.recentBlocks.push(blockToRebuild)
                                chain.output(blockToRebuild, true)
                                
                                // process notifications (non blocking)
                                notifications.processBlock(blockToRebuild)

                                // next block
                                chain.rebuildState(blockNum+1, cb)
                            })
                        else {
                            chain.recentBlocks.push(blockToRebuild)
                            chain.output(blockToRebuild, true)

                            // process notifications (non blocking)
                            notifications.processBlock(blockToRebuild)

                            // next block
                            chain.rebuildState(blockNum+1, cb)
                        }
                    })
                })
            })
        })
    }
}

module.exports = chain