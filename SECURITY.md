# Security policy

Aisty Signal holds admin-level, read-only credentials to Google Workspace and Microsoft 365, so we take security reports seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report privately through [GitHub security advisories](https://github.com/AistyAI/AISTY-Signal/security/advisories/new).

Include steps to reproduce and the impact. We aim to acknowledge reports within 3 working days.

## Supported versions

Only the latest release on `main` receives security fixes.

## Hardening checklist for operators

- Keep it on `127.0.0.1`, or put it behind HTTPS and a reverse proxy with its own authentication.
- Set `SIGNAL_ENCRYPTION_KEY` so the encryption key isn't stored next to `data/`.
- Restrict filesystem access to the `data/` folder.
- When you're done, use **Disconnect**, then delete the Google service account key or Entra client secret.
