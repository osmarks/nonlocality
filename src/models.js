const DB = require("./db.js")
const util = require("./util")

const findPageIDQuery = DB.prepare(`SELECT id FROM pages WHERE url = ?`)
const getPageID = url => {
    const result = findPageIDQuery.get(url)
    return result != undefined ? result.id : null
}

const insertPageQuery = DB.prepare(`INSERT OR REPLACE INTO pages (url, rawContent, rawFormat, updated, domain) 
VALUES (:url, :content, :format, :updated, :domain)`)
const clearPageTokensQuery = DB.prepare(`DELETE FROM page_tokens WHERE page = ?`)
const insertPageTokenQuery = DB.prepare(`INSERT INTO page_tokens (page, token, weight) VALUES (?, ?, ?)`)
// Clear tokens connected to existing page if it exists, then create/update the entry for it and add the new token set
const insertPage = DB.transaction((url, raw, format, tokens, domainID) => {
    const foundID = getPageID(url)
    if (foundID) { clearPageTokensQuery.run(foundID) }
    const pageID = insertPageQuery.run({
        url,
        content: raw,
        format: format,
        updated: util.timestamp(),
        domain: domainID
    }).lastInsertRowid
    tokens.forEach((weight, token) => insertPageTokenQuery.run(pageID, token, weight))
})

const getDomainQuery = DB.prepare(`SELECT * FROM domains WHERE id = ?`)
const getDomain = id => getDomainQuery.get(id)

const findDomainQuery = DB.prepare(`SELECT * FROM domains WHERE domain = ?`)
const findDomain = domain => findDomainQuery.get(domain)

const createDomainQuery = DB.prepare(`INSERT INTO domains (domain, enabled, robotsPolicy) VALUES (?, ?, ?)`)
const createDomain = (domain, enabled, robotsPolicy) => createDomainQuery.run(domain, util.boolToNum(enabled), robotsPolicy).lastInsertRowid

const createLinkQuery = DB.prepare(`INSERT OR REPLACE INTO links (toURL, fromURL, lastSeen) VALUES (?, ?, ?)`)
const createLink = (to, from) => createLinkQuery.run(to, from, util.timestamp())

const enqueueCrawlQuery = DB.prepare(`INSERT OR REPLACE INTO crawl_queue (url, added, domain) VALUES (?, ?, ?)`)
const enqueueCrawl = (url, domainID) => enqueueCrawlQuery.run(url, util.timestamp(), domainID)

const findNextCrawlQuery = DB.prepare(`SELECT crawl_queue.id, crawl_queue.url, crawl_queue.domain
FROM crawl_queue 
INNER JOIN domains ON domains.id = crawl_queue.domain
WHERE lockTime IS NULL AND domains.enabled = 1
ORDER BY RANDOM() LIMIT 1`)
const findNextCrawl = () => findNextCrawlQuery.get()

const setDomainEnabledQuery = DB.prepare(`UPDATE domains SET enabled = ? WHERE id = ?`)
const setDomainEnabled = (domain, enabled) => setDomainEnabledQuery.run(util.boolToNum(enabled), domain)

const lockCrawlQuery = DB.prepare(`UPDATE crawl_queue SET lockTime = ? WHERE id = ?`)
const lockCrawl = queueID => lockCrawlQuery.run(util.timestamp(), queueID)

const unlockCrawlQuery = DB.prepare(`UPDATE crawl_queue SET lockTime = NULL WHERE id = ?`)
const unlockCrawl = queueID => unlockCrawlQuery.run(queueID)

const removeCrawlQuery = DB.prepare(`DELETE FROM crawl_queue WHERE id = ?`)
const removeCrawl = queueID => removeCrawlQuery.run(queueID)

const updateRobotsPolicyQuery = DB.prepare(`UPDATE domains SET robotsPolicy = ? WHERE id = ?`)
const updateRobotsPolicy = (domainID, newPolicy) => updateRobotsPolicyQuery.run(newPolicy, domainID)

module.exports = {
    getPageID,
    insertPage,
    findDomain,
    createDomain,
    createLink,
    enqueueCrawl,
    setDomainEnabled,
    lockCrawl,
    unlockCrawl,
    removeCrawl,
    findNextCrawl,
    getDomain,
    updateRobotsPolicy
}