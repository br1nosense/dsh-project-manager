# Security Policy

## Reporting a vulnerability

This plugin runs in the DSH host process and exposes a same-origin REST API
(`/project-manager/api/*`) plus a project launch facility (arbitrary commands
in arbitrary working directories). Treat anything that lets a caller start or
stop processes, or read logs, as security-relevant.

Please report suspected vulnerabilities privately by opening a **security
advisory** on this repository
(https://github.com/br1nosense/dsh-project-manager/security/advisories/new)
or by contacting the maintainer directly. Do **not** open a public issue for
a security problem.

## What is expected

- The plugin trusts its own settings (`project-manager:` in
  `~/.dsh/settings.yaml`) as the operator's explicit intent — no sandboxing of
  launched processes is attempted.
- The REST API is same-origin only; do not expose the DSH web port to
  untrusted networks.
- Report, don't fix silently: give maintainers a reasonable window (default
  90 days) before public disclosure.

## Supported versions

The latest release on the `main` branch is the supported version. Patches are
backported on request for the current major version.
