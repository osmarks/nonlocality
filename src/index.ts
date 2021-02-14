import express from "express"
import PromiseRouter from "express-promise-router"
import cookieSession from "cookie-session"
import flash from "connect-flash"
import * as dateFns from "date-fns"
import { createHash } from "crypto"

import * as crawler from "./crawler"
import * as log from "./log"
import DB from "./db"
import * as util from "./util"
import config from "./config"
import search from "./search"

setInterval(() => crawler.crawlRandom(), config("crawler.crawl_delay", 1000))

const server = express()
server.use("/dist", express.static("dist"))
server.use(express.urlencoded({ extended: true }))
server.use(cookieSession({
    name: `${util.pkg.name}-session`,
    secret: config("security.session_secret")
}))
server.use(flash())
server.use((req, res, next) => {
    res.locals.flashes = req.flash()
    next()
})
server.use((err, req, res, next) => {
    if (res.headersSent) { return next(err) }
    req.flash("error", err.stack)
    res.redirect("/")
})

const app = PromiseRouter()

app.get("/", async (req, res) => {
    res.render("index", { title: "Search" })
})

const flashError = (req, res, error, redirect) => {
    req.flash("error", error)
    res.redirect(redirect)
}

app.get("/login", async (req, res) => {
    res.render("login", { title: "Login", searchForm: false })
})

app.post("/login", async (req, res) => {
    if (!req.body.password) { return flashError(req, res, "No password provided.", "/login") }
    if (createHash("sha256").update(req.body.password).digest("hex") !== config("security.password_hash")) { return flashError(req, res, "Invalid password provided.", "/login") }
    req.session.authed = true
    req.session.save()
    log.info("User logged in")
    res.redirect("/admin")
})

app.use("/admin", (req, res, next) => {
    if (!req.session || !req.session.authed) {
        return flashError(req, res, "Login required to access admin page.", "/login")
    }
    next()
})

app.get("/admin", async (req, res) => {
    const [[crawlTargets], [domainCount], [enabledDomainCount]] = await Promise.all([ DB`SELECT COUNT(*) FROM crawl_targets`, DB`SELECT COUNT(*) FROM domains`, DB`SELECT COUNT(*) FROM domains WHERE enabled = TRUE` ])
    res.render("admin", { title: "Admin", crawlTargets: crawlTargets.count, domainCount: domainCount.count, enabledDomainCount: enabledDomainCount.count })
})


app.get("/admin/domains", async (req, res) => {
    const domains = await DB`SELECT * FROM domains ORDER BY tier, domain ASC`
    res.render("domains-list", { title: "Configure Domains", domains })
})

app.post("/admin/domains", async (req, res) => {
    if (!req.body.domain) { return flashError(req, res, "No domain provided.", "/admin/domains") }
    const enable = req.body.enable === "on" ? true : false
    const tier = parseInt(req.body.tier)
    DB`UPDATE domains SET enabled = ${enable}, tier = ${tier} WHERE domain = ${req.body.domain}`
    req.flash("info", `${enable ? "Enabled" : "Disabled"} crawling of domain ${req.body.domain}, set tier to ${tier}.`)
    res.redirect("/admin/domains")
})

app.post("/admin/crawl", async (req, res) => {
    if (!req.body.url) { return flashError(req, res, "No URL provided.", "/admin") }
    try {
        const url = new URL(req.body.url)
        await crawler.enqueueCrawl(url, 0)
        log.info(`Queueing ${url}`)
        req.flash("info", `Added ${url} to queue.`)
    } catch(e) {
        if (e.code === "ERR_INVALID_URL") { req.flash("error", `${req.body.url} is an invalid URL.`) }
        else { throw e }
    }
    res.redirect("/admin")
})

app.post("/admin/logout", async (req, res) => {
    req.session.authed = false
    req.session.save()
    log.info("User logged out")
    res.redirect("/")
})

app.get("/search", async (req, res) => {
    const query = req.query.query
    if (!query) { return flashError(req, res, "No query provided.", "/") }
    const results = await search(query)
    results.list.forEach(x => { x.updated = dateFns.format(x.updated, "HH:mm:ss dd/MM/yyyy") })
    res.render("search-results", { title: `"${query}" search results`, results })
})

server.locals.package = util.pkg

server.use(app)

const port = config("server.port", 5390)
server.set("view engine", "pug")
server.set("trust proxy", "loopback")
server.listen(port, () => log.info(`Running on http://localhost:${port}`))