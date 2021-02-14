# nonlocality

A simple, small-scale search engine which basically just works as a crawler + frontend to PostgreSQL full text search (which is admittedly not particularly good).
It now probably obeys robots.txt, and crawls only explicitly enabled domains.
As suggested [here](https://drewdevault.com/2020/11/17/Better-than-DuckDuckGo.html) ranking is based on per-domain tiers instead of complex PageRank-type things.