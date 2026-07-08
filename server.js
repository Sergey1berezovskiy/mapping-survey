import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const port = process.env.PORT || 3000;
const scriptUrl = process.env.APPS_SCRIPT_URL;
const spreadsheetId = extractSpreadsheetId(
  process.env.GOOGLE_SHEETS_RESULTS_SPREADSHEET_ID
    || process.env.GOOGLE_SHEETS_RESULTS_URL
    || process.env.GOOGLE_SHEETS_SPREADSHEET_ID
    || process.env.GOOGLE_SHEETS_URL
    || ''
);
const resultsSheetName = process.env.GOOGLE_SHEETS_RESULTS_SHEET || process.env.GOOGLE_SHEETS_SHEET_NAME || 'Лист1';
const driveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || process.env.DRIVE_FOLDER_ID || '';
const driveServiceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.DRIVE_SERVICE_ACCOUNT_JSON || '';
const googleOauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const googleOauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const googleOauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '';
const jsonLimitBytes = Number(process.env.JSON_LIMIT_BYTES || 200 * 1024 * 1024);
const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
const serviceVersion = 'railway-survey-2026-07-08-fast-references';
const cacheTtlMs = Number(process.env.API_CACHE_TTL_MS || 5 * 60 * 1000);
const apiCache = new Map();
const apiCacheInflight = new Map();
let driveAccessToken = null;

const RESULT_BASE_HEADERS = [
  'ID анкеты',
  'Дата отправки',
  'Сотрудник',
  'Руководитель',
  'Магазин/ТТ',
  'RMS Store Code',
  'Канал',
  'Channel',
  'Адрес',
  'Статус',
];

const RESULT_SKIPPED_QUESTION_CODES = new Set([
  'employee_full_name',
  'manager_full_name',
  'store_network_address',
]);

const RESULT_SKIPPED_ANSWER_HEADERS = new Set([
  'Сотрудник',
  'Руководитель',
  'Магазин',
  'Магазин/ТТ',
  'Канал',
  'Channel',
  'RMS Store Code',
  'Адрес',
]);

const GOOGLE_API_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
].join(' ');

const mimeByExt = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, version: serviceVersion });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/debug/version') {
      sendJson(res, 200, {
        ok: true,
        version: serviceVersion,
        scriptUrlConfigured: Boolean(scriptUrl),
        spreadsheetConfigured: Boolean(spreadsheetId),
        resultsSheetName,
        driveFolderConfigured: Boolean(driveFolderId),
        driveServiceAccountConfigured: Boolean(driveServiceAccountJson),
        googleOauthClientConfigured: Boolean(googleOauthClientId && googleOauthClientSecret),
        googleOauthRefreshTokenConfigured: Boolean(googleOauthRefreshToken),
        driveAuthMode: getDriveAuthMode(),
        formConfigCache: getApiCacheDebug('getFormConfig'),
        referencesCache: getApiCacheDebug('getReferences'),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/debug/apps-script') {
      await handleAppsScriptDebug(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/debug/drive') {
      await handleDriveDebug(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/debug/sheets') {
      await handleSheetsDebug(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/debug/oauth/start') {
      handleOauthStart(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/debug/oauth/callback') {
      await handleOauthCallback(req, res, url);
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      await handleApi(req, res, decodeURIComponent(url.pathname.slice('/api/'.length)));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url.pathname);
      return;
    }

    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
});

async function handleApi(req, res, action) {
  const params = await readJsonBody(req);

  if (action === 'uploadQuestionFiles') {
    const result = await uploadQuestionFilesToDrive(params);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (action === 'deleteQuestionFile') {
    const result = await deleteQuestionFileFromDrive(params);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (action === 'submitSurvey' && spreadsheetId) {
    const result = await submitSurveyToSheets(params && params.payload);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  if (!scriptUrl) {
    sendJson(res, 500, {
      ok: false,
      error: 'APPS_SCRIPT_URL is not configured on Railway.',
    });
    return;
  }

  if (action === 'clearConfigCache') {
    apiCache.clear();
  }

  const payload = await callAppsScriptCached(action, params);
  sendJson(res, 200, { ok: true, result: payload.result });
}

async function uploadQuestionFilesToDrive(params) {
  if (!driveFolderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is not configured on Railway.');
  }

  const files = Array.isArray(params && params.files) ? params.files : [];
  if (!files.length) return [];
  const store = params && params.store ? params.store : {};
  const rmsStoreCode = String(store.rmsStoreCode || store.rms || store['RMS Store Code'] || '').trim();

  const uploaded = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index] || {};
    if (!isAllowedImageUpload(file)) {
      throw new Error('Only image files can be uploaded.');
    }

    const buffer = dataUrlToBuffer(file.data);
    let requestedName = file.driveName || file.name || `photo_${index + 1}.jpg`;
    if (rmsStoreCode && !String(requestedName).startsWith(`${rmsStoreCode}_`)) {
      requestedName = `${rmsStoreCode}_${requestedName}`;
    }
    const safeName = sanitizeFileName(requestedName);

    const driveFile = await createDriveFile({
      name: safeName,
      mimeType: normalizeImageMimeType(file.mimeType),
      buffer,
    });

    uploaded.push({
      id: driveFile.id,
      url: driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`,
      name: file.name || safeName,
      driveName: driveFile.name || safeName,
      size: buffer.length,
    });
  }

  return uploaded;
}

async function deleteQuestionFileFromDrive(params) {
  const fileId = String(params && params.fileId ? params.fileId : '').trim();
  if (!fileId) throw new Error('fileId is required.');

  const token = await getDriveAccessToken();
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(`Google Drive delete failed: ${response.status} ${text.slice(0, 300)}`);
  }

  return true;
}

async function createDriveFile({ name, mimeType, buffer }) {
  const token = await getDriveAccessToken();
  const boundary = `mapping_survey_${crypto.randomUUID()}`;
  const metadata = JSON.stringify({
    name,
    parents: [driveFolderId],
  });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Google Drive upload returned non-JSON response: ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(payload.error && payload.error.message ? payload.error.message : `Google Drive upload failed: ${response.status}`);
  }

  return payload;
}

async function getDriveAccessToken() {
  if (driveAccessToken && driveAccessToken.expiresAt > Date.now() + 60000) {
    return driveAccessToken.token;
  }

  if (googleOauthRefreshToken) {
    return getDriveAccessTokenByRefreshToken();
  }

  return getDriveAccessTokenByServiceAccount();
}

async function getDriveAccessTokenByRefreshToken() {
  if (!googleOauthClientId || !googleOauthClientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required when GOOGLE_OAUTH_REFRESH_TOKEN is configured.');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: googleOauthClientId,
      client_secret: googleOauthClientSecret,
      refresh_token: googleOauthRefreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !payload.access_token) {
    throw new Error(payload && payload.error_description ? payload.error_description : 'Google OAuth refresh token auth failed.');
  }

  driveAccessToken = {
    token: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
  return driveAccessToken.token;
}

async function getDriveAccessTokenByServiceAccount() {
  const account = parseServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const claim = base64UrlJson({
    iss: account.client_email,
    scope: GOOGLE_API_SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  });
  const unsigned = `${header}.${claim}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsigned)
    .sign(account.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !payload.access_token) {
    throw new Error(payload && payload.error_description ? payload.error_description : 'Google Drive auth failed.');
  }

  driveAccessToken = {
    token: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
  return driveAccessToken.token;
}

function getDriveAuthMode() {
  if (googleOauthRefreshToken) return 'oauth';
  if (driveServiceAccountJson) return 'service_account';
  return 'not_configured';
}

function getRequestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function getOauthRedirectUri(req) {
  return `${getRequestOrigin(req)}/debug/oauth/callback`;
}

function handleOauthStart(req, res) {
  if (!googleOauthClientId) {
    sendText(res, 500, 'GOOGLE_OAUTH_CLIENT_ID is not configured on Railway.');
    return;
  }

  const params = new URLSearchParams({
    client_id: googleOauthClientId,
    redirect_uri: getOauthRedirectUri(req),
    response_type: 'code',
    scope: GOOGLE_API_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });

  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  });
  res.end();
}

async function handleOauthCallback(req, res, url) {
  if (!googleOauthClientId || !googleOauthClientSecret) {
    sendText(res, 500, 'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are not configured on Railway.');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) {
    sendText(res, 400, `Google OAuth error: ${error}`);
    return;
  }
  if (!code) {
    sendText(res, 400, 'OAuth code is missing.');
    return;
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: googleOauthClientId,
      client_secret: googleOauthClientSecret,
      redirect_uri: getOauthRedirectUri(req),
      grant_type: 'authorization_code',
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    sendText(res, 500, `Token exchange failed: ${JSON.stringify(payload)}`);
    return;
  }

  if (!payload.refresh_token) {
    sendText(res, 500, 'Google did not return refresh_token. Open /debug/oauth/start again or remove previous app access in Google Account -> Security -> Third-party access, then retry.');
    return;
  }

  const escaped = escapeHtml(payload.refresh_token);
  sendHtml(res, 200, `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Google OAuth token</title></head>
<body style="font-family: Arial, sans-serif; padding: 24px; line-height: 1.45;">
  <h1>Refresh token получен</h1>
  <p>Добавь в Railway переменную <strong>GOOGLE_OAUTH_REFRESH_TOKEN</strong> со значением ниже, затем сделай redeploy/restart.</p>
  <textarea readonly style="width: 100%; min-height: 160px;">${escaped}</textarea>
  <p>После этого проверь <code>/debug/version</code> и <code>/debug/drive</code>.</p>
</body>
</html>`);
}

function parseServiceAccount() {
  if (!driveServiceAccountJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured on Railway.');
  }

  try {
    const normalized = driveServiceAccountJson.trim().startsWith('{')
      ? driveServiceAccountJson
      : Buffer.from(driveServiceAccountJson, 'base64').toString('utf8');
    const account = JSON.parse(normalized);
    if (!account.client_email || !account.private_key) {
      throw new Error('client_email/private_key are missing.');
    }
    return account;
  } catch (error) {
    throw new Error(`Invalid GOOGLE_SERVICE_ACCOUNT_JSON: ${error.message}`);
  }
}

function dataUrlToBuffer(data) {
  const text = String(data || '');
  const base64 = text.includes(',') ? text.split(',').pop() : text;
  if (!base64) throw new Error('File data is empty.');
  return Buffer.from(base64, 'base64');
}

function isAllowedImageUpload(file) {
  const mimeType = String(file && file.mimeType ? file.mimeType : '').toLowerCase();
  const data = String(file && file.data ? file.data : '').toLowerCase();
  const name = String(file && file.name ? file.name : '').toLowerCase();

  return mimeType.startsWith('image/')
    && data.startsWith('data:image/')
    && /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(name);
}

function normalizeImageMimeType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  return normalized.startsWith('image/') ? normalized : 'image/jpeg';
}

function base64UrlJson(value) {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function sanitizeFileName(name) {
  return String(name || 'upload')
    .replace(/[\\/:*?"<>|#%{}~&]/g, '_')
    .slice(0, 180);
}

function extractSpreadsheetId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];

  return raw;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function handleAppsScriptDebug(res) {
  if (!scriptUrl) {
    sendJson(res, 500, {
      ok: false,
      scriptUrlConfigured: false,
      error: 'APPS_SCRIPT_URL is not configured on Railway.',
    });
    return;
  }

  try {
    const payload = await callAppsScript('testDeploymentReady', {});
    sendJson(res, 200, {
      ok: true,
      scriptUrlConfigured: true,
      result: payload.result,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      scriptUrlConfigured: true,
      error: error && error.message ? error.message : String(error),
    });
  }
}

async function handleDriveDebug(res) {
  try {
    const token = await getDriveAccessToken();
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFolderId)}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload && payload.error && payload.error.message ? payload.error.message : `Google Drive folder check failed: ${response.status}`);
    }

    sendJson(res, 200, {
      ok: true,
      folder: payload,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
}

async function handleSheetsDebug(res) {
  try {
    if (!spreadsheetId) {
      throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID or GOOGLE_SHEETS_URL is not configured on Railway.');
    }

    const token = await getDriveAccessToken();
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties.title,sheets.properties.title`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload && payload.error && payload.error.message ? payload.error.message : `Google Sheets check failed: ${response.status}`);
    }

    sendJson(res, 200, {
      ok: true,
      resultsSheetName,
      spreadsheet: payload,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
}

async function submitSurveyToSheets(payload) {
  const now = formatMoscowDateTime();
  const meta = payload && payload.meta ? payload.meta : {};
  const surveyId = String((payload && payload.surveyId) || meta.surveyId || crypto.randomUUID()).trim();
  const answers = payload && Array.isArray(payload.answers) ? payload.answers : [];

  const row = {
    'ID анкеты': surveyId,
    'Сотрудник': meta.employee || '',
    'Руководитель': meta.manager || '',
    'Магазин/ТТ': meta.store || '',
    'RMS Store Code': meta.rmsStoreCode || '',
    'Канал': meta.channel || '',
    'Channel': meta.storeChannel || '',
    'Адрес': meta.address || '',
    'Дата отправки': now,
    'Статус': 'Отправлено',
  };

  for (const answer of answers) {
    if (RESULT_SKIPPED_QUESTION_CODES.has(String(answer && answer.questionCode || ''))) continue;
    const header = getResultAnswerHeader(answer);
    if (!header) continue;
    if (RESULT_SKIPPED_ANSWER_HEADERS.has(header)) continue;
    row[header] = getResultAnswerValue(answer);
  }

  const appendResult = await appendResultRow(row);

  return {
    ok: true,
    surveyId,
    duplicate: Boolean(appendResult && appendResult.duplicate),
    mode: 'sheets_api_single_sheet',
  };
}

function formatMoscowDateTime(date = new Date()) {
  const moscowOffsetMs = 3 * 60 * 60 * 1000;
  const moscowDate = new Date(date.getTime() + moscowOffsetMs);
  const day = padDatePart(moscowDate.getUTCDate());
  const month = padDatePart(moscowDate.getUTCMonth() + 1);
  const year = moscowDate.getUTCFullYear();
  const hours = padDatePart(moscowDate.getUTCHours());
  const minutes = padDatePart(moscowDate.getUTCMinutes());
  const seconds = padDatePart(moscowDate.getUTCSeconds());
  return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
}

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

async function appendResultRow(row) {
  await ensureResultsSheet();

  const existingHeaders = await getSheetHeaders(resultsSheetName, true);
  const existingRowNumber = await findExistingResultRowById(row[RESULT_BASE_HEADERS[0]], existingHeaders);
  if (existingRowNumber) {
    return { rowNumber: existingRowNumber, duplicate: true };
  }

  const desiredHeaders = mergeHeaders([], Object.keys(row));
  const hasDataRows = await hasResultDataRows(resultsSheetName);
  const nextHeaders = await ensureHeadersInDesiredOrder(resultsSheetName, hasDataRows ? existingHeaders : [], desiredHeaders);

  const appendPayload = await appendSheetValues(resultsSheetName, [nextHeaders.map((header) => getCellTextValue(row[header]))]);
  const rowNumber = getAppendedRowNumber(appendPayload);
  if (rowNumber) {
    try {
      await applyRichLinksToResultRow(resultsSheetName, rowNumber, nextHeaders, row);
    } catch (error) {
      console.error('[submitSurvey] Rich link formatting failed after row append:', error && error.message ? error.message : error);
    }
  }

  return { rowNumber, duplicate: false };
}

async function findExistingResultRowById(surveyId, headers) {
  const id = String(surveyId || '').trim();
  if (!id || !Array.isArray(headers) || !headers.length) return null;

  const idHeaderIndex = headers.findIndex((header) => String(header || '').trim() === RESULT_BASE_HEADERS[0]);
  if (idHeaderIndex < 0) return null;

  const column = columnIndexToLetter(idHeaderIndex);
  const token = await getDriveAccessToken();
  const range = `${quoteSheetName(resultsSheetName)}!${column}:${column}`;
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=COLUMNS`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload && payload.error && payload.error.message ? payload.error.message : `Google Sheets id lookup failed: ${response.status}`);
  }

  const values = payload && Array.isArray(payload.values) && Array.isArray(payload.values[0]) ? payload.values[0] : [];
  const foundIndex = values.findIndex((value, index) => index > 0 && String(value || '').trim() === id);
  return foundIndex >= 0 ? foundIndex + 1 : null;
}

function columnIndexToLetter(index) {
  let value = Number(index) + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

async function getSheetHeaders(sheetName, force = false) {
  const cacheKey = getSheetHeadersCacheKey(sheetName);
  const cached = apiCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.savedAt < cacheTtlMs) {
    return cached.payload;
  }

  const token = await getDriveAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(quoteSheetName(sheetName) + '!A1:ZZZ1')}?majorDimension=ROWS`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload && payload.error && payload.error.message ? payload.error.message : `Google Sheets headers read failed: ${response.status}`);
  }

  const headers = payload && Array.isArray(payload.values) && Array.isArray(payload.values[0])
    ? payload.values[0].map((header) => String(header || '').trim())
    : [];
  apiCache.set(cacheKey, { savedAt: Date.now(), payload: headers });
  return headers;
}

async function hasResultDataRows(sheetName) {
  const token = await getDriveAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(quoteSheetName(sheetName) + '!A2:A2')}?majorDimension=ROWS`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload && payload.error && payload.error.message ? payload.error.message : `Google Sheets data row check failed: ${response.status}`);
  }

  return Boolean(payload && Array.isArray(payload.values) && payload.values.length);
}

function getSheetHeadersCacheKey(sheetName) {
  return `sheetHeaders:${sheetName}`;
}

async function ensureResultsSheet() {
  const spreadsheet = await getSpreadsheetStructure();
  const sheetExists = (spreadsheet.sheets || []).some((sheet) => sheet.properties && sheet.properties.title === resultsSheetName);
  if (!sheetExists) {
    await batchUpdateSpreadsheet([{
      addSheet: {
        properties: {
          title: resultsSheetName,
        },
      },
    }]);
    apiCache.delete('spreadsheetStructure');
  }

  const headers = await getSheetHeaders(resultsSheetName, true).catch(() => []);
  if (!headers.length) {
    await writeSheetHeaders(resultsSheetName, RESULT_BASE_HEADERS);
    apiCache.set(getSheetHeadersCacheKey(resultsSheetName), { savedAt: Date.now(), payload: RESULT_BASE_HEADERS });
  }
}

async function getSpreadsheetStructure() {
  const cached = apiCache.get('spreadsheetStructure');
  if (cached && Date.now() - cached.savedAt < cacheTtlMs) {
    return cached.payload;
  }

  const token = await getDriveAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties.title,sheets.properties(sheetId,title)`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload && payload.error && payload.error.message ? payload.error.message : `Google Sheets structure read failed: ${response.status}`);
  }

  apiCache.set('spreadsheetStructure', { savedAt: Date.now(), payload });
  return payload;
}

async function writeSheetHeaders(sheetName, headers) {
  const token = await getDriveAccessToken();
  const range = `${quoteSheetName(sheetName)}!A1`;
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      majorDimension: 'ROWS',
      values: [headers],
    }),
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload && payload.error && payload.error.message ? payload.error.message : `Google Sheets headers write failed: ${response.status}`);
  }
}

async function batchUpdateSpreadsheet(requests) {
  const token = await getDriveAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload && payload.error && payload.error.message ? payload.error.message : `Google Sheets batch update failed: ${response.status}`);
  }
}

function mergeHeaders(existingHeaders, rowHeaders) {
  const merged = existingHeaders.length ? [...existingHeaders] : [...RESULT_BASE_HEADERS];
  for (const header of rowHeaders) {
    if (header && !merged.includes(header)) merged.push(header);
  }
  return merged;
}

async function ensureHeadersInDesiredOrder(sheetName, existingHeaders, desiredHeaders) {
  if (!existingHeaders.length) {
    await writeSheetHeaders(sheetName, desiredHeaders);
    apiCache.set(getSheetHeadersCacheKey(sheetName), { savedAt: Date.now(), payload: desiredHeaders });
    return desiredHeaders;
  }

  const headers = [...existingHeaders];
  const missingHeaders = desiredHeaders.filter((header) => header && !headers.includes(header));

  if (!missingHeaders.length) {
    return headers;
  }

  const sheetId = await getSheetIdByName(sheetName);
  const requests = [];

  for (const header of missingHeaders) {
    const insertIndex = findHeaderInsertIndex(headers, desiredHeaders, header);
    requests.push({
      insertDimension: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: insertIndex,
          endIndex: insertIndex + 1,
        },
        inheritFromBefore: insertIndex > 0,
      },
    });
    headers.splice(insertIndex, 0, header);
  }

  await batchUpdateSpreadsheet(requests);
  await writeSheetHeaders(sheetName, headers);
  apiCache.set(getSheetHeadersCacheKey(sheetName), { savedAt: Date.now(), payload: headers });
  return headers;
}

function findHeaderInsertIndex(currentHeaders, desiredHeaders, header) {
  const desiredIndex = desiredHeaders.indexOf(header);
  for (let index = 0; index < currentHeaders.length; index += 1) {
    const currentDesiredIndex = desiredHeaders.indexOf(currentHeaders[index]);
    if (currentDesiredIndex > desiredIndex) {
      return index;
    }
  }
  return currentHeaders.length;
}

function getResultAnswerHeader(answer) {
  return String(answer && (answer.questionText || answer.questionCode) || '').trim();
}

function getResultAnswerValue(answer) {
  if (!answer) return '';
  if (answer.files) {
    if (Array.isArray(answer.files)) {
      const files = answer.files
        .map(normalizeSubmittedFile)
        .filter((file) => file.url);
      return files.length ? buildRichLinkCell(files) : '';
    }
    const files = String(answer.files)
      .split(/\n+/)
      .map((url, index) => ({ url: url.trim(), name: `Фото ${index + 1}` }))
      .filter((file) => file.url);
    return files.length ? buildRichLinkCell(files) : answer.files;
  }
  if (Array.isArray(answer.selectedOptions)) {
    return answer.selectedOptions.join('; ');
  }
  return answer.value || answer.selectedOptions || '';
}

function normalizeSubmittedFile(file) {
  if (typeof file === 'string') {
    return { url: file, name: file };
  }
  return {
    url: file && (file.url || file.webViewLink) || '',
    name: file && (file.linkName || file.driveName || file.name) || 'Фото',
  };
}

function buildRichLinkCell(files) {
  const links = [];
  let cursor = 0;
  const text = files.map((file) => String(file.name || 'Фото')).join('\n');

  for (const file of files) {
    const label = String(file.name || 'Фото');
    links.push({
      startIndex: cursor,
      endIndex: cursor + label.length,
      url: file.url,
    });
    cursor += label.length + 1;
  }

  return { text, richLinks: links };
}

function getCellTextValue(value) {
  if (value && typeof value === 'object' && Array.isArray(value.richLinks)) {
    return value.text || '';
  }
  return value ?? '';
}

function getAppendedRowNumber(payload) {
  const updatedRange = payload && payload.updates && payload.updates.updatedRange;
  const match = String(updatedRange || '').match(/![A-Z]+(\d+)(?::[A-Z]+\d+)?$/i);
  return match ? Number(match[1]) : null;
}

async function applyRichLinksToResultRow(sheetName, rowNumber, headers, row) {
  const richCellRequests = [];
  const sheetId = await getSheetIdByName(sheetName);

  headers.forEach((header, columnIndex) => {
    const value = row[header];
    if (!value || typeof value !== 'object' || !Array.isArray(value.richLinks) || !value.richLinks.length) {
      return;
    }

    richCellRequests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowNumber - 1,
          endRowIndex: rowNumber,
          startColumnIndex: columnIndex,
          endColumnIndex: columnIndex + 1,
        },
        cell: {
          userEnteredValue: {
            stringValue: value.text || '',
          },
          textFormatRuns: buildTextFormatRuns(value.text || '', value.richLinks),
          userEnteredFormat: {
            wrapStrategy: 'WRAP',
          },
        },
        fields: 'userEnteredValue,textFormatRuns,userEnteredFormat.wrapStrategy',
      },
    });
  });

  if (richCellRequests.length) {
    await batchUpdateSpreadsheet(richCellRequests);
  }
}

async function getSheetIdByName(sheetName) {
  const spreadsheet = await getSpreadsheetStructure();
  const sheet = (spreadsheet.sheets || []).find((item) => item.properties && item.properties.title === sheetName);
  if (!sheet || !sheet.properties) {
    throw new Error(`Sheet not found: ${sheetName}`);
  }
  return sheet.properties.sheetId;
}

function buildTextFormatRuns(text, links) {
  const runs = [];

  for (const link of links) {
    runs.push({
      startIndex: link.startIndex,
      format: {
        foregroundColor: { red: 0.066, green: 0.333, blue: 0.8 },
        underline: true,
        link: { uri: link.url },
      },
    });

    if (link.endIndex < text.length) {
      runs.push({
        startIndex: link.endIndex,
        format: {},
      });
    }
  }

  return runs.sort((left, right) => left.startIndex - right.startIndex);
}

async function appendSheetValues(sheetName, values) {
  const token = await getDriveAccessToken();
  const range = `${quoteSheetName(sheetName)}!A:ZZZ`;
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      majorDimension: 'ROWS',
      values,
    }),
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload && payload.error && payload.error.message ? payload.error.message : `Google Sheets append failed: ${response.status}`);
  }

  return payload;
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'`;
}

async function callAppsScriptCached(action, params) {
  const cacheableActions = new Set(['getFormConfig', 'getReferences']);
  if (!cacheableActions.has(action)) {
    return callAppsScript(action, params);
  }

  const key = `${action}:${JSON.stringify(params || {})}`;
  const cached = apiCache.get(key);
  const cacheAgeMs = cached ? Date.now() - cached.savedAt : Infinity;
  if (cached && cacheAgeMs < cacheTtlMs) {
    return cached.payload;
  }

  if (cached) {
    refreshAppsScriptCacheInBackground(action, params, key);
    return cached.payload;
  }

  if (apiCacheInflight.has(key)) {
    return apiCacheInflight.get(key);
  }

  const promise = callAppsScript(action, params)
    .then((payload) => prepareAppsScriptPayload(action, payload))
    .then((payload) => {
      apiCache.set(key, { savedAt: Date.now(), payload });
      return payload;
    })
    .finally(() => {
      apiCacheInflight.delete(key);
    });

  apiCacheInflight.set(key, promise);
  return promise;
}

function refreshAppsScriptCacheInBackground(action, params, key) {
  if (apiCacheInflight.has(key)) return;

  const promise = callAppsScript(action, params)
    .then((payload) => prepareAppsScriptPayload(action, payload))
    .then((payload) => {
      apiCache.set(key, { savedAt: Date.now(), payload });
      return payload;
    })
    .catch((error) => {
      console.warn(`Background cache refresh failed for ${action}:`, error && error.message ? error.message : error);
      return null;
    })
    .finally(() => {
      apiCacheInflight.delete(key);
    });

  apiCacheInflight.set(key, promise);
}

function getApiCacheDebug(action, params = {}) {
  const key = `${action}:${JSON.stringify(params || {})}`;
  const cached = apiCache.get(key);
  const inFlight = apiCacheInflight.has(key);
  const ttlSec = Math.round(cacheTtlMs / 1000);
  if (!cached) {
    return { cached: false, ageSec: null, ttlSec, inFlight };
  }

  const ageSec = Math.max(0, Math.round((Date.now() - cached.savedAt) / 1000));
  return {
    cached: ageSec < ttlSec,
    ageSec,
    ttlSec,
    inFlight,
  };
}

function warmAppsScriptCache() {
  if (!scriptUrl) return;
  refreshAppsScriptCacheInBackground('getFormConfig', {}, 'getFormConfig:{}');
  refreshAppsScriptCacheInBackground('getReferences', {}, 'getReferences:{}');
}

function prepareAppsScriptPayload(action, payload) {
  if (action !== 'getReferences' || !payload || !payload.result) {
    return payload;
  }

  return {
    ...payload,
    result: compactReferences(payload.result),
  };
}

function compactReferences(references) {
  if (!references || typeof references !== 'object') return references;

  const compacted = {};
  for (const [key, value] of Object.entries(references)) {
    compacted[key] = Array.isArray(value)
      ? value.map((item) => compactReferenceItem(key, item))
      : value;
  }

  return compacted;
}

function compactReferenceItem(type, item) {
  if (!item || typeof item !== 'object') return item;

  const result = pickDefined(item, [
    'id',
    'label',
    'manager',
    'extra',
    'channel',
    'storeChannel',
    'channelType',
    'rmsStoreCode',
    'rms',
    'address',
  ]);

  if (!result.label && item.search) result.label = item.search;
  if (type === 'stores' && !result.extra && (item.channel || item.address)) {
    result.extra = [item.channel, item.address].filter(Boolean).join(' - ');
  }

  return result;
}

function pickDefined(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
      result[key] = source[key];
    }
  }
  return result;
}

async function callAppsScript(action, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);

  try {
    const upstream = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, params }),
      redirect: 'follow',
      signal: controller.signal,
    });

    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      const sample = text.replace(/\s+/g, ' ').slice(0, 300);
      const looksLikeHtml = /^<!doctype html|^<html|<title>/i.test(sample);
      if (looksLikeHtml && action === 'uploadQuestionFiles') {
        throw new Error(
          'Apps Script не принял загрузку фото и вернул HTML вместо ответа. Фото будут загружаться по одному; если ошибка повторится, выберите меньше фото за раз.'
        );
      }
      if (looksLikeHtml) {
        throw new Error('Apps Script вернул страницу Google вместо данных. Проверьте доступ веб-приложения и APPS_SCRIPT_URL.');
      }
      throw new Error(
        `Apps Script returned non-JSON response. Check deployment access and APPS_SCRIPT_URL. Response: ${sample}`
      );
    }

    if (!upstream.ok || payload.ok === false) {
      throw new Error(payload.error || upstream.statusText);
    }

    return payload;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`Apps Script did not respond within ${Math.round(upstreamTimeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > jsonLimitBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON request body.'));
      }
    });

    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = path.normalize(path.join(publicDir, requested));

  if (!target.startsWith(publicDir)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const body = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': mimeByExt[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(body);
    }
  } catch {
    const index = await fs.readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(index);
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

server.listen(port, () => {
  console.log(`Mapping Survey ${serviceVersion} is running on port ${port}`);
  warmAppsScriptCache();
});
