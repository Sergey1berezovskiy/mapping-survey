const fs = require('node:fs');

const src = '../outputs/google_apps_script_Index.html';
const dest = './public/index.html';

let html = fs.readFileSync(src, 'utf8');

function replaceRange(source, startNeedle, endNeedle, replacement) {
  const start = source.indexOf(startNeedle);
  if (start === -1) throw new Error(`Start marker not found: ${startNeedle}`);

  const end = source.indexOf(endNeedle, start);
  if (end === -1) throw new Error(`End marker not found: ${endNeedle}`);

  return source.slice(0, start) + replacement + source.slice(end);
}

function replaceUntilAfter(source, startNeedle, endNeedle, replacement) {
  const start = source.indexOf(startNeedle);
  if (start === -1) throw new Error(`Start marker not found: ${startNeedle}`);

  const end = source.indexOf(endNeedle, start);
  if (end === -1) throw new Error(`End marker not found: ${endNeedle}`);

  return source.slice(0, start) + replacement + source.slice(end + endNeedle.length);
}

html = html.replace(
  "    };\n\n    function boot()",
  `    };

    async function apiCall(action, params = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      let response;
      try {
        response = await fetch('/api/' + encodeURIComponent(action), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: controller.signal,
        });
      } catch (error) {
        if (error && error.name === 'AbortError') {
          throw new Error('Сервер не ответил за 25 секунд. Проверьте Railway Variables и Apps Script deployment.');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok === false) {
        throw new Error(payload && payload.error ? payload.error : 'Ошибка запроса к серверу');
      }
      return payload.result;
    }

    function boot()`
);

html = replaceRange(
  html,
  'function boot() {',
  'function renderForm() {',
  `async function boot() {
      loadDraft();
      state.references = loadStoredReferences() || {};

      const cachedConfig = loadStoredConfig();
      if (cachedConfig) {
        state.config = cachedConfig;
        renderForm();
        els.loading.style.display = 'none';
        els.app.style.display = 'grid';
        els.status.textContent = 'Кэш';
        showSection(state.sectionIndex || 0, false);
        refreshReferences();
      }

      try {
        const config = await apiCall('getFormConfig');
        saveStoredConfig(config);
        state.config = config;
        renderForm();
        els.loading.style.display = 'none';
        els.app.style.display = 'grid';
        els.status.textContent = 'Черновик';
        showSection(state.sectionIndex || 0, false);
        refreshReferences();
      } catch (error) {
        if (cachedConfig) {
          els.status.textContent = 'Офлайн';
          return;
        }
        showError(error);
      }
    }

    `
);

html = replaceUntilAfter(
  html,
  'google.script.run\n              .withSuccessHandler((urls)',
  '              .uploadQuestionFiles(code, preparedFiles);',
  `try {
              const urls = await apiCall('uploadQuestionFiles', { questionCode: code, files: preparedFiles });
              state.answers[code] = existingUrls.concat(urls);
              state.fileUploads[code] = { uploading: false, uploaded: true };
              fileList.textContent = \`Загружено файлов: \${state.answers[code].length}\`;
              field.classList.remove('invalid');
              input.value = '';
              saveDraftSoon();
            } catch (error) {
              state.answers[code] = existingUrls;
              state.fileUploads[code] = { uploading: false, uploaded: false };
              fileList.textContent = \`Ошибка загрузки: \${error && error.message ? error.message : error}\`;
              field.classList.add('invalid');
            }`
);

html = replaceRange(
  html,
  'function queueReferenceSearch(field, query) {',
  'function searchLocalReferences(type, query) {',
  `function queueReferenceSearch(field, query) {
      const code = field.dataset.code;
      const type = field.dataset.reference;
      const box = field.querySelector('.suggestions');

      clearTimeout(state.searchTimers[code]);
      if (query.length < 2) {
        box.classList.remove('open');
        box.innerHTML = '';
        return;
      }

      state.searchTimers[code] = setTimeout(async () => {
        const localItems = searchLocalReferences(type, query);
        if (localItems) {
          renderSuggestions(field, localItems);
          return;
        }

        try {
          const items = await apiCall('searchReference', { type, query });
          renderSuggestions(field, items);
        } catch (error) {
          showError(error);
        }
      }, 120);
    }

    `
);

html = replaceRange(
  html,
  'function refreshReferences() {',
  'function loadStoredReferences() {',
  `async function refreshReferences() {
      try {
        const references = await apiCall('getReferences');
        state.references = references || {};
        saveStoredReferences(state.references);
      } catch (error) {}
    }

    `
);

html = html.replace('function submit() {', 'async function submit() {');

html = replaceUntilAfter(
  html,
  'google.script.run\n        .withSuccessHandler((result)',
  '        .submitSurvey({ meta, answers });',
  `try {
        const result = await apiCall('submitSurvey', { payload: { meta, answers } });
        els.app.style.display = 'none';
        els.done.innerHTML = \`
          <div>Ответ сохранен. ID анкеты: \${escapeHtml(result.surveyId)}</div>
          <button type="button" id="newSurveyDoneBtn">Заполнить новый опросник</button>
        \`;
        els.done.style.display = 'block';
        els.status.textContent = 'Готово';
        resetDraftState();
        document.querySelector('#newSurveyDoneBtn').addEventListener('click', startNewSurvey);
      } catch (error) {
        els.nextBtn.disabled = false;
        els.nextBtn.textContent = 'Отправить';
        showError(error);
      }`
);

if (html.includes('google.script.run')) {
  throw new Error('google.script.run still present in Railway HTML.');
}

fs.mkdirSync('./public', { recursive: true });
fs.writeFileSync(dest, html, 'utf8');
console.log(`Wrote ${dest}`);
