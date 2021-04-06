module.exports = {
    fields: ['link','hash'],
    validate: (tx, ts, legitUser, cb) => {
        if (!validate.string(tx.data.link, config.accountMaxLength, config.accountMinLength))
            return cb(false, 'invalid tx data.link')

        if (!validate.json(tx.data.hash))
            return cb(false, 'invalid json hash')

        // source quality is required
        if (!validate.string(tx.data.hash.src))
            return cb(false, 'invalid tx src quality is required')

        for (let i in tx.data.hash) {
            if (!config.streamRes.includes(i))
                return cb(false, 'unknown quality ' + i)
            if (!validate.string(tx.data.hash[i],config.streamMaxHashLength,config.streamMinHashLength,config.b64Alphabet))
                return cb(false, 'invalid ' + i + ' hash')
        }

        cache.findOne('streams',{_id: tx.sender + '/' + tx.data.link},(e,stream) => {
            if (stream) {
                if (stream.ended)
                    return cb(false, 'stream already ended')
                if (stream.src) for (let i in config.streamRes)
                    if (stream[config.streamRes[i]] && !tx.data.hash[config.streamRes[i]] || !stream[config.streamRes[i]] && tx.data.hash[config.streamRes[i]])
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
                    createdTs: ts,
                    lastTs: ts,
                    ended: false
                }

                for (let i in tx.data.hash)
                    newStream[i] = [tx.data.hash[i]]
                
                cache.insertOne('streams',newStream,() => {
                    cb(true)
                })
            } else {
                // Subsequent chunks
                let updateOp = {
                    $set: { lastTs: ts }}

                if (stream.src) {
                    updateOp['$push'] = {}
                    for (let i in config.streamRes)
                        if (tx.data.hash[config.streamRes[i]])
                            updateOp['$push'][config.streamRes[i]] = tx.data.hash[config.streamRes[i]]
                } else {
                    for (let i in config.streamRes)
                        if (tx.data[config.streamRes[i]])
                            updateOp['$set'][config.streamRes[i]] = [tx.data.hash[config.streamRes[i]]]
                }
                
                // Automatically end streams if limit is hit
                if (stream.src.length + 1 >= config.streamMaxSections)
                    updateOp['$set'] = { ended: true }
                
                cache.updateOne('streams', {_id: tx.sender + '/' + tx.data.link }, updateOp,() => {
                    cb(true)
                })
            }
        })
    }
}