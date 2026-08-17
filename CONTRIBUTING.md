# Contributing

Thanks for considering contributing to `dsh-project-manager`.

## Development

- `lib/index.js` — host half (process management, hot reload, logs, REST API).
- `lib/client.js` — browser half (floating window UI in `shell.overlay`).
- Client-side changes are hot-updated by `dsh-client-hmr`; host-half changes
  need a `dsh web` restart.

## Before committing

Run the bundle verification to make sure the package still meets the
installable-bundle contract:

```sh
node verify.mjs
```

It checks that `package.json` is valid, `dsh.bundle.patch` exists, all
`main` / `exports` / `files` entries resolve, `lib/*.js` parses, and
README/LICENSE are present.

## Commit conventions

Keep commits focused and use conventional prefixes (`feat:`, `fix:`, `docs:`,
`test:`, `ci:`, `chore:`). Update `CHANGELOG.md` under `[Unreleased]` for
user-visible changes.

## Reporting issues

Include: DSH version (`dsh --version`), Windows/Node versions, how you
installed the plugin, the failing command or REST call, and the relevant
section of the project log (`logs/<id>.log`).

## License

By contributing you agree that your changes are licensed under MIT.
