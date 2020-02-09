const fs = require("fs")
const path = require("path")
const toml = require("toml")
const R = require("ramda")

const raw = fs.readFileSync(path.join(__dirname, "..", "config.toml"))
const config = toml.parse(raw)

module.exports = (path, defaultValue) => {
    const configValue = R.view(R.lensPath(path.split(".")), config)
    if (configValue === undefined && defaultValue === undefined) { throw new Error(`Config parameter ${path} required`) }
    else if (configValue === undefined) { return defaultValue }
    else { return configValue }
}