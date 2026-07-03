const fs = require('node:fs');

const src = '../outputs/google_apps_script_Index.html';
const dest = './public/index.html';

let html = fs.readFileSync(src, 'utf8');

html = html.replace(
  "    };\n\n    function boot()",
  `    };

    async function apiCall(action, params = {}) {
      const response = await fetch('/api/' + encodeURIComponent(action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok === false) {
        throw new Error(payload && payload.error ? payload.error : 'Ошибка запроса к серверу');
      }
      return payload.result;
    }

    async function boot()`
);

html = html.replace(
  `function boot() {
      loadDraft();

      const cachedConfig = loadStoredConfig();
      if (cachedConfig) {
        state.config = cachedConfig;
        renderForm();
        els.loading.style.display = 'none';
        els.app.style.display = 'grid';
        els.status.textContent = 'Кэш';
        showSection(state.sectionIndex || 0, false);
      }

      google.script.run
        .withSuccessHandler((config) => {
          saveStoredConfig(config);
          state.config = config;
          renderForm();
          els.loading.style.display = 'none';
          els.app.style.display = 'grid';
          els.status.textContent = 'Черновик';
          showSection(state.sectionIndex || 0, false);
        })
        .withFailureHandler((error) => {
          if (cachedConfig) {
            els.status.textContent = 'Офлайн';
            return;
          }
          showError(error);
        })
        .getFormConfig();
    }`,
  `async function boot() {
      loadDraft();

      const cachedConfig = loadStoredConfig();
      if (cachedConfig) {
        state.config = cachedConfig;
        renderForm();
        els.loading.style.display = 'none';
        els.app.style.display = 'grid';
        els.status.textContent = 'Кэш';
        showSection(state.sectionIndex || 0, false);
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
      } catch (error) {
        if (cachedConfig) {
          els.status.textContent = 'Офлайн';
          return;
        }
        showError(error);
      }
    }`
);

html = html.replace(
  `google.script.run
              .withSuccessHandler((urls) => {
                state.answers[code] = existingUrls.concat(urls);
                state.fileUploads[code] = { uploading: false, uploaded: true };
                fileList.textContent = \`Загружено файлов: \${state.answers[code].length}\`;
                field.classList.remove('invalid');
                input.value = '';
                saveDraftSoon();
              })
              .withFailureHandler((error) => {
                state.answers[code] = existingUrls;
                state.fileUploads[code] = { uploading: false, uploaded: false };
                fileList.textContent = \`Ошибка загрузки: \${error && error.message ? error.message : error}\`;
                field.classList.add('invalid');
              })
              .uploadQuestionFiles(code, preparedFiles);`,
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

html = html.replace(
  `state.searchTimers[code] = setTimeout(() => {
        google.script.run
          .withSuccessHandler((items) => renderSuggestions(field, items))
          .withFailureHandler(showError)
          .searchReference(type, query);
      }, 220);`,
  `state.searchTimers[code] = setTimeout(async () => {
        try {
          const items = await apiCall('searchReference', { type, query });
          renderSuggestions(field, items);
        } catch (error) {
          showError(error);
        }
      }, 220);`
);

html = html.replace('function submit() {', 'async function submit() {');

html = html.replace(
  `google.script.run
        .withSuccessHandler((result) => {
          els.app.style.display = 'none';
          els.done.innerHTML = \`
            <div>Ответ сохранен. ID анкеты: \${escapeHtml(result.surveyId)}</div>
            <button type="button" id="newSurveyDoneBtn">Заполнить новый опросник</button>
          \`;
          els.done.style.display = 'block';
          els.status.textContent = 'Готово';
          resetDraftState();
          document.querySelector('#newSurveyDoneBtn').addEventListener('click', startNewSurvey);
        })
        .withFailureHandler((error) => {
          els.nextBtn.disabled = false;
          els.nextBtn.textContent = 'Отправить';
          showError(error);
        })
        .submitSurvey({ meta, answers });`,
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
