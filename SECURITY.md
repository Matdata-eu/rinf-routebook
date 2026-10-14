# Security policy

Please report security problems privately through GitHub: **[Report a vulnerability](https://github.com/Matdata-eu/rinf-routebook/security/advisories/new)** on the Security tab of this repository. Don't open a public issue.

You will get an answer within a week. Fixes are released for the latest version; the Docker image `ghcr.io/matdata-eu/rinf-routebook:latest` follows the latest release.

Things worth knowing when you deploy Routebook:

- Keys for map layers belong in environment variables, used as `${NAME}` in the configuration, with `"proxy": true` on the layer. Keys of layers without `proxy` are sent to every browser.
- The tile proxy only fetches the configured layers, but anyone who can reach your Routebook can use it to view those tiles. Put it behind your organisation's sign-in if the imagery terms require that.
