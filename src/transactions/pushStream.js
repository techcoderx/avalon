module.exports = {
    fields: ['link','len','hash'],
    validate: (tx, ts, legitUser, cb) => {
        if (!validate.string(tx.data.link, config.accountMaxLength, config.accountMinLength)) {
            cb(false, 'invalid tx data.link'); return
        }
        
        if (!validate.float(tx.data.len,false,false)) {
            cb(false, 'invalid tx data.len'); return
        }

        if (!validate.json(tx.data.hash,999)) {
            cb(false, 'invalid tx data.hash'); return
        }

        let qualities = []

        for (quality in tx.data.hash) {
            if (isNaN(quality) && quality !== 'src') {
                cb(false, 'invalid tx data.hash quality'); return
            }

            if (!validate.string(tx.data.hash[quality],64,46,config.b64Alphabet)) {
                cb(false, 'invalid tx data.hash.' + quality); return
            }

            qualities.push(quality)
        }

        if (qualities.length == 0) {
            cb(false, 'invalid tx.data.hash'); return
        }

        qualities.sort()

        cache.findOne('contents',{_id: tx.sender + '/' + tx.data.link},(e,content) => {
            if (e) throw e
            if (!content) {
                cb(false, 'content not found'); return
            } else cache.findOne('streams',{_id: tx.sender + '/' + tx.data.link},(e,stream) => {
                if (stream) {
                    if (stream.ended) {
                        cb(false, 'stream already ended'); return
                    }
                    let existingQualities = Object.keys(stream.chunks)
                    existingQualities.sort()
                    if (existingQualities.length != qualities.length) {
                        cb(false, 'stream qualities do not match'); return
                    }
                    for (let i = 0; i < existingQualities.length; i++) {
                        if (existingQualities[i] != qualities[i]) {
                            cb(false, 'stream qualities do not match'); return
                        }
                    }
                }

                // TODO: Adjust block number for HF
                mongo.lastBlock((blockNum) => {
                    if (blockNum._id < 100)
                        cb(false, 'forbidden transaction type')
                    else
                        cb(true)
                })
            })
        })
    },
    execute: (tx,ts,cb) => {
        cache.findOne('streams',{_id: tx.sender + '/' + tx.data.link},(e,stream) => {
            if (!stream) {
                // First chunk
                let newStream = {
                    _id: tx.sender + '/' + tx.data.link,
                    author: tx.sender,
                    link: tx.data.link,
                    ts: ts,
                    ended: false,
                    len: [tx.data.len],
                    chunks: {}
                }

                for (quality in tx.data.hash)
                    newStream.chunks[quality] = [tx.data.hash[quality]]
                
                cache.insertOne('streams',newStream,() => {
                    cb(true)
                })
            } else {
                // Subsequent chunks
                let updateOp = {
                    $push: {
                        "len": tx.data.len
                    }
                }

                for (quality in tx.data.hash)
                    updateOp['$push']['chunks.' + quality] = tx.data.hash[quality]
                
                cache.updateOne('streams', {_id: tx.sender + '/' + tx.data.link }, updateOp,() => {
                    cb(true)
                })
            }
        })
    }
}