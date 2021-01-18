const http = require('http').createServer()
const GunDB = require('gun')
const Gun = GunDB({ web: http, peers: process.env.ALIVEDB_PEERS.split(',') })

let alivedb = {
    init: () => {
        let gunPort = parseInt(process.env.ALIVEDB_GUN_PORT)
        if (!isNaN(gunPort))
            http.listen(gunPort,() => logr.info(`AliveDB GUN P2P server listening on port ${gunPort}`))
    },
    getListFromUser: (pub,listId,retainGunInfo,minTs) => {
        return new Promise((rs) => {
            let list = []
            Gun.user(pub).get(listId+'<?600').once(async (data) => {
                let itemIds = Object.keys(data)
                for (let i = 1; i < itemIds.length; i++) if (new Date().getTime() - data._['>'][itemIds[i]] < 600000 && data._['>'][itemIds[i]] > minTs) {
                    let itm = await alivedb.getItem(data[itemIds[i]]['#'])
                    if (!retainGunInfo && itm && itm._)
                        delete itm._
                    if (itm)
                        list.push(itm)
                }
                rs(list)
            })
        })
    },
    getItem: (itemId) => {
        return new Promise((rs) => {
            Gun.get(itemId,(data) => {
                rs(data.put)
            })
        })
    }
}

module.exports = alivedb