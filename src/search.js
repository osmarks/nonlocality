const R = require("ramda")

const log = require("./log.js")
const DB = require("./db.js")
const util = require("./util.js")

const wordFrequencyQuery = DB.prepare(`SELECT SUM(weight) FROM page_tokens WHERE token = ?`)
const searchQuery = DB.prepare(`SELECT * FROM page_tokens WHERE token = ?`)
const findPageQuery = DB.prepare(`SELECT id, url, updated FROM pages WHERE id = ?`)
const pushSearchHistory = DB.prepare(`INSERT INTO search_history (query, timestamp, quantityResults, timeTaken) VALUES (?, ?, ?, ?)`)

const search = query => {
    const start = util.timestamp()
    const tokens = util.toTokens(query)
    const pages = new Map()
    for (const token of tokens) {
        const frequency = wordFrequencyQuery.get(token)["SUM(weight)"]
        searchQuery.all(token).forEach(entry => {
            let page = pages.get(entry.page)
            if (!page) {
                page = { weight: 0, tokens: [] }
                pages.set(entry.page, page)
            }
            page.weight += entry.weight / frequency
            page.tokens.push({ token, weight: entry.weight })
        })
    }
    const out = []
    for (const [pageID, info] of pages) {
        const page = findPageQuery.get(pageID)
        page.weight = info.weight
        page.tokens = info.tokens
        out.push(page)
    }
    const end = util.timestamp()
    pushSearchHistory.run(query, end, out.length, end - start)
    return { list: R.sortBy(x => -x.weight, out), time: end - start, query }
}

module.exports = search