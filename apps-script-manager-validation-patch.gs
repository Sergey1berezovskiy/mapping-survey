// Replace the existing validateSubmittedReference_ function in Code.gs with this version.
// It keeps strict validation for employees and stores, but accepts a manager value
// if it is present either in "Руководители" or in the "Руководитель" column of "Сотрудники".
function validateSubmittedReference_(type, value, label) {
  const safeValue = String(value || '').trim();
  if (!safeValue) throw new Error(label + ': выберите значение из справочника.');

  const sheetNameByType = {
    employees: SHEETS.employees,
    managers: SHEETS.managers,
    stores: SHEETS.stores,
  };

  const sheetName = sheetNameByType[type];
  const normalizedValue = normalizeSearchText_(safeValue);

  const exists = readRows_(sheetName)
    .filter((row) => isTrue_(row['Активен']))
    .map((row) => normalizeReference_(type, row).label)
    .some((referenceLabel) => normalizeSearchText_(referenceLabel) === normalizedValue);

  if (exists) return;

  if (type === 'managers') {
    const existsInEmployees = readRows_(SHEETS.employees)
      .filter((row) => isTrue_(row['Активен']))
      .some((row) => normalizeSearchText_(row['Руководитель']) === normalizedValue);

    if (existsInEmployees) return;
  }

  if (type === 'managers') {
    throw new Error(label + ': руководитель подтянулся из сотрудника, но отсутствует в листе "Руководители". Добавьте его в справочник или выберите вариант из подсказки.');
  }

  throw new Error(label + ': значение отсутствует в справочнике. Выберите вариант из подсказки.');
}
