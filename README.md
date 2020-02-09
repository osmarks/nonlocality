# myrkheim

A simple, small-scale search engine.

Only crawls explicitly whitelisted domains, though currently pays no attention to `robots.txt`.

## How to use

1. Install dependencies: `npm install`.
2. Copy `config.example.toml` to `config.toml` and make the necessary changes for your setup (*please* change the session secret and password hash).
3. Start the application (node `src/index.js`) (for an actual server setup you will want to use a service manager of some sort).
4. Access the `/admin` page and submit a URL to crawl, then enable iton the Domains page.