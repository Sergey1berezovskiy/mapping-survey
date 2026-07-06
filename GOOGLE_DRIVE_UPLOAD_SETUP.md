# Google Drive direct photo upload and direct Sheets submit

Railway uploads survey photos directly to Google Drive API. Apps Script is still used for form config and references. The final response can be written directly from Railway to Google Sheets API, which is faster than sending it through Apps Script.

The source spreadsheet with questions/references and the result spreadsheet can be different. This is recommended when you want to share only submitted answers with reviewers.

## Recommended for personal Google Drive

Service accounts cannot own files in a regular personal "My Drive" folder, so for a personal Google account use OAuth.

### Google Cloud setup

1. Open Google Cloud Console.
2. Create or select a project.
3. Enable **Google Drive API**.
4. Open **APIs & Services -> OAuth consent screen**.
5. Set user type to **External** and add your Google account as a test user.
6. Open **Credentials -> Create credentials -> OAuth client ID**.
7. Choose **Web application**.
8. Add this Authorized redirect URI:

```text
https://mappingsurvey.up.railway.app/debug/oauth/callback
```

9. Copy the OAuth client ID and client secret.

### Railway variables

Add or keep:

```text
APPS_SCRIPT_URL=...
GOOGLE_SHEETS_RESULTS_URL=...
GOOGLE_SHEETS_RESULTS_SHEET=Лист1
GOOGLE_DRIVE_FOLDER_ID=...
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
```

`GOOGLE_SHEETS_RESULTS_URL` is the full link to the separate spreadsheet where submitted answers are written. You can also use `GOOGLE_SHEETS_RESULTS_SPREADSHEET_ID` and paste only the spreadsheet id.

Legacy variables `GOOGLE_SHEETS_URL` and `GOOGLE_SHEETS_SPREADSHEET_ID` are still supported as fallback, but the `RESULTS` names are preferred because the source spreadsheet and result spreadsheet can be different.

`GOOGLE_SHEETS_RESULTS_SHEET` is optional. It is the tab where Railway writes submitted surveys. Default: `Лист1`.

Railway writes one submitted survey per row. Base columns are created automatically:

```text
ID анкеты
Дата отправки
Сотрудник
Руководитель
Магазин/ТТ
Статус
```

Survey questions are added automatically as extra columns.

`GOOGLE_DRIVE_FOLDER_ID` is the folder id from the Drive URL:

```text
https://drive.google.com/drive/folders/FOLDER_ID_HERE
```

After deploy/restart, open:

```text
https://mappingsurvey.up.railway.app/debug/oauth/start
```

Approve access with the Google account that owns the Drive folder. The callback page will show a refresh token.

Important: the OAuth flow now requests both Drive and Sheets access. If you previously created `GOOGLE_OAUTH_REFRESH_TOKEN` before direct Sheets submit was added, open `/debug/oauth/start` again and replace the refresh token in Railway.

Add it to Railway:

```text
GOOGLE_OAUTH_REFRESH_TOKEN=...
```

Redeploy/restart the service.

### Checks after deploy

Open:

```text
https://mappingsurvey.up.railway.app/debug/version
```

Expected:

```json
{
  "spreadsheetConfigured": true,
  "driveFolderConfigured": true,
  "googleOauthClientConfigured": true,
  "googleOauthRefreshTokenConfigured": true,
  "driveAuthMode": "oauth"
}
```

Then open:

```text
https://mappingsurvey.up.railway.app/debug/drive
```

Expected:

```json
{
  "ok": true,
  "folder": {
    "id": "...",
    "name": "..."
  }
}
```

Then open:

```text
https://mappingsurvey.up.railway.app/debug/sheets
```

Expected:

```json
{
  "ok": true,
  "spreadsheet": {
    "spreadsheetId": "...",
    "properties": {
      "title": "..."
    }
  }
}
```

## Service account mode

This mode is useful for Google Workspace Shared Drives, not for a normal personal "My Drive" folder.

Variables:

```text
GOOGLE_DRIVE_FOLDER_ID=...
GOOGLE_SERVICE_ACCOUNT_JSON=...
```

The service account JSON can be pasted as full JSON. If Railway has trouble with multiline values, base64-encode the whole JSON and paste the base64 string instead.
