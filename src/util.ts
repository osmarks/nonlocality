const zlib = require("zlib")
const nodeUtil = require("util")
export const pkg = require("../package.json")
const stemmer = require("stemmer")

export const zlibCompress = nodeUtil.promisify(zlib.deflate)
export const timestamp = () => Date.now()
export const userAgent = `${pkg.name}/${pkg.version} crawler bot (contact osmarks@protonmail.com)`

// Strip non-word characters, split spaces, also split at hyphens, and convert to stemmed form
export const toTokens = text => text.replace(/[^ A-Za-z0-9-]/g, "").split(" ").flatMap(x => x.split("-")).filter(x => x !== "").map(stemmer)