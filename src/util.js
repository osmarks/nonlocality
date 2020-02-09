const zlib = require("zlib")
const nodeUtil = require("util")
const package = require("../package.json")
const stemmer = require("stemmer")

const zlibCompress = nodeUtil.promisify(zlib.deflate)
const timestamp = () => new Date().getTime()
const userAgent = `${package.name}/${package.version} crawler (contact osmarks@protonmail.com)`
const boolToNum = bool => bool ? 1 : 0
const numToBool = num => {
    if (num === 0) { return false }
    else if (num === 1) { return true }
    else { throw new Error("value must be 0 or 1") }
}

// Strip non-word characters, split spaces, also split at hyphens, and convert to stemmed form
const toTokens = text => text.replace(/[^ A-Za-z0-9-]/g, "").split(" ").flatMap(x => x.split("-")).filter(x => x !== "").map(stemmer)


module.exports = {
    timestamp,
    zlibCompress,
    userAgent,
    boolToNum,
    numToBool,
    toTokens,
    applicationName: package.name
}