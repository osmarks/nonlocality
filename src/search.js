const R = require("ramda")

const log = require("./log.js")
const DB = require("./db.js")
const util = require("./util.js")

const search = async query => {
    const start = util.timestamp()
    const tokens = util.toTokens(query)
    const pages = new Map()
    for (const token of tokens) {
        const [totalResult] = await DB`SELECT SUM(weight) FROM page_tokens WHERE token = ${token}`
        const totalWeight = totalResult.sum

        const tokenOccurences = await DB`SELECT page, weight FROM page_tokens WHERE token = ${token}`
        tokenOccurences.forEach(entry => {
            let page = pages.get(entry.page)
            if (!page) {
                page = { weight: 0, tokens: [] }
                pages.set(entry.page, page)
            }
            page.weight += entry.weight / totalWeight
            page.tokens.push({ token, weight: entry.weight })
        })
    }
    const out = []
    for (const [pageID, info] of pages) {
        const [page] = await DB`SELECT * FROM pages WHERE id = ${pageID}`
        page.weight = info.weight
        page.tokens = info.tokens
        out.push(page)
    }

    const end = util.timestamp()
    await DB`INSERT INTO search_history (query, quantityResults, timeTaken)
    VALUES (${query}, ${out.length}, ${end - start})`
    return { list: R.sortBy(x => -x.weight, out), time: end - start, query }
}

module.exports = search