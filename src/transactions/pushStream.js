module.exports = {
    fields: ['link','len','src','240','480','720','1080'],
    validate: (tx, ts, legitUser, cb) => {
        if (!validate.string(tx.data.link, config.accountMaxLength, config.accountMinLength))
            return cb(false, 'invalid tx data.link')

        if (!validate.array(tx.data.len,config.streamMaxChunksTx))
            return cb(false, 'invalid tx.data.len array')

        if (!validate.array(tx.data.src,config.streamMaxChunksTx))
            return cb(false, 'invalid tx.data.src array')
        else if (tx.data.src.length !== tx.data.len.length)
            return cb(false, 'length of tx.data.src is not equal to length of tx.data.len')
        
        // Every hash in array should be valid strings
        for (let i in tx.data.src)
            if (!validate.string(tx.data.src[i],config.streamMaxHashLength,config.streamMinHashLength,config.b64Alphabet))
                return cb(false, 'invalid hashes in src array')

        // Optional encoded hash fields
        for (let i in config.streamRes)
            if (tx.data[config.streamRes[i]]) {
                if (!validate.array(tx.data[config.streamRes[i]],config.streamMaxChunksTx))
                    return cb(false, 'invalid tx.data[' + config.streamRes[i] + '] array')
                else if (tx.data[config.streamRes[i]].length !== tx.data.len.length)
                    return cb(false, 'length of tx.data[' + config.streamRes[i] + '] is not equal to length of tx.data.len')
                for (let i in tx.data[config.streamRes[i]])
                    if (!validate.string(tx.data[config.streamRes[i]][i],config.streamMaxHashLength,config.streamMinHashLength,config.b64Alphabet))
                        return cb(false, 'invalid hashes in ' + config.streamRes[i] + ' array')
            }

        for (chunkLen in tx.data.len)
            if (!validate.float(tx.data.len[chunkLen],false,false))
                return cb(false, 'invalid tx data.len values')

        cache.findOne('streams',{_id: tx.sender + '/' + tx.data.link},(e,stream) => {
            if (stream) {
                if (stream.ended)
                    return cb(false, 'stream already ended')
                for (let i in config.streamRes)
                    if (stream[config.streamRes[i]] && !tx.data[config.streamRes[i]] || !stream[config.streamRes[i]] && tx.data[config.streamRes[i]])
                        return cb(false, 'stream quality' + config.streamRes[i] + 'do not match')
            }
            cb(true)
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
                    src: tx.data.src
                }

                for (let i in config.streamRes)
                    if (tx.data[config.streamRes[i]])
                        newStream[config.streamRes[i]] = tx.data[config.streamRes[i]]
                
                cache.insertOne('streams',newStream,() => {
                    cb(true)
                })
            } else {
                // Subsequent chunks
                let updateOp = {
                    $push: {
                        "len": { $each: tx.data.len },
                        "src": { $each: tx.data.src }
                    }
                }

                for (let i in config.streamRes)
                    if (tx.data[config.streamRes[i]])
                        updateOp['$push'][config.streamRes[i]] = { $each: tx.data[config.streamRes[i]] }
                
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