# Security policy

Please report security problems privately through GitHub: **[Report a vulnerability](https://github.com/Matdata-eu/rinf-routebook/security/advisories/new)** on the Security tab of this repository. Don't open a public issue.

You will get an answer within a week. Fixes are released for the latest version; the Docker image `ghcr.io/matdata-eu/rinf-routebook:latest` follows the latest release.

Things worth knowing when you deploy Routebook:

- Keys for map layers belong in environment variables, used as `${NAME}` in the configuration, with `"proxy": true` on the layer. Keys of layers without `proxy` are sent to every browser.
- The tile proxy only fetches the configured layers, but anyone who can reach your Routebook can use it to view those tiles. It refuses cross-site requests (other web pages embedding your tiles), limits each client to `ROUTEBOOK_TILE_RATE` tiles per minute (default 1200) and keeps a shared cache, which together keep a key's quota from being drained by one user. This is not access control: put Routebook behind your organisation's sign-in if the imagery terms require that. Behind a reverse proxy set `ROUTEBOOK_TRUST_PROXY=1`, so that the limit applies per user.
- HTML pages carry a Content-Security-Policy that only allows scripts from the app's own origin; plugin modules are therefore served by the deployment itself (`plugins/`). Only install plugins you trust: they run with the app's full access in the browser.
- The privacy statement's `text` is escaped; only an `.html` file or `html` is used as HTML.
