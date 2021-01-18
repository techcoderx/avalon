module.exports = {
    fields: ['link','pub'],
    validate: (tx, ts, legitUser, cb) => {
        if (!validate.string(tx.data.link, config.accountMaxLength, config.accountMinLength))
            return cb(false, 'invalid tx data.link')

        // AliveDB user public key
        if (!validate.string(tx.data.pub,config.streamPubLength,config.streamPubLength,config.b65Alphabet))
            return cb(false, 'invalid tx data.pub')

        cache.findOne('streams',{_id: tx.sender + '/' + tx.data.link},(e,stream) => {
            if (e) throw e
            if (stream && stream.ended)
                return cb(false, 'stream already ended')

            cb(true)
        })
    },
    execute: (tx,ts,cb) => {
        cache.findOne('streams',{_id: tx.sender + '/' + tx.data.link},(e,stream) => {
            if (!stream) {
                // New stream
                cache.insertOne('streams', {
                    _id: tx.sender + '/' + tx.data.link,
                    author: tx.sender,
                    link: tx.data.link,
                    pub: tx.data.pub,
                    createdTs: ts,
                    lastTs: ts,
                    ended: false,
                    len: [],
                    src: []
                },() => cb(true))
            } else {
                // Existing stream
                cache.updateOne('streams', {_id: tx.sender + '/' + tx.data.link }, {
                    $set: { pub: tx.data.pub }
                },() => cb(true))
            }
        })
    }
}