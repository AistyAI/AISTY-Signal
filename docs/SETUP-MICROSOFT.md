# Connect Microsoft 365 (Entra ID)

Aisty Signal uses an **Entra ID app registration** with read-only **application** permissions on Microsoft Graph. Setup takes about 5 minutes. A **Global Administrator** or **Privileged Role Administrator** must grant consent.

> **The easy way:** in Aisty Signal, open **Connections → Connect Microsoft 365**. The wizard walks you through these steps, gives you the redirect URI to copy, and has a **Grant admin consent** button. This page is the written version.

## 1. Register the app

1. Go to <https://entra.microsoft.com>, then **Identity → Applications → App registrations → New registration**.
2. **Name**: `Aisty Signal`. **Supported account types**: *Accounts in this organizational directory only*.
   **Redirect URI**: choose **Web** and enter `http://localhost:3000/connect/microsoft/callback`, using your Aisty Signal address and port. Microsoft only allows plain `http` for `localhost`; anything else needs HTTPS. Click **Register**.
3. From the **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.

## 2. Add permissions

1. Go to **API permissions → Add a permission → Microsoft Graph → Application permissions**, then add:

| Permission | Used for |
|---|---|
| `User.Read.All` | Names, departments and job titles |
| `Application.Read.All` | Third-party enterprise apps (service principals) and who's assigned to them |
| `DelegatedPermissionGrant.Read.All` | Which users consented to which app ("Sign in with Microsoft") |
| `Mail.ReadBasic.All` | Sender, subject and date of messages. **It can't read bodies or attachments.** Skip it if `MS_SCAN_MAIL=false`. |

2. Grant admin consent: use the **Grant admin consent** button in Aisty Signal's wizard after saving (step 4), or click **Grant admin consent for <your organisation>** here. Every permission should show a green tick.

## 3. Create a client secret

**Certificates & secrets → New client secret**: pick an expiry and copy the secret **Value** (not the Secret ID). It's only shown once.

## 4. Connect Aisty Signal

In the wizard (**Connections → Connect Microsoft 365**):

1. Paste the tenant ID, client ID and secret **Value**.
2. Choose whether to scan mailboxes.
3. Click **Save and test**.
4. If you haven't granted consent yet, click **Grant admin consent**, approve, and you'll come back to Aisty Signal. Then click **Test connection**.

The secret is encrypted and stored in `data/settings.json`. The UI only ever shows its last four characters.

<details><summary>Headless alternative: .env</summary>

```ini
MS_TENANT_ID=00000000-0000-0000-0000-000000000000
MS_CLIENT_ID=00000000-0000-0000-0000-000000000000
MS_CLIENT_SECRET=your-secret-value
MS_SCAN_MAIL=true
```
</details>

## Notes

- **Restricting mailbox access.** You can limit which mailboxes the app can read with Exchange *RBAC for Applications* or an *application access policy*. Mailboxes outside that scope are reported as "denied" in the scan stats and won't be checked.
- **Org-wide consents.** If an admin consented to an AI app for everyone, Aisty Signal shows it as *(organisation-wide)* under **Needs attention**.
- **First-party apps.** Microsoft's own apps (including Copilot) are excluded. Manage them in the Microsoft 365 admin centre.
- **Secret expiry.** When the secret expires, scans fail with a sign-in error. Create a new one, then use **Edit** on the Microsoft 365 card to paste it.

## Troubleshooting

| Error | Fix |
|---|---|
| `Microsoft sign-in failed: AADSTS7000215` | Wrong secret. Use the secret **Value**, not its ID. |
| `403 Authorization_RequestDenied` | Admin consent wasn't granted, or a permission is missing. |
| `403 ErrorAccessDenied` on mailboxes | `Mail.ReadBasic.All` is missing consent, or an application access policy excludes those mailboxes. |
| Mailboxes counted as skipped | Those users have no Exchange Online mailbox. This is expected. |

## Removing access

Click **Disconnect** in Aisty Signal, then delete the app registration (or just its client secret) in Entra ID.
