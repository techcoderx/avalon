module.exports = {
    fields: ['link','len','hash'],
    validate: (tx, ts, legitUser, cb) => {
        if (!validate.string(tx.data.link, config.accountMaxLength, config.accountMinLength)) {
            cb(false, 'invalid tx data.link'); return
        }

        if (!validate.array(tx.data.len,config.streamMaxChunksTx)) {
            cb(false, 'invalid tx.data.len array'); return
        }
        
        for (chunkLen in tx.data.len)
            if (!validate.float(tx.data.len[chunkLen],false,false)) {
                cb(false, 'invalid tx data.len values'); return
            }

        let qualities = []

        for (quality in tx.data.hash) {
            if (isNaN(quality) && quality !== 'src') {
                cb(false, 'invalid tx data.hash invalid quality'); return
            }

            if (!validate.array(tx.data.hash[quality],config.streamMaxChunksTx)) {
                cb(false, 'invalid tx.data.hash.' + quality + ' array'); return
            }

            if (tx.data.hash[quality].length != tx.data.len.length) {
                cb(false, 'invalid tx.data.hash.' + quality + ' length not match'); return
            }

            for (chunkHash in tx.data.hash[quality])
                if (!validate.string(tx.data.hash[quality][chunkHash],config.streamMaxHashLength,config.streamMinHashLength,config.b64Alphabet)) {
                    cb(false, 'invalid tx data.hash.' + quality); return
                }

            qualities.push(quality)
        }

        if (qualities.length == 0) {
            cb(false, 'invalid tx.data.hash missing stream qualities'); return
        } else if (qualities.length > config.streamMaxQualities) {
            cb(false, 'invalid tx.data.hash exceeded streamMaxQualities')
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

                cb(true)
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
                    len: tx.data.len,
                    chunks: {}
                }

                for (quality in tx.data.hash)
                    newStream.chunks[quality] = tx.data.hash[quality]
                
                cache.insertOne('streams',newStream,() => {
                    cb(true)
                })
            } else {
                // Subsequent chunks
                let updateOp = {
                    $push: {
                        "len": { $each: tx.data.len }
                    }
                }

                for (quality in tx.data.hash) {
                    updateOp['$push']['chunks.' + quality] = {}
                    updateOp['$push']['chunks.' + quality]['$each'] = tx.data.hash[quality]
                }
                
                // Automatically end streams if limit is hit
                if (stream.len.length + tx.data.len.length >= config.streamMaxChunks)
                    updateOp['$set'] = { ended: true }
                
                cache.updateOne('streams', {_id: tx.sender + '/' + tx.data.link }, updateOp,() => {
                    cb(true)
                })
            }
        })
    }
}