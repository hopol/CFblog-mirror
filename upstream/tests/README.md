Run the suite with `npm test` on Node.js 22.13+ or Node.js 24+.

The backend regression tests use the built-in `node:sqlite` module to execute
the repository's `schema.sql` and the request handlers' SQL against an isolated
in-memory database. They do not connect to Cloudflare or change production data.
