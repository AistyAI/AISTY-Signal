# Privacy and data protection

Aisty Signal processes personal data about your employees: their names, email addresses, departments, and the senders and subjects of some of their emails. This page explains what it touches and what to put in place before you run it. **It isn't legal advice.**

## What Aisty Signal reads

| Source | Read | Not read |
|---|---|---|
| Directory | Name, email, department, job title | Passwords, MFA, devices |
| Sign-in grants and audit log | App name, scopes, time of authorisation | — |
| Mailboxes | **Sender, subject and date** of messages from a fixed list of AI vendor and payment-processor domains | Message bodies, attachments, any other mail |
| CSV import | Rows matching an AI vendor | Everything else in the file is discarded |

All processing happens on **your** server. Aisty Signal sends nothing to Aisty or any other third party. The only outbound calls go to Google and Microsoft APIs, plus Google Fonts for the dashboard typeface.

## What it stores

`data/settings.json` holds your connection credentials (encrypted) and the admin password hash. `data/signal.json` holds results. Both are readable only by the account Aisty Signal runs as. Results include:

- directory details for users
- each finding: user, AI tool, evidence type, date, and a short detail string. That's the sender plus subject, or just the sender if `SIGNAL_STORE_SUBJECTS=false`.

**Connections → Delete all results** removes it. Set your own retention policy and delete results when they're no longer needed.

## Before you scan (UK GDPR and EU GDPR)

1. **Lawful basis.** Most organisations rely on legitimate interests: information security and managing data-protection risk from unsanctioned AI tools. Record a legitimate interests assessment.
2. **DPIA.** Monitoring employee mailboxes is likely to need a Data Protection Impact Assessment. The ICO's employment practices guidance on monitoring workers applies.
3. **Transparency.** Tell staff, for example in your acceptable use or IT monitoring policy, that you check company accounts for sign-ups to third-party AI services.
4. **Minimise.** Consider `SIGNAL_STORE_SUBJECTS=false`, a shorter `SCAN_LOOKBACK_DAYS`, or turning off mailbox scanning and using sign-in grants only.
5. **Proportionate follow-up.** Use the results to govern tools, not to discipline people for honest experimentation.

Works councils or employee representatives may need to be consulted in some jurisdictions, such as Germany, France and the Netherlands.
