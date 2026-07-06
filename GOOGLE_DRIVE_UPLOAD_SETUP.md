# Google Drive direct photo upload

Railway now uploads survey photos directly to Google Drive API instead of sending them through Apps Script.

## Google setup

1. Open Google Cloud Console.
2. Create or select a project.
3. Enable **Google Drive API**.
4. Create a **Service Account**.
5. Create a JSON key for this service account.
6. Open the target Google Drive folder for survey photos.
7. Share this folder with the service account email as **Editor**.

The service account email looks like:

```text
name@project-id.iam.gserviceaccount.com
```

## Railway variables

Add these variables to the Railway service:

```text
GOOGLE_DRIVE_FOLDER_ID=...
GOOGLE_SERVICE_ACCOUNT_JSON=...
```

`GOOGLE_DRIVE_FOLDER_ID` is the folder id from the Drive URL:

```text
https://drive.google.com/drive/folders/FOLDER_ID_HERE
```

`GOOGLE_SERVICE_ACCOUNT_JSON` can be pasted as the full JSON key content. If Railway has trouble with multiline values, base64-encode the whole JSON and paste the base64 string instead.

Keep the existing variable:

```text
APPS_SCRIPT_URL=...
```

Apps Script is still used for form config, references, and writing the final response to Google Sheets.

## Checks after deploy

Open:

```text
https://mappingsurvey.up.railway.app/debug/version
```

Expected:

```json
{
  "driveFolderConfigured": true,
  "driveServiceAccountConfigured": true
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

If `/debug/drive` fails, usually the folder was not shared with the service account email or the folder id is wrong.
