const got = require("got")
const htmlParser = require("node-html-parser")
const stemmer = require("stemmer")
const R = require("ramda")
const mimeTypes = require("mime-types")
const parseHTML = htmlParser.parse
const robotsParser = require("robots-parser")

const log = require("./log.js")
const util = require("./util.js")
const DB = require("./db.js")

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

const enqueueCrawl = async crawlURL => {
    let [domain] = await DB`SELECT * FROM domains WHERE domain = ${crawlURL.hostname}`
    if (!domain) {
        // robotsPolicy will be filled in on first actual crawl for the domain
        const [result] = await DB`INSERT INTO domains (domain, enabled, robotsPolicy) 
        VALUES (${crawlURL.hostname}, FALSE, NULL) RETURNING id`
        var domainID = result.id
    } else {
        var domainID = domain.id
    }
    // Add entry to crawl queue
    await DB`INSERT INTO crawl_queue (url, domain)
    VALUES (${crawlURL.toString()}, ${domainID})
    ON CONFLICT (url) DO UPDATE SET added = NOW()`
}

const processLink = (linkURL, baseURL) => {
    const absoluteURL = new URL(linkURL, baseURL)
    // remove hash, query parameters, as those are probably for dynamic content
    absoluteURL.hash = ""
    absoluteURL.search = ""
    return absoluteURL
}

const getRobotsTxtUrl = domain => `https://${domain}/robots.txt`

const fetchRobotsTxt = async domain => {
    const response = await got(getRobotsTxtUrl(domain), {
        timeout: 5000,
        headers: { "user-agent": util.userAgent },
        throwHttpErrors: false
    })
    if (response.statusCode !== 200) { // assume any error or whatever means no robots.txt is present
        return null
    } else {
        return response.body
    }
}

const robotsTxtCache = new Map()
const parseRobotsTxt = (content, domain) => {
    const cached = robotsTxtCache.get(content)
    if (cached) { return cached }
    const robots = robotsParser(getRobotsTxtUrl(domain), content)
    robotsTxtCache.set(content, robots)
    return robots
}

const getPageID = async url => {
    const [result] = await DB`SELECT id FROM pages WHERE url = ${url}`
    return result != undefined ? result.id : null
}

const insertPage = async (url, raw, format, tokens, domainID) => {
    const foundID = await getPageID(url)
    return DB.begin(async tx => {
        if (foundID) {
            DB`DELETE FROM page_tokens WHERE page = ${foundID}`
        }
        const [result] = await DB`INSERT INTO pages (url, rawContent, rawFormat, domain)
        VALUES (${url}, ${raw}, ${format}, ${domainID})
        ON CONFLICT (url) DO UPDATE SET rawContent = excluded.rawContent, rawFormat = excluded.rawFormat
        RETURNING id`
        const newID = result.id
        const tokenRows = []
        tokens.forEach((weight, token) => { tokenRows.push({ page: newID, token, weight }) })
        await DB`INSERT INTO page_tokens ${DB(tokenRows, "page", "token", "weight")}`
        return newID
    })
}

const crawl = async (rawURL, domainID) => {
    const [domainInfo] = await DB`SELECT * FROM domains WHERE id = ${domainID}`
    if (!domainInfo.robotsPolicy) {
        let policy = await fetchRobotsTxt(domainInfo.domain)
        if (policy === null) { policy = "none" } // distinguish between "policy not downloaded" and "no detected policy"
        domainInfo.robotsPolicy = policy
        await DB`UPDATE domains SET robotsPolicy = ${policy} WHERE id = ${domainID}`
    }
    const robotsPolicy = parseRobotsTxt(domainInfo.robotsPolicy, domainInfo.domain)
    if (robotsPolicy.isDisallowed(rawURL, util.userAgent)) {
        log.warning(`${rawURL} access denied in robots policy`)
        return
    }

    const pageURL = new URL(rawURL)
    // Download page
    const response = await got(pageURL, {
        timeout: 5000,
        headers: {
            "user-agent": util.userAgent,
            "accept": `text/html, text/plain;q=0.8, text/*;q=0.7`
        }
    })

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
    const compressed = await util.zlibCompress(response.body)

    const pageID = await insertPage(rawURL, compressed, "zlib", weights, domainID)

    // Add links to links table/crawl queue
    Promise.all(absoluteLinks.map(async link => {
        await DB`INSERT INTO links (toURL, fromPage) VALUES (${link.toString()}, ${pageID})
        ON CONFLICT (toURL, fromPage) DO UPDATE SET lastSeen = NOW()`
        if (shouldCrawl(link) && !(await getPageID(link.toString()))) {
            log.info(`Queueing ${link.toString()} for potential crawling.`)
            await enqueueCrawl(link)
        }
    }))
}

const crawlRandom = async () => {
    // Pick a random enabled and unlocked entry from the crawl queue
    const [next] = await DB`SELECT crawl_queue.id, crawl_queue.url, crawl_queue.domain
    FROM crawl_queue
    INNER JOIN domains ON domains.id = crawl_queue.domain
    WHERE lockTime IS NULL AND domains.enabled = TRUE
    ORDER BY RANDOM() LIMIT 1`
    if (next) {
        // Lock entry
        await DB`UPDATE crawl_queue SET lockTime = NOW() where id = ${next.id}`
        try {
            // Attempt to crawl page, then remove it from queue
            await crawl(next.url, next.domain)
            await DB`DELETE FROM crawl_queue WHERE id = ${next.id}`
        } catch(e) {
            // Unlock on error
            log.error(`Error when crawling ${next.url}:\n${e.stack}`)
            await DB`UPDATE crawl_queue SET lockTime = NULL where id = ${next.id}`
        }

        return true
    } else {
        return false
    }
}

module.exports = {
    crawl,
    crawlRandom,
    enqueueCrawl
}