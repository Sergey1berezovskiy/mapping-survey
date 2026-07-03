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
      const timeoutMs = action === 'submitSurvey' || action === 'uploadQuestionFiles' ? 120000 : 25000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
          throw new Error('Сервер не ответил за ' + Math.round(timeoutMs / 1000) + ' секунд. Проверьте Railway Variables и Apps Script deployment.');
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

html = html
  .replace(
    'const description = getSectionDescription(section);',
    'const title = getSectionTitle(section);\n        const description = getSectionDescription(section);'
  )
  .replace(
    '<h2>${escapeHtml(section.title)}</h2>',
    '<h2>${escapeHtml(title)}</h2>'
  )
  .replace(
    "    function getSectionDescription(section) {\n      if (section.code === 'general') return '';",
    `    function getSectionTitle(section) {
      if (section.title === 'Промоутеры и BA') return 'Промоутеры и BA конкурентов';
      if (section.title === 'Фото и проблемные ТТ') return 'Фото BZ';
      return section.title;
    }

    function getSectionDescription(section) {
      if (section.code === 'general') return '';
      if (section.title === 'Фото и проблемные ТТ') return '';`
  )
  .replace(
    /<div class="file-actions">\s*<label class="file-action primary-file">[\s\S]*?<input data-file-input="\$\{escapeHtml\(question\.code\)\}" type="file" accept="image\/\*" multiple>\s*<\/label>\s*<\/div>/,
    `<div class="file-actions">
                <label class="file-action primary-file">
                  Сделать/Загрузить Фото
                  <input data-file-input="\${escapeHtml(question.code)}" type="file" accept="image/*" multiple>
                </label>
              </div>`
  )
  .replace(
    'grid-template-columns: 1fr 1fr;',
    'grid-template-columns: 1fr;'
  )
  .replace(
    "      const managerItem = findReferenceByLabel('managers', manager) || {\n        id: manager,\n        label: manager,\n        extra: '',\n      };",
    `      const managerItem = findReferenceByLabel('managers', manager) || findReferenceByTokens('managers', manager) || {
        id: manager,
        label: manager,
        extra: '',
        fromEmployeeReference: true,
      };`
  )
  .replace(
    "        extra: managerItem.extra || '',\n      };",
    `        extra: managerItem.extra || '',
        fromEmployeeReference: Boolean(managerItem.fromEmployeeReference),
      };`
  )
  .replace(
    "      selectedRef.textContent = managerItem.extra || '';\n      selectedRef.classList.toggle('show', Boolean(managerItem.extra));",
    `      selectedRef.textContent = '';
      selectedRef.classList.remove('show');`
  )
  .replace(
    "    function showSection(index, shouldSave = true) {",
    `    function findReferenceByTokens(type, label) {
      const tokens = normalizeSearchText(label).split(' ').filter((token) => token.length >= 2);
      if (!tokens.length) return null;

      const items = state.references && Array.isArray(state.references[type])
        ? state.references[type]
        : [];

      return items.find((item) => {
        const haystack = item.normalizedSearch || normalizeSearchText([item.label, item.search, item.extra].filter(Boolean).join(' '));
        return tokens.every((token) => haystack.includes(token));
      }) || null;
    }

    function showSection(index, shouldSave = true) {`
  )
  .replace(
    "          if (field.dataset.reference === 'stores') {\n            updateStoreDetails(field, selected || {});\n            return;\n          }",
    `          if (field.dataset.reference === 'employees') {
            selectedRef.textContent = '';
            selectedRef.classList.remove('show');
            return;
          }
          if (field.dataset.reference === 'stores') {
            updateStoreDetails(field, selected || {});
            return;
          }`
  );

if (html.includes('google.script.run')) {
  throw new Error('google.script.run still present in Railway HTML.');
}

fs.mkdirSync('./public', { recursive: true });
fs.writeFileSync(dest, html, 'utf8');
console.log(`Wrote ${dest}`);
