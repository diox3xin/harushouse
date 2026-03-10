/*
 * ============================================================
 *  Residence Loader — расширение для SillyTavern
 * ============================================================
 *  "Ленивая загрузка" локаций: описания комнат, домов и мест
 *  подгружаются в промпт ТОЛЬКО когда в последних сообщениях
 *  чата появляются заданные слова-триггеры.
 *
 *  Экономия токенов: вместо 800-1000 постоянных токенов
 *  тратится 30-50 постоянных + 100-200 ситуативных.
 *
 *  Автор: Haru & Bunny
 * ============================================================
 */

import {
    extension_settings,
    getContext,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from "../../../extensions.js";

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from "../../../../script.js";

// ============================================
//  КОНСТАНТЫ
// ============================================

const EXTENSION_NAME = "residence-loader";

// Дефолтные настройки расширения
const DEFAULT_SETTINGS = {
    enabled: true,
    globalScanDepth: 4,
    injectionPosition: extension_prompt_types.IN_CHAT,
    injectionDepth: 1,
    injectionRole: extension_prompt_roles.SYSTEM,
    wrapperTemplate: "[Активные данные локаций — используй эти детали при описании текущей сцены. Не выдумывай мебель, запахи и предметы, которых здесь нет:]",
    cards: [],
    debug: false,
};

// Позиции инжекции для UI селекта
const POSITION_OPTIONS = [
    { value: extension_prompt_types.IN_PROMPT, label: "В промпте (после system)" },
    { value: extension_prompt_types.IN_CHAT, label: "В чате (на заданной глубине)" },
    { value: extension_prompt_types.BEFORE_PROMPT, label: "Перед промптом" },
];

// ============================================
//  УТИЛИТЫ
// ============================================

/**
 * Генерирует уникальный ID для карточки
 */
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
}

/**
 * Нормализация текста для поиска триггеров.
 * Приводим к нижнему регистру, убираем пунктуацию,
 * схлопываем пробелы.
 */
function normalizeText(text) {
    if (!text) return "";
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Экранирование спецсимволов для RegExp
 */
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Экранирование HTML для безопасного вывода
 */
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Извлекает текст последних N сообщений из чата.
 * Возвращает склеенную строку.
 */
function getRecentMessagesText(depth) {
    const context = getContext();
    if (!context.chat || context.chat.length === 0) return "";

    const slice = context.chat.slice(-depth);
    return slice.map(msg => msg.mes || "").join(" ");
}

/**
 * Логирование в debug режиме
 */
function debugLog(...args) {
    if (getSettings().debug) {
        console.log(`[${EXTENSION_NAME}]`, ...args);
    }
}

// ============================================
//  НАСТРОЙКИ: ЗАГРУЗКА И СОХРАНЕНИЕ
// ============================================

/**
 * Загружает настройки расширения.
 * Если каких-то полей нет — подставляет дефолтные значения.
 */
function loadSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {};
    }

    const settings = extension_settings[EXTENSION_NAME];

    for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = Array.isArray(defaultValue)
                ? JSON.parse(JSON.stringify(defaultValue))
                : defaultValue;
        }
    }
}

/**
 * Сохраняет настройки (с debounce, чтобы не спамить диск)
 */
function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Получить текущие настройки
 */
function getSettings() {
    return extension_settings[EXTENSION_NAME];
}

// ============================================
//  ЛОГИКА СКАНИРОВАНИЯ ТРИГГЕРОВ
// ============================================

/**
 * Проверяет, содержится ли триггер в тексте.
 *
 * Если триггер — фраза из нескольких слов, ищем подстроку.
 * Если одиночное слово — ищем по границам слова (чтобы "кухня"
 * не срабатывало на "кухнях" — хотя, на самом деле, для русского
 * языка лучше искать начало слова, т.к. склонения).
 *
 * Используем "мягкий" поиск: проверяем, начинается ли какое-либо
 * слово в тексте с триггера (prefix match), чтобы учесть
 * морфологию русского языка.
 */
function triggerMatchesText(trigger, text) {
    const normalizedTrigger = normalizeText(trigger);
    if (!normalizedTrigger) return false;

    // Фраза из нескольких слов — ищем как подстроку
    if (normalizedTrigger.includes(" ")) {
        return text.includes(normalizedTrigger);
    }

    // Одиночное слово — prefix match для учёта склонений/спряжений
    // "кухн" совпадёт с "кухня", "кухне", "кухню", "кухни"
    // "холодильник" совпадёт с "холодильника", "холодильнике"
    const words = text.split(" ");
    return words.some(word => word.startsWith(normalizedTrigger));
}

/**
 * Главная функция сканирования.
 * Проходит по всем включённым карточкам, проверяет триггеры
 * в последних N сообщениях. Возвращает массив активированных карточек.
 */
function scanTriggers() {
    const settings = getSettings();

    if (!settings.enabled) return [];
    if (!settings.cards || settings.cards.length === 0) return [];

    const globalDepth = settings.globalScanDepth || 4;

    // Кэш текстов по глубине, чтобы не пересканировать
    const textCache = {};

    function getTextForDepth(depth) {
        if (!textCache[depth]) {
            textCache[depth] = normalizeText(getRecentMessagesText(depth));
        }
        return textCache[depth];
    }

    const activated = [];

    for (const card of settings.cards) {
        if (!card.enabled) continue;

        // "Всегда активна" — мастер-карточка (общая планировка)
        if (card.alwaysActive) {
            activated.push(card);
            continue;
        }

        if (!card.triggers || card.triggers.length === 0) continue;

        // Определяем глубину: своя или глобальная
        const depth = (card.scanDepth && card.scanDepth > 0)
            ? card.scanDepth
            : globalDepth;

        const text = getTextForDepth(depth);
        if (!text) continue;

        // Проверяем каждый триггер — достаточно одного совпадения
        const isTriggered = card.triggers.some(trigger =>
            triggerMatchesText(trigger, text)
        );

        if (isTriggered) {
            activated.push(card);
        }
    }

    return activated;
}

// ============================================
//  ИНЖЕКЦИЯ В ПРОМПТ
// ============================================

/**
 * Сканирует триггеры и инжектит активированные карточки в промпт.
 * Вызывается перед каждой генерацией.
 */
function injectActivatedCards() {
    const settings = getSettings();

    if (!settings.enabled) {
        clearInjection();
        return;
    }

    const activatedCards = scanTriggers();

    if (activatedCards.length === 0) {
        clearInjection();
        debugLog("Нет активных карточек");
        return;
    }

    // Собираем контент
    const wrapper = settings.wrapperTemplate || DEFAULT_SETTINGS.wrapperTemplate;
    const cardBlocks = activatedCards.map(card => {
        return `### ${card.name}\n${card.content}`;
    });

    const fullPrompt = `${wrapper}\n\n${cardBlocks.join("\n\n")}`;

    // Инжектим
    setExtensionPrompt(
        EXTENSION_NAME,
        fullPrompt,
        settings.injectionPosition ?? extension_prompt_types.IN_CHAT,
        settings.injectionDepth ?? 1,
        false,
        settings.injectionRole ?? extension_prompt_roles.SYSTEM,
    );

    debugLog(`Активировано карточек: ${activatedCards.length}`);
    activatedCards.forEach(c => debugLog(`  ✓ ${c.name}`));

    // Обновляем индикатор в UI
    updateActiveIndicator(activatedCards);
}

/**
 * Очищает инжекцию (пустой промпт)
 */
function clearInjection() {
    setExtensionPrompt(
        EXTENSION_NAME,
        "",
        extension_prompt_types.IN_CHAT,
        1,
        false,
        extension_prompt_roles.SYSTEM,
    );

    updateActiveIndicator([]);
}

// ============================================
//  UI: РЕНДЕРИНГ
// ============================================

/**
 * Создаёт и вставляет главную панель расширения
 * в секцию настроек расширений SillyTavern.
 */
function renderExtensionUI() {
    const settings = getSettings();

    const positionOptionsHtml = POSITION_OPTIONS.map(opt => {
        const selected = opt.value === settings.injectionPosition ? "selected" : "";
        return `<option value="${opt.value}" ${selected}>${opt.label}</option>`;
    }).join("");

    const html = `
    <div id="rl-root" class="rl-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🏠 Residence Loader</b>
                <span id="rl-active-badge" class="rl-badge" style="display:none;" title="Активных карточек">0</span>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <!-- ===== Глобальные настройки ===== -->
                <div class="rl-section">
                    <div class="rl-row">
                        <label class="checkbox_label">
                            <input type="checkbox" id="rl-enabled" ${settings.enabled ? "checked" : ""}>
                            <span>Расширение включено</span>
                        </label>
                    </div>
                    <div class="rl-row">
                        <label class="checkbox_label">
                            <input type="checkbox" id="rl-debug" ${settings.debug ? "checked" : ""}>
                            <span>Режим отладки (лог в консоль F12)</span>
                        </label>
                    </div>
                    <div class="rl-row">
                        <span>Глубина сканирования:</span>
                        <input type="number" id="rl-scan-depth" class="text_pole"
                               value="${settings.globalScanDepth}" min="1" max="50"
                               style="width:55px;" title="На сколько сообщений назад искать триггеры">
                    </div>
                    <div class="rl-row">
                        <span>Позиция инжекции:</span>
                        <select id="rl-injection-position" class="text_pole" style="width:220px;">
                            ${positionOptionsHtml}
                        </select>
                    </div>
                    <div class="rl-row">
                        <span>Глубина инжекции в чат:</span>
                        <input type="number" id="rl-injection-depth" class="text_pole"
                               value="${settings.injectionDepth}" min="0" max="50"
                               style="width:55px;" title="На какой глубине в чате вставить (0 = после последнего)">
                    </div>
                    <div class="rl-row">
                        <span>Обёртка (системное пояснение перед карточками):</span>
                        <textarea id="rl-wrapper" class="text_pole textarea_compact" rows="2"
                                  style="width:100%;margin-top:4px;">${escapeHtml(settings.wrapperTemplate)}</textarea>
                    </div>
                </div>

                <hr>

                <!-- ===== Карточки ===== -->
                <div class="rl-section">
                    <div class="rl-cards-header">
                        <b>📋 Карточки локаций</b>
                        <div class="rl-header-buttons">
                            <div id="rl-test-triggers" class="menu_button menu_button_icon"
                                 title="Проверить какие карточки активны прямо сейчас">
                                <i class="fa-solid fa-vial"></i>
                                <span>Тест</span>
                            </div>
                            <div id="rl-add-card" class="menu_button menu_button_icon"
                                 title="Создать новую карточку">
                                <i class="fa-solid fa-plus"></i>
                                <span>Добавить</span>
                            </div>
                        </div>
                    </div>

                    <div id="rl-cards-list" class="rl-cards-list">
                        <!-- Динамический рендер -->
                    </div>
                </div>

                <!-- ===== Редактор карточки ===== -->
                <div id="rl-editor" class="rl-editor" style="display:none;">
                    <hr>
                    <b id="rl-editor-title">Новая карточка</b>
                    <input type="hidden" id="rl-edit-id">

                    <div class="rl-row">
                        <label for="rl-edit-name">Название:</label>
                        <input type="text" id="rl-edit-name" class="text_pole"
                               placeholder="напр. Кухня Коди" style="width:100%;">
                    </div>

                    <div class="rl-row">
                        <label for="rl-edit-triggers">Триггеры через запятую:</label>
                        <input type="text" id="rl-edit-triggers" class="text_pole"
                               placeholder="кухня, кухн, готовить, холодильник, плита"
                               style="width:100%;">
                        <small class="rl-hint">
                            Совет: используй основы слов для учёта склонений.
                            "кухн" сработает на "кухня", "кухне", "кухню".
                        </small>
                    </div>

                    <div class="rl-row">
                        <label for="rl-edit-depth">Глубина сканирования (0 = глобальная):</label>
                        <input type="number" id="rl-edit-depth" class="text_pole"
                               value="0" min="0" max="50" style="width:55px;">
                    </div>

                    <div class="rl-row">
                        <label class="checkbox_label">
                            <input type="checkbox" id="rl-edit-always">
                            <span>Всегда активна (мастер-карточка)</span>
                        </label>
                        <small class="rl-hint">
                            Если включено, карточка будет в промпте ВСЕГДА, без триггеров.
                            Используй для общей планировки: "Однушка, хрущёвка, 4 этаж".
                        </small>
                    </div>

                    <div class="rl-row">
                        <label for="rl-edit-content">Описание локации:</label>
                        <textarea id="rl-edit-content" class="text_pole textarea_compact" rows="10"
                                  style="width:100%;"
                                  placeholder="Маленькая кухня, 6 квадратов. Линолеум вздувшийся у окна..."></textarea>
                    </div>

                    <div class="rl-editor-buttons">
                        <div id="rl-save-card" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-floppy-disk"></i>
                            <span>Сохранить</span>
                        </div>
                        <div id="rl-cancel-edit" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-xmark"></i>
                            <span>Отмена</span>
                        </div>
                    </div>
                </div>

                <!-- ===== Импорт / Экспорт ===== -->
                <hr>
                <div class="rl-section">
                    <div class="rl-row" style="gap:6px;">
                        <div id="rl-export" class="menu_button menu_button_icon" title="Экспорт карточек в JSON">
                            <i class="fa-solid fa-file-export"></i>
                            <span>Экспорт</span>
                        </div>
                        <div id="rl-import" class="menu_button menu_button_icon" title="Импорт карточек из JSON">
                            <i class="fa-solid fa-file-import"></i>
                            <span>Импорт</span>
                        </div>
                        <input type="file" id="rl-import-file" accept=".json" style="display:none;">
                    </div>
                </div>

            </div>
        </div>
    </div>`;

    $("#extensions_settings2").append(html);

    renderCardsList();
    bindUIEvents();
}

/**
 * Перерисовывает список карточек
 */
function renderCardsList() {
    const settings = getSettings();
    const container = $("#rl-cards-list");
    container.empty();

    if (!settings.cards || settings.cards.length === 0) {
        container.append(
            `<div class="rl-empty">Карточек пока нет. Нажми «Добавить» ✨</div>`
        );
        return;
    }

    for (const card of settings.cards) {
        const triggersPreview = card.alwaysActive
            ? "🔒 всегда активна"
            : card.triggers
                ? "🔑 " + card.triggers.slice(0, 4).join(", ") + (card.triggers.length > 4 ? " ..." : "")
                : "⚠ нет триггеров";

        // Примерный вес в токенах (грубо: 1 токен ≈ 3.5 символа для русского)
        const approxTokens = card.content
            ? Math.round(card.content.length / 3.5)
            : 0;

        const cardHtml = `
        <div class="rl-card ${card.enabled ? "" : "rl-card-off"}" data-id="${card.id}">
            <div class="rl-card-body">
                <div class="rl-card-name">
                    ${card.alwaysActive ? "📌 " : ""}${escapeHtml(card.name || "Без названия")}
                    <span class="rl-token-count" title="Примерно токенов">~${approxTokens}t</span>
                </div>
                <div class="rl-card-meta">${escapeHtml(triggersPreview)}</div>
            </div>
            <div class="rl-card-controls">
                <label class="checkbox_label" title="Включить/выключить">
                    <input type="checkbox" class="rl-toggle" data-id="${card.id}"
                           ${card.enabled ? "checked" : ""}>
                </label>
                <i class="rl-btn-edit fa-solid fa-pen-to-square menu_button"
                   data-id="${card.id}" title="Редактировать"></i>
                <i class="rl-btn-delete fa-solid fa-trash-can menu_button"
                   data-id="${card.id}" title="Удалить"></i>
            </div>
        </div>`;

        container.append(cardHtml);
    }
}

/**
 * Обновляет бейдж с количеством активных карточек
 */
function updateActiveIndicator(activatedCards) {
    const badge = $("#rl-active-badge");
    if (activatedCards.length > 0) {
        badge.text(activatedCards.length).show();
    } else {
        badge.hide();
    }
}

// ============================================
//  UI: ОБРАБОТЧИКИ СОБЫТИЙ
// ============================================

function bindUIEvents() {
    // ---------- Глобальные настройки (продолжение) ----------

    $("#rl-enabled").on("change", function () {
        getSettings().enabled = $(this).is(":checked");
        saveSettings();
        if (!getSettings().enabled) {
            clearInjection();
        }
    });

    $("#rl-debug").on("change", function () {
        getSettings().debug = $(this).is(":checked");
        saveSettings();
    });

    $("#rl-scan-depth").on("input", function () {
        const val = parseInt($(this).val(), 10);
        if (!isNaN(val) && val >= 1) {
            getSettings().globalScanDepth = val;
            saveSettings();
        }
    });

    $("#rl-injection-position").on("change", function () {
        getSettings().injectionPosition = parseInt($(this).val(), 10);
        saveSettings();
    });

    $("#rl-injection-depth").on("input", function () {
        const val = parseInt($(this).val(), 10);
        if (!isNaN(val) && val >= 0) {
            getSettings().injectionDepth = val;
            saveSettings();
        }
    });

    $("#rl-wrapper").on("input", function () {
        getSettings().wrapperTemplate = $(this).val();
        saveSettings();
    });

    // ---------- Карточки: toggle включить/выключить ----------

    $(document).on("change", ".rl-toggle", function () {
        const id = $(this).data("id");
        const card = findCardById(id);
        if (card) {
            card.enabled = $(this).is(":checked");
            saveSettings();
            renderCardsList();
        }
    });

    // ---------- Карточки: редактирование ----------

    $(document).on("click", ".rl-btn-edit", function () {
        const id = $(this).data("id");
        const card = findCardById(id);
        if (card) {
            openEditor(card);
        }
    });

    // ---------- Карточки: удаление ----------

    $(document).on("click", ".rl-btn-delete", function () {
        const id = $(this).data("id");
        const card = findCardById(id);
        if (!card) return;

        const confirmMsg = `Удалить карточку «${card.name || "Без названия"}»?\nЭто действие необратимо.`;
        if (confirm(confirmMsg)) {
            const settings = getSettings();
            settings.cards = settings.cards.filter(c => c.id !== id);
            saveSettings();
            renderCardsList();
            closeEditor();
        }
    });

    // ---------- Добавить новую карточку ----------

    $("#rl-add-card").on("click", function () {
        openEditor(null);
    });

    // ---------- Сохранить карточку из редактора ----------

    $("#rl-save-card").on("click", function () {
        saveCardFromEditor();
    });

    // ---------- Отмена редактирования ----------

    $("#rl-cancel-edit").on("click", function () {
        closeEditor();
    });

    // ---------- Тест триггеров ----------

    $("#rl-test-triggers").on("click", function () {
        runTriggerTest();
    });

    // ---------- Экспорт ----------

    $("#rl-export").on("click", function () {
        exportCards();
    });

    // ---------- Импорт ----------

    $("#rl-import").on("click", function () {
        $("#rl-import-file").trigger("click");
    });

    $("#rl-import-file").on("change", function (event) {
        const file = event.target.files[0];
        if (file) {
            importCards(file);
        }
        // Сбрасываем input, чтобы можно было загрузить тот же файл повторно
        $(this).val("");
    });
}

// ============================================
//  КАРТОЧКИ: ПОИСК, РЕДАКТОР, СОХРАНЕНИЕ
// ============================================

/**
 * Находит карточку по ID
 */
function findCardById(id) {
    const settings = getSettings();
    return settings.cards.find(c => c.id === id) || null;
}

/**
 * Открывает редактор для существующей карточки или новой
 * @param {object|null} card — если null, создаём новую
 */
function openEditor(card) {
    const editor = $("#rl-editor");
    const isNew = !card;

    if (isNew) {
        $("#rl-editor-title").text("✨ Новая карточка");
        $("#rl-edit-id").val("");
        $("#rl-edit-name").val("");
        $("#rl-edit-triggers").val("");
        $("#rl-edit-depth").val(0);
        $("#rl-edit-always").prop("checked", false);
        $("#rl-edit-content").val("");
    } else {
        $("#rl-editor-title").text("✏️ Редактирование: " + (card.name || "Без названия"));
        $("#rl-edit-id").val(card.id);
        $("#rl-edit-name").val(card.name || "");
        $("#rl-edit-triggers").val(card.triggers ? card.triggers.join(", ") : "");
        $("#rl-edit-depth").val(card.scanDepth || 0);
        $("#rl-edit-always").prop("checked", !!card.alwaysActive);
        $("#rl-edit-content").val(card.content || "");
    }

    editor.slideDown(200);

    // Скроллим к редактору
    setTimeout(() => {
        editor[0].scrollIntoView({ behavior: "smooth", block: "start" });
    }, 220);
}

/**
 * Закрывает редактор
 */
function closeEditor() {
    $("#rl-editor").slideUp(200);
}

/**
 * Считывает данные из редактора и сохраняет карточку
 */
function saveCardFromEditor() {
    const settings = getSettings();
    const editId = $("#rl-edit-id").val();
    const name = $("#rl-edit-name").val().trim();
    const triggersRaw = $("#rl-edit-triggers").val();
    const scanDepth = parseInt($("#rl-edit-depth").val(), 10) || 0;
    const alwaysActive = $("#rl-edit-always").is(":checked");
    const content = $("#rl-edit-content").val().trim();

    // Валидация
    if (!name) {
        alert("Введи название карточки!");
        $("#rl-edit-name").focus();
        return;
    }

    if (!content) {
        alert("Описание локации не может быть пустым!");
        $("#rl-edit-content").focus();
        return;
    }

    if (!alwaysActive && !triggersRaw.trim()) {
        alert("Укажи хотя бы один триггер, или отметь «Всегда активна»!");
        $("#rl-edit-triggers").focus();
        return;
    }

    // Парсим триггеры: разбиваем по запятой, трим, убираем пустые
    const triggers = triggersRaw
        .split(",")
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length > 0);

    if (editId) {
        // Редактируем существующую
        const card = findCardById(editId);
        if (card) {
            card.name = name;
            card.triggers = triggers;
            card.scanDepth = scanDepth;
            card.alwaysActive = alwaysActive;
            card.content = content;
        }
    } else {
        // Создаём новую
        const newCard = {
            id: generateId(),
            name: name,
            triggers: triggers,
            scanDepth: scanDepth,
            alwaysActive: alwaysActive,
            content: content,
            enabled: true,
        };
        settings.cards.push(newCard);
    }

    saveSettings();
    renderCardsList();
    closeEditor();
}

// ============================================
//  ТЕСТИРОВАНИЕ ТРИГГЕРОВ
// ============================================

/**
 * Запускает тест триггеров и выводит результат в виде алерта.
 * Показывает какие карточки активны прямо сейчас и почему.
 */
function runTriggerTest() {
    const settings = getSettings();

    if (!settings.enabled) {
        alert("⚠ Расширение выключено. Включи его и попробуй снова.");
        return;
    }

    if (!settings.cards || settings.cards.length === 0) {
        alert("📋 Карточек нет. Создай хотя бы одну.");
        return;
    }

    const globalDepth = settings.globalScanDepth || 4;
    const textCache = {};

    function getTextForDepth(depth) {
        if (!textCache[depth]) {
            textCache[depth] = normalizeText(getRecentMessagesText(depth));
        }
        return textCache[depth];
    }

    const results = [];

    for (const card of settings.cards) {
        if (!card.enabled) {
            results.push(`❌ ${card.name} — ВЫКЛЮЧЕНА`);
            continue;
        }

        if (card.alwaysActive) {
            results.push(`📌 ${card.name} — ВСЕГДА АКТИВНА`);
            continue;
        }

        if (!card.triggers || card.triggers.length === 0) {
            results.push(`⚠ ${card.name} — нет триггеров`);
            continue;
        }

        const depth = (card.scanDepth && card.scanDepth > 0) ? card.scanDepth : globalDepth;
        const text = getTextForDepth(depth);

        if (!text) {
            results.push(`⬜ ${card.name} — чат пуст, нечего сканировать`);
            continue;
        }

        const matchedTriggers = [];
        for (const trigger of card.triggers) {
            if (triggerMatchesText(trigger, text)) {
                matchedTriggers.push(trigger);
            }
        }

        if (matchedTriggers.length > 0) {
            results.push(`✅ ${card.name} — АКТИВНА (совпало: ${matchedTriggers.join(", ")})`);
        } else {
            results.push(`⬜ ${card.name} — не активна (глубина: ${depth})`);
        }
    }

    // Показываем текст последних сообщений для отладки
    const previewText = getTextForDepth(globalDepth);
    const previewSnippet = previewText
        ? previewText.substring(0, 300) + (previewText.length > 300 ? "..." : "")
        : "(пусто)";

    const output = [
        "🏠 Residence Loader — Тест триггеров",
        "═══════════════════════════════",
        "",
        ...results,
        "",
        "═══════════════════════════════",
        `Сканируемый текст (глубина ${globalDepth}, первые 300 символов):`,
        previewSnippet,
    ].join("\n");

    alert(output);
}

// ============================================
//  ЭКСПОРТ / ИМПОРТ
// ============================================

/**
 * Экспортирует все карточки в JSON-файл
 */
function exportCards() {
    const settings = getSettings();

    if (!settings.cards || settings.cards.length === 0) {
        alert("📋 Нечего экспортировать — карточек нет.");
        return;
    }

    const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        cards: settings.cards,
    };

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `residence-loader-cards-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Импортирует карточки из JSON-файла.
 * Спрашивает: заменить все или добавить к существующим.
 */
function importCards(file) {
    const reader = new FileReader();

    reader.onload = function (e) {
        try {
            const data = JSON.parse(e.target.result);

            if (!data.cards || !Array.isArray(data.cards)) {
                alert("⚠ Неверный формат файла: не найден массив cards.");
                return;
            }

            // Валидируем карточки
            const validCards = data.cards.filter(card => {
                return card && typeof card.name === "string" && typeof card.content === "string";
            });

            if (validCards.length === 0) {
                alert("⚠ В файле нет валидных карточек.");
                return;
            }

            const settings = getSettings();

            const action = confirm(
                `Найдено карточек: ${validCards.length}\n\n` +
                `OK = ЗАМЕНИТЬ все текущие карточки\n` +
                `Отмена = ДОБАВИТЬ к существующим`
            );

            if (action) {
                // Заменить
                settings.cards = [];
            }

            // Добавляем карточки с новыми ID (чтобы не было коллизий)
            for (const card of validCards) {
                settings.cards.push({
                    id: generateId(),
                    name: card.name || "Импортировано",
                    triggers: Array.isArray(card.triggers) ? card.triggers : [],
                    scanDepth: card.scanDepth || 0,
                    alwaysActive: !!card.alwaysActive,
                    content: card.content || "",
                    enabled: card.enabled !== false,
                });
            }

            saveSettings();
            renderCardsList();

            alert(`✅ Импортировано карточек: ${validCards.length}`);

        } catch (err) {
            alert("⚠ Ошибка при чтении файла:\n" + err.message);
            console.error(`[${EXTENSION_NAME}] Import error:`, err);
        }
    };

    reader.readAsText(file);
}

// ============================================
//  ИНИЦИАЛИЗАЦИЯ РАСШИРЕНИЯ
// ============================================

/**
 * Точка входа. Вызывается когда jQuery и SillyTavern готовы.
 */
jQuery(async () => {
    // 1. Загружаем настройки
    loadSettings();

    // 2. Рендерим UI
    renderExtensionUI();

    // 3. Подписываемся на событие генерации —
    //    перед каждой отправкой промпта сканируем триггеры
    //    и инжектим активные карточки.
    eventSource.on(event_types.GENERATION_STARTED, () => {
        debugLog("GENERATION_STARTED — сканирую триггеры...");
        injectActivatedCards();
    });

    // 4. При смене чата — очищаем инжекцию,
    //    чтобы не тащить данные из прошлого чата.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        debugLog("CHAT_CHANGED — очищаю инжекцию");
        clearInjection();
        updateActiveIndicator([]);
    });

    // 5. Опционально: сканируем при загрузке, чтобы бейдж
    //    сразу показывал актуальное состояние.
    setTimeout(() => {
        const activated = scanTriggers();
        updateActiveIndicator(activated);
        debugLog("Первичное сканирование завершено, активных:", activated.length);
    }, 1000);

    console.log(`[${EXTENSION_NAME}] ✅ Расширение загружено и готово к работе!`);
});
