import * as fs from "fs"
import * as path from "path"
import { parse } from "toml"
import * as R from "ramda"

const raw = fs.readFileSync(path.join(__dirname, "..", "config.toml"), { encoding: "utf8" })
const config = parse(raw)

export default (path, defaultValue=undefined) => {
    const configValue = R.view(R.lensPath(path.split(".")), config)
    if (configValue === undefined && defaultValue === undefined) { throw new Error(`Config parameter ${path} required`) }
    else if (configValue === undefined) { return defaultValue }
    else { return configValue }
}