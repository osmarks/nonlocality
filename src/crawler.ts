import got from "got"
import { parse as parseHTML } from "node-html-parser"
import * as htmlParser from "node-html-parser"
import * as R from "ramda"
import { decode as decodeHTMLEntities } from "he"
const mimeTypes = require("mime-types")
const robotsParser = require("robots-parser")

import * as log from "./log"
import * as util from "./util"
import DB from "./db"

const ignoreElements = new Set(["TEMPLATE", "SCRIPT", "STYLE", "NOSCRIPT", "PRE"])
const blockElements = new Set(["P", "LI", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "TABLE", "MAIN", "IMG", "HR", "BR", 
    "SECTION", "NAV", "ARTICLE", "ASIDE", "FOOTER", "FORM", "UL", "OL"])

// Extract all the text from a node-html-parser DOM-tree-ish thing
// Should probably be adapted to deal with <span>s and whatnot in the middle of words,
// though that might not be common enough to be worth it
const extractText = node => {
    if (ignoreElements.has(node.tagName)) { return "" }
    if (node instanceof htmlParser.TextNode && node.rawText.startsWith("<!DOCTYPE")) { return "" }
    if (node instanceof htmlParser.TextNode) { return decodeHTMLEntities(node.text.replace(/\n/g, " ")).trim() }
    const blockEnds = (blockElements.has(node.tagName) ? "\n" : "")
    return node.childNodes.map(extractText).filter(x => x.trim() !== "").join(" ").replace(/\n\n\n/g, "\n").replace(/\n /g, "\n") + blockEnds
}

// Finds the links on a page, and parses it to get text out
const parsePage = (page, url) => {
    const text = []
    const document = parseHTML(page)

    if (!document.querySelector("title")) {
        // If there *is* a title element it'll be added to the output of extractText anyway
        // If not, just guess what the title might be based on the URL
        const fallback = url.pathname.replace(/[/_\-+]/g, " ").replace(/.[a-z]+$/, "").trim()
        text.push(fallback !== "" ? fallback : url.hostname)
    }

    // Extract content of keyword/description <meta> tags
    for (const meta of document.querySelectorAll("meta")) {
        const name = meta.getAttribute("name")
        const content = meta.getAttribute("content")
        if (name === "description" && content) {
            // strip HTML-tag-looking things
            text.push(content.replace(/<[^<>]+>/g, ""))
        } else if (name === "keywords" && content) {
            for (const x of content.split(",")) { text.push(x) }
        }
    }

    text.push(extractText(document).trim())

    // Find the "href" attributes of all links with those
    const links = document.querySelectorAll("a").map(node => node.getAttribute("href")).filter(x => x !== undefined)

    return { text: text.join("\n"), links, title: document.querySelector("title")?.text }
}

const acceptableMIMETypes = [
    "text/",
    "application/xml"
]

const acceptMIMEType = mime => {
    for (const mimeType of acceptableMIMETypes) {
        if (mime.startsWith(mimeType)) { return true }
    }
    return false
}

const shouldCrawl = url => {
    const mime = mimeTypes.lookup(url.pathname)
    if (mime === false) { return true }
    return acceptMIMEType(mime)
}

export const enqueueCrawl = async (crawlURL, tier) => {
    // robotsPolicy will be filled in on first actual crawl for the domain
    // It would be nicer to do this in one query, but PostgreSQL is annoying about this and won't do anything with the RETURNING if nothng is actually updated
    let [domain] = await DB`INSERT INTO domains (domain, enabled, robotsPolicy, tier) 
    VALUES (${crawlURL.hostname}, FALSE, NULL, ${tier})
    ON CONFLICT DO NOTHING
    RETURNING id`
    if (!domain) {
        let [row] = await DB`SELECT * FROM domains WHERE domain = ${crawlURL.hostname}`
        domain = row
    }
    // Add entry to crawl queue
    await DB`INSERT INTO crawl_targets (url, domain)
    VALUES (${crawlURL.toString()}, ${domain.id})
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
    if (response.statusCode !== 200) { // assume any error means no robots.txt is present
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

const insertPage = async (url, raw, format, domainID, text, title) => {
    // TODO: Multiple language handling?
    const [result] = await DB`INSERT INTO pages (url, rawContent, rawFormat, domain, fts, pageText, pageTitle)
    VALUES (${url}, ${raw}, ${format}, ${domainID}, to_tsvector('english', ${text}), ${text}, ${title})
    ON CONFLICT (url) DO UPDATE SET rawContent = excluded.rawContent, rawFormat = excluded.rawFormat, updated = NOW(), fts = to_tsvector('english', ${text}), pageText = ${text}, pageTitle = ${title}
    RETURNING id`
    return result.id
}

export const crawl = async (rawURL, domainID) => {
    const [domainInfo] = await DB`SELECT * FROM domains WHERE id = ${domainID}`
    if (!domainInfo.robotsPolicy) {
        let policy = await fetchRobotsTxt(domainInfo.domain)
        if (policy === null) { policy = "none" } // distinguish between "policy not downloaded" and "no detected policy"
        domainInfo.robotsPolicy = policy
        await DB`UPDATE domains SET robotsPolicy = ${policy} WHERE id = ${domainID}`
    }
    
    if (domainInfo.robotsPolicy !== "none") {
        const robotsPolicy = parseRobotsTxt(domainInfo.robotsPolicy, domainInfo.domain)
        if (robotsPolicy.isDisallowed(rawURL, util.userAgent)) {
            log.warning(`${rawURL} access denied in robots policy`)
            return
        }
    }

    const pageURL = new URL(rawURL)
    // Download page
    const response = await got(rawURL, {
        timeout: 5000,
        headers: {
            "user-agent": util.userAgent,
            "accept": `text/html, text/plain;q=0.8, text/*;q=0.7`,
        },
        followRedirect: false
    })
    // redirect
    if (response.statusCode >= 300 && response.statusCode <= 399) {
        await enqueueCrawl(new URL(response.headers["location"], pageURL), domainInfo.tier + 1)
        return
    }

    const contentType = response.headers["content-type"]
    if (!acceptMIMEType(contentType)) {
        log.warning(`Content-Type ${contentType} is not acceptable; ignoring ${rawURL}`)
        return
    }

    log.info(`${rawURL} returned ${response.statusCode}`)

    const { text, links, title } = parsePage(response.body, pageURL)
    // Process links (absolutize URLs, drop off query/hash params)
    // then filter for unique links, then drop non-HTTP(S) URLs
    const absoluteLinks = R.pipe(
        R.map(link => processLink(link, pageURL)),
        R.uniqBy(link => link.toString()),
        R.filter(link => link.protocol === "http:" || link.protocol === "https:")
    )(links)

    const compressed = await util.zlibCompress(response.body)

    const pageID = await insertPage(rawURL, compressed, "zlib", domainID, text, title)

    // Add links to links table/crawl queue
    // TODO: combine all enqueue operations here into one query
    await Promise.all(absoluteLinks.map(async link => {
        await DB`INSERT INTO links (toURL, fromPage) VALUES (${link.toString()}, ${pageID})
        ON CONFLICT (toURL, fromPage) DO UPDATE SET lastSeen = NOW()`
        if (shouldCrawl(link) && !(await getPageID(link.toString()))) {
            log.info(`Queueing ${link.toString()} for potential crawling.`)
            await enqueueCrawl(link, domainInfo.tier + 1)
        }
    }))
}

export const crawlRandom = async () => {
    // Pick a random enabled and unlocked entry from the crawl queue
    const [next] = await DB`SELECT crawl_targets.id, crawl_targets.url, crawl_targets.domain
    FROM crawl_targets TABLESAMPLE SYSTEM_ROWS(100)
    INNER JOIN domains ON domains.id = crawl_targets.domain
    WHERE lockTime IS NULL AND domains.enabled = TRUE
    LIMIT 1`
    if (next) {
        // Lock entry
        await DB`UPDATE crawl_targets SET lockTime = NOW() where id = ${next.id}`
        try {
            // Attempt to crawl page, then remove it from queue
            log.info(`Crawling ${next.url}`)
            await crawl(next.url, next.domain)
            await DB`DELETE FROM crawl_targets WHERE id = ${next.id}`
        } catch(e) {
            // Unlock on error
            log.error(`Error when crawling ${next.url}:\n${e.stack}`)
            await DB`UPDATE crawl_targets SET lockTime = NULL where id = ${next.id}`
        }

        return true
    } else {
        return false
    }
}