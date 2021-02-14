import postgres from "postgres"

import * as log from "./log"
import config from "./config"

const DB = postgres(config("application.database"), {
    onnotice: notice => log.info(`DB notice: ${notice.message}`)
})

const migrations = [
`
CREATE EXTENSION IF NOT EXISTS tsm_system_rows;

CREATE TABLE domains (
    id SERIAL PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    enabled BOOL NOT NULL,
    tier INTEGER NOT NULL,
    robotsPolicy TEXT
);

CREATE TABLE pages (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    rawContent BYTEA NOT NULL,
    rawFormat TEXT NOT NULL,
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    domain SERIAL NOT NULL REFERENCES domains(id),
    pageText TEXT NOT NULL,
    fts TSVECTOR NOT NULL,
    pageTitle TEXT
);

CREATE TABLE links (
    id SERIAL PRIMARY KEY,
    toURL TEXT NOT NULL,
    fromPage SERIAL NOT NULL REFERENCES pages(id),
    lastSeen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (toURL, fromPage)
);

CREATE TABLE crawl_targets (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    lockTime TIMESTAMP,
    added TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    domain SERIAL NOT NULL REFERENCES domains(id)
);

CREATE TABLE search_history (
    id SERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    quantityResults INTEGER,
    timeTaken REAL
);
`,
`
CREATE INDEX page_search_index ON pages USING GIN (fts);
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

export default DB