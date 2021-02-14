import * as R from "ramda"

import * as log from "./log"
import DB from "./db"
import * as util from "./util"

const search = async query => {
    const start = util.timestamp()

    // TODO: there are possible XSS vulnerabilities from the headline thing here
    // I don't know if there ARE any, as HTML is preparsed beforehand, but it should be checked
    const out = await DB`SELECT url, updated, ts_rank_cd(fts, query) AS rank, ts_headline(pageText, query, 'MaxFragments=3,MaxWords=60') AS snippet, pageTitle
    FROM pages, to_tsquery(${query}) query WHERE fts @@ query
    ORDER BY rank DESC LIMIT 100`

    const end = util.timestamp()
    await DB`INSERT INTO search_history (query, quantityResults, timeTaken)
    VALUES (${query}, ${out.length}, ${end - start})`
    return { list: out, time: end - start, query }
}

export default search