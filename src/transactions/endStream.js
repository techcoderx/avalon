module.exports = {
    fields: ['link'],
    validate: (tx, ts, legitUser, cb) => {
        if (!validate.string(tx.data.link, config.accountMaxLength, config.accountMinLength)) {
            cb(false, 'invalid tx data.link'); return
        }

        cache.findOne('streams',{_id: tx.sender + '/' + tx.data.link},(e,stream) => {
            if (e) throw e
            if (!stream) {
                cb(false, 'stream not found'); return
            } else if (stream.ended) {
                cb(false, 'stream already ended'); return
            }

            cb(true)
        })
    },
    execute: (tx,ts,cb) => {
        cache.updateOne('streams', {_id: tx.sender + '/' + tx.data.link }, {
            $set: { ended: true }
        },() => cb(true))
    }
}