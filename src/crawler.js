const got = require("got")
const htmlParser = require("node-html-parser")
const stemmer = require("stemmer")
const R = require("ramda")
const mimeTypes = require("mime-types")
const parseHTML = htmlParser.parse

const log = require("./log.js")
const DB = require("./db.js")
const util = require("./util.js")

// Extract all the text from a node-html-parser DOM-tree-ish thing
// Should probably be adapted to deal with <span>s and whatnot in the middle of words,
// though that might not be common enough to be worth it
const extractText = node => {
    if (node instanceof htmlParser.TextNode) { return node.rawText.replace(/\n/g, "") }
    return node.childNodes.map(x => extractText(x).trim()).join(" ")
}

// Finds the links on a page, and parses it to get text out
const parsePage = (page, url) => {
    const text = []
    const document = parseHTML(page)

    const titleElement = document.querySelector("title")
    if (!document.querySelector("title")) {
        // If there *is* a title element it'll be added to the output of extractText anyway
        // If not, just guess what the title might be based on the URL
        const fallback = url.pathname.replace(/[/_\-+]/g, " ").trim()
        text.push(fallback !== "" ? fallback : url.hostname)
    }

    // Extract content of keyword/description <meta> tags
    for (meta of document.querySelectorAll("meta")) {
        const name = meta.getAttribute("name")
        const content = meta.getAttribute("content")
        if ((name === "description" || name === "keywords") && content) {
            // strip HTML-tag-looking things
            text.push(content.replace(/<[^<>]+>/g, ""))
        }
    }

    text.push(extractText(document))

    // Find the "href" attributes of all links with those
    const links = document.querySelectorAll("a").map(node => node.getAttribute("href")).filter(x => x !== undefined)

    return { text: text.join(" "), links }
}

// Count the frequency with which each token appears in the text, and divide by the total tokens
const toWeights = tokens => {
    const numTokens = tokens.length
    const weights = new Map()
    for (const token of tokens) {
        weights.set(token, (weights.get(token) || 0) + 1)
    }
    for (const [token, frequency] of weights) {
        weights.set(token, frequency / numTokens)
    }
    return weights
}

const insertPageQuery = DB.prepare(`INSERT OR REPLACE INTO pages (url, rawContent, rawFormat, updated, domain) VALUES (?, ?, ?, ?, ?)`)
const findPageQuery = DB.prepare(`SELECT id FROM pages WHERE url = ?`)
const clearPageTokensQuery = DB.prepare(`DELETE FROM page_tokens WHERE page = ?`)
const insertPageTokenQuery = DB.prepare(`INSERT INTO page_tokens (page, token, weight) VALUES (?, ?, ?)`)
const insertPageTransaction = DB.transaction((url, compressedRaw, tokens, domainID) => {
    // Find page matching URL to clear associated tokens if it exists
    const foundID = findPageQuery.get(url)
    if (foundID) { clearPageTokensQuery.run(foundID.id) }

    // Insert new row for the page
    const id = insertPageQuery.run(url, compressedRaw, "zlib", util.timestamp(), domainID).lastInsertRowid

    // Insert each token
    tokens.forEach((weight, token) => insertPageTokenQuery.run(id, token, weight))
})
const insertPage = async (url, raw, tokens, domainID) => insertPageTransaction(url, await util.zlibCompress(raw), tokens, domainID)

const findDomainQuery = DB.prepare(`SELECT id, enabled FROM domains WHERE domain = ?`)
const createDomainQuery = DB.prepare(`INSERT INTO domains (domain, enabled) VALUES (?, 0)`)
const addLinkQuery = DB.prepare(`INSERT OR REPLACE INTO links (toURL, fromURL, lastSeen) VALUES (?, ?, ?)`)
const pushCrawlQueueQuery = DB.prepare(`INSERT OR REPLACE INTO crawl_queue (url, added, domain, domainEnabled) VALUES (?, ?, ?, ?)`)

const acceptableMIMETypes = [
    "text/",
    "application/xml"
]

const acceptMIMEType = mime => {
    for (mimeType of acceptableMIMETypes) {
        if (mime.startsWith(mimeType)) { return true }
    }
    return false
}

const shouldCrawl = url => {
    const mime = mimeTypes.lookup(url.pathname)
    if (mime === false) { return true }
    return acceptMIMEType(mime)
}

const addToCrawlQueue = toURL => {
    // Attempt to find entry for host
    const domain = findDomainQuery.get(toURL.hostname)
    let domainID, domainEnabled
    // If it doesn't exist, create one. It will be disabled by default.
    if (!domain) { domainID = createDomainQuery.run(toURL.hostname).lastInsertRowid; domainEnabled = 0 }
    else { domainID = domain.id; domainEnabled = domain.enabled }
    // Add entry to crawl queue
    pushCrawlQueueQuery.run(toURL.toString(), util.timestamp(), domainID, domainEnabled)
}

const handleLink = DB.transaction((fromURL, toURL) => {
    log.info(`${fromURL} → ${toURL}`)

    // Add this link to the links table
    addLinkQuery.run(toURL.toString(), fromURL, util.timestamp())
    // If page does not exist and it should be crawled, add it to the queue
    if (!findPageQuery.get(toURL.toString()) && shouldCrawl(toURL)) {
        addToCrawlQueue(toURL)
    }
})

const processLink = (linkURL, baseURL) => {
    const absoluteURL = new URL(linkURL, baseURL)
    // remove hash, query parameters, as those are probably for dynamic content
    absoluteURL.hash = ""
    absoluteURL.search = ""
    return absoluteURL
}

const crawl = async rawURL => {
    const pageURL = new URL(rawURL)
    // Download page
    const response = await got(pageURL, {
        timeout: 5000,
        headers: {
            "user-agent": util.userAgent,
            "accept": `text/html, text/plain;q=0.8, text/*;q=0.7`
        }
    })
    
    const domain = findDomainQuery.get(pageURL.hostname).id

    const contentType = response.headers["content-type"]
    if (!acceptMIMEType(contentType)) {
        log.warning(`Content-Type ${contentType} is not acceptable; ignoring ${rawURL}`)
        return
    }

    log.info(`${rawURL} returned ${response.statusCode}`)

    const { text, links } = parsePage(response.body, pageURL)
    // Process links (absolutize URLs, drop off query/hash params)
    // then filter for unique links, then drop non-HTTP(S) URLs
    const absoluteLinks = R.pipe(
        R.map(link => processLink(link, pageURL)),
        R.uniqBy(link => link.toString()),
        R.filter(link => link.protocol === "http:" || link.protocol === "https:")
    )(links)

    const tokens = util.toTokens(text)
    const weights = toWeights(tokens)
    insertPage(rawURL, response.body, weights, domain)
    // Add links to links table/crawl queue
    absoluteLinks.forEach(link => handleLink(rawURL, link))
}

const setEnabledDomainQuery = DB.prepare(`UPDATE domains SET enabled = ? WHERE id = ?`)
const setEnabledCrawlQueueQuery = DB.prepare(`UPDATE crawl_queue SET domainEnabled = ? WHERE domain = ?`)

// Enable/disable crawling for a domain and associated queue entries
const setDomainEnabled = (domain, enable) => {
    log.info(`Crawling ${domain} ${enable ? "enabled" : "disabled"}`)
    const domainID = findDomainQuery.get(domain).id
    setEnabledDomainQuery.run(util.boolToNum(enable), domainID)
    setEnabledCrawlQueueQuery.run(util.boolToNum(enable), domainID)
}

const findNextCrawlQuery = DB.prepare(`SELECT * FROM crawl_queue WHERE lockTime IS NULL AND domainEnabled = 1 ORDER BY RANDOM() LIMIT 1`)
const lockQuery = DB.prepare(`UPDATE crawl_queue SET lockTime = ? WHERE id = ?`)
const unlockQuery = DB.prepare(`UPDATE crawl_queue SET lockTime = NULL WHERE id = ?`)
const removeFromQueueQuery = DB.prepare(`DELETE FROM crawl_queue WHERE id = ?`)

const crawlRandom = async () => {
    // Pick a random enabled and unlocked entry from the crawl queue
    const next = findNextCrawlQuery.get()
    if (next) {
        // Lock entry
        lockQuery.run(util.timestamp(), next.id)
        try {
            // Attempt to crawl page, then remove it from queue
            await crawl(next.url)
            removeFromQueueQuery.run(next.id)
        } catch(e) {
            // Unlock on error
            log.error(`Error when crawling ${next.url}:\n${e.stack}`)
            unlockQuery.run(next.id)
        }

        return true
    } else {
        return false
    }
}

module.exports = {
    crawl,
    addToCrawlQueue,
    setDomainEnabled,
    crawlRandom
}