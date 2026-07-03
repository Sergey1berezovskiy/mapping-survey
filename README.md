# Mapping Survey on Railway

## Что это

Railway быстро отдает страницу формы, а серверный маршрут `/api/:action` проксирует запросы в опубликованный Google Apps Script.

## Что нужно сделать

1. В Apps Script заменить `Code.gs` на `outputs/google_apps_script_Code.gs`.
2. Сохранить проект.
3. Обновить развертывание Apps Script: `Управление развертываниями -> редактировать -> Новая версия`.
4. Скопировать URL `/exec` опубликованного Apps Script.
5. В Railway создать сервис из папки `railway-survey`.
6. В Variables добавить:

```text
APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
```

7. Deploy.

После этого пользователям даем ссылку Railway, а не ссылку Apps Script.
