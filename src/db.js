const database = require("better-sqlite3")

const log = require("./log.js")
const config = require("./config.js")

const DB = database(config("application.database_path", "db.sqlite3"))

const migrations = [
`
CREATE TABLE page_tokens (
    id INTEGER PRIMARY KEY,
    page INTEGER NOT NULL REFERENCES pages(id),
    token TEXT NOT NULL,
    weight REAL NOT NULL
);

CREATE INDEX page_tokens_ix ON page_tokens(token);

CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    toURL TEXT NOT NULL,
    fromURL TEXT NOT NULL,
    lastSeen INTEGER NOT NULL,
    UNIQUE (toURL, fromURL)
);

CREATE TABLE domains (
    id INTEGER PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    enabled BOOL NOT NULL,
    robotsPolicy TEXT
);

CREATE TABLE pages (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    rawContent BLOB NOT NULL,
    rawFormat TEXT NOT NULL,
    updated INTEGER NOT NULL,
    domain INTEGER NOT NULL REFERENCES domains(id)
);

CREATE TABLE crawl_queue (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    lockTime INTEGER,
    added INTEGER NOT NULL,
    domain INTEGER NOT NULL REFERENCES domains(id)
);
`,
`
CREATE TABLE search_history (
    id INTEGER PRIMARY KEY,
    query TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    quantityResults INTEGER,
    timeTaken REAL
)
`
]

const executeMigration = DB.transaction((i) => {
    const migration = migrations[i]
    DB.exec(migration)
    DB.pragma(`user_version = ${i + 1}`)
    log.info(`Migrated to schema ${i + 1}`)
})

const schemaVersion = DB.pragma("user_version", { simple: true })
if (schemaVersion < migrations.length) {
    log.info(`Migrating DB - schema ${schemaVersion} used, schema ${migrations.length} available`)
    for (let i = schemaVersion; i < migrations.length; i++) {
        executeMigration(i)
    }
}

DB.pragma("foreign_keys = 1")

module.exports = DB