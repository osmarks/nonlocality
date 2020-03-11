const postgres = require("postgres")

const log = require("./log.js")
const config = require("./config.js")

const DB = postgres(config("application.database"), {
    onnotice: notice => log.info(`DB notice: ${notice.message}`)
})

const migrations = [
`
CREATE TABLE domains (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    enabled BOOL NOT NULL,
    robotsPolicy TEXT
);

CREATE TABLE pages (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    rawContent BYTEA NOT NULL,
    rawFormat TEXT NOT NULL,
    updated TIMESTAMP NOT NULL DEFAULT NOW(),
    domain SERIAL NOT NULL REFERENCES domains(id)
);

CREATE TABLE page_tokens (
    id SERIAL PRIMARY KEY,
    page INTEGER NOT NULL REFERENCES pages(id),
    token TEXT NOT NULL,
    weight DOUBLE PRECISION NOT NULL
);

CREATE INDEX page_tokens_ix ON page_tokens(token);

CREATE TABLE links (
    id SERIAL PRIMARY KEY,
    toURL TEXT NOT NULL,
    fromPage SERIAL NOT NULL REFERENCES pages(id),
    lastSeen TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (toURL, fromPage)
);

CREATE TABLE crawl_queue (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    lockTime TIMESTAMP,
    added TIMESTAMP NOT NULL DEFAULT NOW(),
    domain SERIAL NOT NULL REFERENCES domains(id)
);

CREATE TABLE search_history (
    id SERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    quantityResults INTEGER,
    timeTaken REAL
);
`
]

const migrate = async () => {
    await DB`
    CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        executed TIMESTAMP NOT NULL
    )
    `
    const [result] = await DB`SELECT MAX(id) FROM migrations`
    const migrationExecuted = result.max || 0
    for (let i = migrationExecuted; i < migrations.length; i++) {
        try {
            await DB.begin(async tx => {
                await tx.unsafe(migrations[i])
                await tx`INSERT INTO migrations (id, executed) VALUES (${i + 1}, NOW())`
            })
        } catch(e) {
            log.error(`Migration ${i + 1}: ${e}`)
            await DB.end()
            process.exit()
        }
        log.info(`Migrated DB to schema ${i + 1}`)
    }

    return
}

migrate()

module.exports = DB