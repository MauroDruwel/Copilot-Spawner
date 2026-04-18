# Security Policy

## Supported versions

Copilot Spawner is a small single-maintainer project. Only the latest `main` receives security fixes. If you are running a tagged release, upgrade to the latest tag (or `main`) before reporting — the issue may already be fixed.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Instead, use one of the following private channels:

- GitHub's private vulnerability reporting: <https://github.com/MauroDruwel/Copilot-Spawner/security/advisories/new>
- Email: `security@maurodruwel.be` (PGP optional; reply will be plaintext unless you include a key)

Include, where possible:

- A short description of the issue and its impact.
- Steps to reproduce (a minimal script, a curl command, or a screenshot).
- The commit hash or release tag you tested against.
- Your assessment of severity.

You should receive an acknowledgement within **72 hours**. A fix target, workaround, or a reasoned decline will follow within **14 days** for most reports.

## Scope

In scope:

- Authentication bypass on `/api/*` endpoints.
- Path traversal out of `COPILOT_WORKSPACE`.
- Command injection through the `start`, `clone`, `folders`, or `contributors` endpoints.
- WebSocket-originated RCE or privilege escalation.
- Session-cookie forgery.
- XSS in any rendered page.

Out of scope:

- Issues that require an attacker to already have the `COPILOT_SPAWNER_PASSWORD`. By design, an authenticated user can execute arbitrary commands — that is the product. Protect the password.
- Denial of service via unlimited session creation or unbounded WebSocket messages. Put a reverse proxy (Cloudflare, nginx, Caddy) in front for production.
- Missing security headers that a reverse proxy is expected to add (HSTS, CSP, etc.).
- Running the server on `0.0.0.0` without TLS — by default it binds to `127.0.0.1`. Overriding that is the operator's responsibility.
- Outdated dependencies in a lockfile you generated yourself.

## Disclosure

I prefer coordinated disclosure. A typical timeline:

1. Report received and acknowledged.
2. Fix developed on a private branch; reporter is invited to review.
3. Fix merged and a new tag cut.
4. Public advisory published 7 days after the fix, crediting the reporter (unless they prefer to remain anonymous).

Thanks for helping keep Copilot Spawner users safe.
