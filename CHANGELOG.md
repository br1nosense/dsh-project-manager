# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and versions aim to
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `verify.mjs` bundle-structure check and a GitHub Actions workflow that runs
  it on push and pull requests.
- English README (`README.en.md`), `CONTRIBUTING.md` and `SECURITY.md`.

### Changed
- `package.json` now carries repository / homepage / bugs / keywords metadata.

## [0.1.0] - 2026-08-16

### Added
- Initial release: DSH project management plugin — a draggable floating window
  in the DSH web UI to manage development projects:
  - add / delete projects, one-click start / stop / restart
  - hot-reload auto-restart on file changes (`fs.watch`, debounced 500 ms,
    extension whitelist)
  - real-time logs (in-memory ring buffer + persistent `logs/<id>.log`)
  - settings namespace `project-manager:` (hot-reloaded) and a REST API under
    `/project-manager/api/*`.
