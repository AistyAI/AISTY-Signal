# Connect Google Workspace

Aisty Signal uses a **service account with domain-wide delegation**. It impersonates:

- a **super admin**, to read the user directory, each user's OAuth tokens and the token audit log
- **each user**, to search their mailbox for AI vendor emails (headers only)

Setup takes about 10 minutes and needs a Google Workspace **super admin** and access to a Google Cloud project.

> **The easy way:** in Aisty Signal, open **Connections → Connect Google Workspace**. The wizard walks you through these same steps, links straight to each admin page, and shows the exact Client ID and scopes to paste. This page is the written version.

## 1. Create a Cloud project and enable APIs

1. Go to <https://console.cloud.google.com/> and create a project (e.g. `aisty-signal`).
2. Open **APIs & Services → Library** and enable:
   - **Admin SDK API**
   - **Gmail API** (skip this if you set `GOOGLE_SCAN_MAIL=false`)

## 2. Create the service account and key

1. Go to **IAM & Admin → Service Accounts → Create service account**. Name it `aisty-signal`. It needs no project roles.
2. Open it, go to **Keys → Add key → Create new key → JSON**, and download the file.
3. Treat the file like a password. You'll upload it to Aisty Signal in step 4, and then you can delete the download.
4. Aisty Signal shows the OAuth **Client ID** once you upload the key. It's also the service account's **Unique ID** on its Details tab.

> If key creation is blocked, your organisation enforces `iam.disableServiceAccountKeyCreation`. Ask a Cloud admin for an exception on this project.

## 3. Authorise domain-wide delegation

1. In the Google Admin console (<https://admin.google.com>), go to **Security → Access and data control → API controls → Manage domain-wide delegation → Add new**.
2. **Client ID**: the Unique ID from step 2.
3. **OAuth scopes**: paste this as one line:

```
https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.user.security,https://www.googleapis.com/auth/admin.reports.audit.readonly,https://www.googleapis.com/auth/gmail.readonly
```

Leave out the last scope if you aren't scanning mail.

4. Click **Authorise**. It can take a few minutes, occasionally up to an hour, to take effect.

## 4. Connect Aisty Signal

In the wizard (**Connections → Connect Google Workspace**):

1. Drop the JSON key onto the upload box.
2. Enter a **super admin** email. Aisty Signal acts as this admin to read the directory and audit logs.
3. Choose whether to scan mailboxes.
4. Click **Connect and test**.

The key is encrypted and stored in `data/settings.json`.

<details><summary>Headless alternative: .env</summary>

```ini
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./secrets/google-service-account.json
GOOGLE_ADMIN_EMAIL=you@yourcompany.com
GOOGLE_CUSTOMER_ID=my_customer
GOOGLE_SCAN_MAIL=true
```
</details>

## What each scope is used for

| Scope | Used for |
|---|---|
| `admin.directory.user.readonly` | Names, departments and job titles of users |
| `admin.directory.user.security` | Each user's third-party OAuth tokens ("Sign in with Google" apps) |
| `admin.reports.audit.readonly` | Token authorisation events (catches grants that were later revoked) |
| `gmail.readonly` | Searching for messages from AI vendor domains, then reading only the `From` and `Subject` headers |

Google's narrower `gmail.metadata` scope can't be used with search queries, so `gmail.readonly` is the narrowest scope that works. Aisty Signal only ever requests `format=metadata`. See `src/providers/google.ts`.

## Troubleshooting

| Error | Fix |
|---|---|
| `unauthorized_client` | Delegation isn't authorised yet, or the Client ID or scopes don't match exactly. Wait a few minutes and check again. |
| `403 Not Authorized to access this resource/api` | `GOOGLE_ADMIN_EMAIL` isn't a super admin, or the Admin SDK API isn't enabled. |
| Mailboxes counted as skipped | Those users have no Gmail licence. This is expected. |

## Removing access

Click **Disconnect** in Aisty Signal. Then delete the delegation entry in the Admin console, and delete the key or the whole service account in Cloud Console.
