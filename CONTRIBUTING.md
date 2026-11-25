# Contributing to Aisty Signal

Contributions are welcome, especially **new AI tools in the catalogue**.

## Adding an AI tool

Edit `catalogue/ai-vendors.json` and add an entry:

```json
{
  "id": "acmeai",
  "name": "Acme AI",
  "category": "Chat assistant",
  "website": "https://acme.ai",
  "emailDomains": ["acme.ai"],
  "appNames": ["Acme AI"],
  "billingNames": ["ACME AI", "Acme Intelligence Ltd"]
}
```

- **emailDomains**: domains the vendor sends account mail from. Subdomains match automatically, so `acme.ai` covers `mail.acme.ai`. Only list domains the vendor owns. Never list shared domains such as `google.com`, `github.com` or `sendgrid.net`.
- **appNames**: the name the tool shows under when someone uses "Sign in with Google/Microsoft". Matching is whole-word and case-insensitive.
- **billingNames**: how the tool appears on card statements and on Stripe or Paddle receipts.

Then run `npm test`. If the name could be ambiguous (e.g. "Bolt", "Gamma"), add a test in `test/classify.test.ts`.

## Development

```bash
npm install
npm run demo      # demo data
npm run dev       # real connectors, auto-reload
npm test
npm run typecheck
```

The dashboard (`public/`) is plain HTML, CSS and JavaScript with no build step. Always escape API data with `esc()` before inserting it as HTML, because email subjects are attacker-controlled.

## Reporting security issues

Please don't open a public issue. Email the maintainers via <https://www.aisty.ai>.
