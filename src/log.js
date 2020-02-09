const chalk = require("chalk")
const { format } = require("date-fns")

const rawLog = (level, main) => {
    const timestamp = format(new Date(), "HH:mm:ss")
    console.log(chalk`{bold ${timestamp}} ${level} ${main}`)
}

module.exports = {
    info: x => rawLog(chalk.black.bgBlueBright("INFO"), x),
    warning: x => rawLog(chalk.black.bgKeyword("orange")("WARN"), x),
    error: x => rawLog(chalk.black.bgRedBright("FAIL"), x)
}