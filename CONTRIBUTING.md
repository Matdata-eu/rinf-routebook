# Contributing

Thanks for your interest in Routebook! Bug reports, data findings for a country, ideas and pull requests are all welcome. For questions, use [GitHub Discussions](https://github.com/Matdata-eu/rinf-routebook/discussions); for bugs and feature requests, [issues](https://github.com/Matdata-eu/rinf-routebook/issues). For a larger change, open an issue first so we can agree on the approach.

## Setup

```bash
pnpm install
pnpm build
pnpm fetch:nor      # Norway snapshot from the public ERA endpoint (or: pnpm routebook fetch --dataset <country>)
pnpm test
pnpm typecheck
```

Requirements: Node.js ≥ 22 and pnpm 10.

## Ground rules

The [code of conduct](CODE_OF_CONDUCT.md) applies to everything in this project.

- **Public data only.** The core uses public RINF data from the ERA knowledge graph. Don't add internal or non-public infrastructure-manager data to this repository.
- **No guessing.** If RINF doesn't have something, mark it as a gap (`RINF_GAPS`) or a `missing` item instead of inventing a value. Positions or values that are estimated must have the quality `approximate`.
- **Keep the core open.** Proprietary or data-specific features belong in a separate package that plugs into `@routebook/core-extensions`. Item kinds from a plugin are namespaced as `<pluginId>:<kind>`.
- **No keys in the repository.** Map layer keys and other deployment settings go in `config/config.json`, `config.json` or `.env`, which are git-ignored. Use `${NAME}` placeholders in examples.
- **Not only Norway.** Code must not assume one country or infrastructure manager; put country-specific knowledge in a dataset or a plugin, and say which data it was checked against.
- **Queries are code.** Add or change SPARQL in `packages/rinf-client/queries/*.rq`, using the `{{graph}}` parameter. Document new data findings in `docs/`.

## Pull requests

- Keep changes focused, and add or update tests (Vitest, `packages/*/test` and `apps/*/test`).
- `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm smoke` (needs Chrome) must pass.
- For UI changes, attach screenshots (`pnpm screenshots` produces them headlessly).
- Add a line to `CHANGELOG.md` under *Unreleased*.

By contributing, you agree that your contribution is licensed under the MIT license.
