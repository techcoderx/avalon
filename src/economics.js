const series = require('run-series')
const one_day = 86400000
const one_hour = 3600000
const one_minute = 60000
var TransactionType = require('./transactions').Types

// List of potential community-breaking abuses:
// 1- Multi accounts voting (cartoons)
// 2- Bid-bots (selling votes)
// 3- Self-voting whales (haejin)
// 4- Curation trails (bots auto-voting tags or authors)

// What we decided:
// 1- Flat curation
// 2- Money goes into content, claim button stops curation rewards
// 3- People can claim curation rewards after X days. Time lock to allow downvotes to take away rewards
// 4- Rentability curve: based on time since the vote was cast. Starts at X%, goes up to 100% at optimal voting time, then goes down to Y% at the payout time and after.
// 5- Downvotes print the same DTC amount as an upvote would. But they also reduce upvote rewards by X% of that amount
// 6- Use weighted averages for rewardPool data to smooth it out

var eco = {
    startRewardPool: null,
    lastRewardPool: null,
    currentBlock: {
        dist: 0,
        burn: 0,
        votes: 0
    },
    nextBlock: () => {
        eco.currentBlock.dist = 0
        eco.currentBlock.burn = 0
        eco.currentBlock.votes = 0
        if (eco.startRewardPool)
            eco.lastRewardPool = eco.startRewardPool
        eco.startRewardPool = null
    },
    inflation: (cb) => {
        cb(config.rewardPoolMult * config.rewardPoolUsers + config.rewardPoolMin)
        return
    },
    rewardPool: (cb) => {
        eco.inflation(function(theoricalPool){
            var burned = 0
            var distributed = 0
            var votes = 0
            if (!eco.startRewardPool) {
                var firstBlockIndex = chain.recentBlocks.length - config.ecoBlocks
                if (firstBlockIndex < 0) firstBlockIndex = 0
                var weight = 1
                for (let i = firstBlockIndex; i < chain.recentBlocks.length; i++) {
                    const block = chain.recentBlocks[i]
                    if (block.burn)
                        burned += block.burn
                    if (block.dist)
                        distributed += block.dist
                    
                    for (let y = 0; y < block.txs.length; y++) {
                        var tx = block.txs[y]
                        if (tx.type === TransactionType.VOTE
                            || tx.type === TransactionType.COMMENT
                            || tx.type === TransactionType.PROMOTED_COMMENT)
                            votes += Math.abs(tx.data.vt)*weight
                    }
                    weight++
                }
    
                // weighted average for votes
                votes /= (weight+1)/2

                eco.startRewardPool = {
                    burn: burned,
                    dist: distributed,
                    votes: votes,
                    theo: theoricalPool,
                    avail: theoricalPool - distributed
                }
            } else {
                burned = eco.startRewardPool.burn
                distributed = eco.startRewardPool.dist
                votes = eco.startRewardPool.votes
            }
            

            var avail = theoricalPool - distributed - eco.currentBlock.dist
            if (avail < 0) avail = 0
            burned += eco.currentBlock.burn
            distributed += eco.currentBlock.dist
            votes += eco.currentBlock.votes

            avail = Math.round(avail*Math.pow(10, config.ecoClaimPrecision))/Math.pow(10, config.ecoClaimPrecision)
            burned = Math.round(burned*Math.pow(10, config.ecoClaimPrecision))/Math.pow(10, config.ecoClaimPrecision)
            distributed = Math.round(distributed*Math.pow(10, config.ecoClaimPrecision))/Math.pow(10, config.ecoClaimPrecision)
            votes = Math.round(votes*Math.pow(10, config.ecoClaimPrecision))/Math.pow(10, config.ecoClaimPrecision)
            cb({
                theo: theoricalPool,
                burn: burned,
                dist: distributed,
                votes: votes,
                avail: avail
            })
        })
    },
    accountPrice: (username) => {
        var price = config.accountPriceMin
        var extra = config.accountPriceBase - config.accountPriceMin
        var mult = Math.pow(config.accountPriceChars / username.length, config.accountPriceCharMult)
        price += Math.round(extra*mult)
        return price
    },
    curation: (author, link, cb) => {
        cache.findOne('contents', {_id: author+'/'+link}, function(err, content) {
            var currentVote = content.votes[content.votes.length-1]

            // first loop to calculate the VP of active votes
            var sumVtWinners = 0
            for (let i = 0; i < content.votes.length; i++)
                if (!content.votes[i].claimed)
                    if (currentVote.vt*content.votes[i].vt > 0)
                        sumVtWinners += content.votes[i].vt

            // second loop to calculate each active votes shares
            var winners = []
            for (let i = 0; i < content.votes.length; i++)
                if (!content.votes[i].claimed)
                    if (currentVote.vt*content.votes[i].vt > 0) {
                        // same vote direction => winner
                        var winner = content.votes[i]
                        winner.share = winner.vt / sumVtWinners
                        winners.push(winner)
                    }

            eco.print(currentVote.vt, function(thNewCoins) {
                // share the new coins between winners
                var newCoins = 0
                for (let i = 0; i < winners.length; i++) {
                    if (!winners[i].claimable)
                        winners[i].claimable = 0
                    
                    var won = thNewCoins * winners[i].share
                    var rentabilityWinner = eco.rentability(winners[i].ts, currentVote.ts)
                    won *= rentabilityWinner
                    won = Math.floor(won*Math.pow(10, config.ecoClaimPrecision))/Math.pow(10, config.ecoClaimPrecision)
                    winners[i].claimable += won
                    newCoins += won
                    delete winners[i].share

                    // logr.econ(winners[i].u+' wins '+won+' coins with rentability '+rentabilityWinner)
                }
                newCoins = Math.round(newCoins*Math.pow(10, config.ecoClaimPrecision))/Math.pow(10, config.ecoClaimPrecision)

                // reconstruct the votes array
                var newVotes = []
                for (let i = 0; i < content.votes.length; i++)
                    if (!content.votes[i].claimed && currentVote.vt*content.votes[i].vt > 0) {
                        for (let y = 0; y < winners.length; y++)
                            if (winners[y].u === content.votes[i].u)
                                newVotes.push(winners[y])
                    } else newVotes.push(content.votes[i])

                // if there are opposite votes
                // burn 50% of the printed DTC in anti-chronological order
                var newBurn = 0
                var takeAwayAmount = thNewCoins*config.ecoPunishPercent
                var i = content.votes.length - 1
                while (takeAwayAmount !== 0 && i>=0) {
                    if (i === 0 && !config.ecoPunishAuthor)
                        break
                    if (!content.votes[i].claimed && content.votes[i].vt*currentVote.vt < 0)
                        if (content.votes[i].claimable >= takeAwayAmount) {
                            content.votes[i].claimable -= takeAwayAmount
                            newBurn += takeAwayAmount
                            takeAwayAmount = 0
                        } else {
                            takeAwayAmount -= content.votes[i].claimable
                            newBurn += content.votes[i].claimable
                            content.votes[i].claimable = 0
                        }
                    i--
                }
                newBurn = Math.round(newBurn*Math.pow(10, config.ecoClaimPrecision))/Math.pow(10, config.ecoClaimPrecision)
                
                logr.econ(newCoins + ' dist from the vote')
                logr.econ(newBurn + ' burn from the vote')

                // add dist/burn/votes to currentBlock eco stats
                eco.currentBlock.dist += newCoins
                eco.currentBlock.dist = Math.round(eco.currentBlock.dist*Math.pow(10, config.ecoClaimPrecision))/Math.pow(10, config.ecoClaimPrecision)
                eco.currentBlock.burn += newBurn
                eco.currentBlock.burn = Math.round(eco.currentBlock.burn*Math.pow(10, config.ecoClaimPrecision))/Math.pow(10, config.ecoClaimPrecision)
                eco.currentBlock.votes += currentVote.vt

                // updating the content
                // increase the dist amount for display
                // and update the votes array
                cache.updateOne('contents', {_id: author+'/'+link}, {
                    $inc: {dist: newCoins},
                    $set: {votes: newVotes}
                }, function() {
                    if (config.masterFee > 0 && newCoins > 0) {
                        // apply the master fee
                        var distBefore = content.dist
                        if (!distBefore) distBefore = 0
                        var distAfter = distBefore + newCoins
                        var benefReward = Math.floor(distAfter/config.masterFee) - Math.floor(distBefore/config.masterFee)
                        if (benefReward > 0) 
                            cache.updateOne('accounts', {name: config.masterName}, {$inc: {balance: benefReward}}, function() {
                                cache.insertOne('distributed', {
                                    name: config.masterName,
                                    dist: benefReward,
                                    ts: currentVote.ts,
                                    _id: content.author+'/'+content.link+'/'+currentVote.u+'/'+config.masterName
                                }, function() {
                                    cache.findOne('accounts', {name: config.masterName}, function(err, masterAccount) {
                                        masterAccount.balance -= benefReward
                                        transaction.updateGrowInts(masterAccount, currentVote.ts, function() {
                                            transaction.adjustNodeAppr(masterAccount, benefReward, function() {
                                                cb(newCoins, benefReward, newBurn)
                                            })
                                        })
                                    })
                                })
                            })
                        else cb(newCoins, 0)
                    } else cb(newCoins, 0)
                })
            })
        })
    },
    print: (vt, cb) => {
        // loads current reward pool data
        // and converts VP to DTC based on reward pool stats
        eco.rewardPool(function(stats) {
            // if reward pool is empty, print nothing
            // (can only happen if witnesses freeze distribution in settings)
            if (stats.avail === 0) {
                cb(0)
                return
            }

            var thNewCoins = 0

            // if theres no vote in reward pool stats, we print 1 coin (minimum)
            if (stats.votes === 0)
                thNewCoins = 1
            // otherwise we proportionally reduce based on recent votes weight
            // and how much is available for printing
            else
                thNewCoins = stats.avail * Math.abs((vt) / stats.votes)

            // rounding down
            thNewCoins = Math.floor(thNewCoins*Math.pow(10, config.ecoClaimPrecision))/Math.pow(10, config.ecoClaimPrecision)
            
            // and making sure one person cant empty the whole pool when network has been inactive
            // e.g. when stats.votes close to 0
            // then vote value will be capped to rewardPoolMaxShare %
            if (thNewCoins > Math.floor(stats.avail*config.rewardPoolMaxShare))
                thNewCoins = Math.floor(stats.avail*config.rewardPoolMaxShare)

            logr.econ('PRINT:'+vt+' VT => '+thNewCoins+' dist', stats.avail)
            cb(thNewCoins)
        })
    },
    rentability: (ts1, ts2) => {
        var ts = ts2 - ts1
        if (ts < 0) throw 'Invalid timestamp in rentability calculation'

        // https://imgur.com/a/GTLvs37
        var startRentability = config.ecoStartRent
        var baseRentability = config.ecoBaseRent
        var rentabilityStartTime = config.ecoRentStartTime
        var rentabilityEndTime = config.ecoRentEndTime
        var claimRewardTime = config.ecoClaimTime

        // requires that :
        // rentabilityStartTime < rentabilityEndTime < claimRewardTime

        // between rentStart and rentEnd => 100% max rentability
        var rentability = 1

        if (ts === 0)
            rentability = startRentability
        
        else if (ts < rentabilityStartTime)
            // less than one day, rentability grows from 50% to 100%
            rentability = startRentability + (1-startRentability) * ts / rentabilityStartTime

        else if (ts >= claimRewardTime)
            // past 7 days, 50% base rentability
            rentability = baseRentability

        else if (ts > rentabilityEndTime)
            // more than 3.5 days but less than 7 days
            // decays from 100% to 50%
            rentability = baseRentability + (1-baseRentability) * (claimRewardTime-ts) / (claimRewardTime-rentabilityEndTime)


        rentability = Math.floor(rentability*Math.pow(10, config.ecoRentPrecision))/Math.pow(10, config.ecoRentPrecision)
        return rentability
    }
} 

module.exports = eco