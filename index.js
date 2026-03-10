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
 * ============================================================
 */

// ============================================
//  ИМПОРТЫ (безопасные)
// ============================================

let extension_settings, getContext, setExtensionPrompt;
let extension_prompt_types, extension_prompt_roles;
let eventSource, event_types, saveSettingsDebounced;

try {
    const extModule = await import("../../../extensions.js");
    extension_settings = extModule.extension_settings;
    getContext = extModule.getContext;
    setExtensionPrompt = extModule.setExtensionPrompt;
    extension_prompt_types = extModule.extension_prompt_types;
    extension_prompt_roles = extModule.extension_prompt_roles;
} catch (err) {
    console.error("[residence-loader] Ошибка импорта extensions.js:", err);
}

try {
    const scriptModule = await import("../../../../script.js");
    eventSource = scriptModule.eventSource;
    event_types = scriptModule.event_types;
    saveSettingsDebounced = scriptModule.saveSettingsDebounced;
} catch (err) {
    console.error("[residence-loader] Ошибка импорта script.js:", err);
}

// ============================================
//  КОНСТАНТЫ
// ============================================

const EXTENSION_NAME = "residence-loader";
const LOG_PREFIX = `[${EXTENSION_NAME}]`;

// Числовые fallback-значения на случай если enum-ы не загрузились
const PROMPT_TYPE_IN_PROMPT = extension_prompt_types?.IN_PROMPT ?? 0;
const PROMPT_TYPE_IN_CHAT = extension_prompt_types?.IN_CHAT ?? 1;
const PROMPT_TYPE_BEFORE_PROMPT = extension_prompt_types?.BEFORE_PROMPT ?? 2;
const PROMPT_ROLE_SYSTEM = extension_prompt_roles?.SYSTEM ?? 0;

// Дефолтные настройки расширения
const DEFAULT_SETTINGS = {
    enabled: true,
    globalScanDepth: 4,
    injectionPosition: PROMPT_TYPE_IN_CHAT,
    injectionDepth: 1,
    injectionRole: PROMPT_ROLE_SYSTEM,
    wrapperTemplate: "[Активные данные локаций — используй эти детали при описании текущей сцены. Не выдумывай мебель, запахи и предметы, которых здесь нет:]",
    cards: [],
    debug: false,
};

// Позиции инжекции для UI селекта
const POSITION_OPTIONS = [
    { value: PROMPT_TYPE_IN_PROMPT, label: "В промпте (после system)" },
    { value: PROMPT_TYPE_IN_CHAT, label: "В чате (на заданной глубине)" },
    { value: PROMPT_TYPE_BEFORE_PROMPT, label: "Перед промптом" },
];

// ============================================
//  УТИЛИТЫ
// ============================================

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
}

function normalizeText(text) {
    if (!text) return "";
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function getRecentMessagesText(depth) {
    try {
        const context = getContext();
        if (!context || !context.chat || context.chat.length === 0) return "";
        const slice = context.chat.slice(-depth);
        return slice.map(msg => msg.mes || "").join(" ");
    } catch (err) {
        console.warn(LOG_PREFIX, "Ошибка чтения чата:", err);
        return "";
    }
}

function debugLog(...args) {
    if (getSettings().debug) {
        console.log(LOG_PREFIX, ...args);
    }
}

// ============================================
//  НАСТРОЙКИ
// ============================================

function loadSettings() {
    if (!extension_settings) {
        console.error(LOG_PREFIX, "extension_settings не загружен!");
        return;
    }

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

    console.log(LOG_PREFIX, "Настройки загружены:", JSON.stringify(settings).substring(0, 200));
}

function saveSettings() {
    if (saveSettingsDebounced) {
        saveSettingsDebounced();
    } else {
        console.warn(LOG_PREFIX, "saveSettingsDebounced недоступен");
    }
}

function getSettings() {
    if (!extension_settings || !extension_settings[EXTENSION_NAME]) {
        return { ...DEFAULT_SETTINGS };
    }
    return extension_settings[EXTENSION_NAME];
}

// ============================================
//  ЛОГИКА ТРИГГЕРОВ
// ============================================

function triggerMatchesText(trigger, text) {
    const normalizedTrigger = normalizeText(trigger);
    if (!normalizedTrigger) return false;

    if (normalizedTrigger.includes(" ")) {
        return text.includes(normalizedTrigger);
    }

    const words = text.split(" ");
    return words.some(word => word.startsWith(normalizedTrigger));
}

function scanTriggers() {
    const settings = getSettings();

    if (!settings.enabled) return [];
    if (!settings.cards || settings.cards.length === 0) return [];

    const globalDepth = settings.globalScanDepth || 4;
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

        if (card.alwaysActive) {
            activated.push(card);
            continue;
        }

        if (!card.triggers || card.triggers.length === 0) continue;

        const depth = (card.scanDepth && card.scanDepth > 0)
            ? card.scanDepth
            : globalDepth;

        const text = getTextForDepth(depth);
        if (!text) continue;

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

function safeSetExtensionPrompt(key, value, position, depth, scan, role) {
    try {
        if (typeof setExtensionPrompt === "function") {
            setExtensionPrompt(key, value, position, depth, scan, role);
            return;
        }

        const ctx = getContext();
        if (ctx && typeof ctx.setExtensionPrompt === "function") {
            ctx.setExtensionPrompt(key, value, position, depth, scan, role);
            return;
        }

        console.warn(LOG_PREFIX, "setExtensionPrompt не найден ни в экспортах, ни в контексте");
    } catch (err) {
        console.error(LOG_PREFIX, "Ошибка при setExtensionPrompt:", err);
    }
}

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

    const wrapper = settings.wrapperTemplate || DEFAULT_SETTINGS.wrapperTemplate;
    const cardBlocks = activatedCards.map(card => {
        return `### ${card.name}\n${card.content}`;
    });

    const fullPrompt = `${wrapper}\n\n${cardBlocks.join("\n\n")}`;

    safeSetExtensionPrompt(
        EXTENSION_NAME,
        fullPrompt,
        settings.injectionPosition ?? PROMPT_TYPE_IN_CHAT,
        settings.injectionDepth ?? 1,
        false,
        settings.injectionRole ?? PROMPT_ROLE_SYSTEM,
    );

    debugLog(`Активировано карточек: ${activatedCards.length}`);
    activatedCards.forEach(c => debugLog(`  ✓ ${c.name}`));

    updateActiveIndicator(activatedCards);
}

function clearInjection() {
    safeSetExtensionPrompt(
        EXTENSION_NAME,
        "",
        PROMPT_TYPE_IN_CHAT,
        1,
        false,
        PROMPT_ROLE_SYSTEM,
    );

    updateActiveIndicator([]);
}

// ============================================
//  UI: ПОСТРОЕНИЕ HTML
// ============================================

function buildSettingsHtml() {
    const settings = getSettings();

    const positionOptionsHtml = POSITION_OPTIONS.map(opt => {
        const selected = opt.value === settings.injectionPosition ? "selected" : "";
        return `<option value="${opt.value}" ${selected}>${opt.label}</option>`;
    }).join("");

    return `
    <div id="rl-root" class="rl-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header" id="rl-drawer-toggle">
                <b>Bunny's House</b>
                <span id="rl-active-badge" class="rl-badge" style="display:none;" title="Активных карточек">0</span>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" id="rl-drawer-content">

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

                    <div id="rl-cards-list" class="rl-cards-list"></div>
                </div>

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
}

// ============================================
//  UI: РЕНДЕРИНГ
// ============================================

function renderExtensionUI() {
    const html = buildSettingsHtml();

    // Пробуем несколько контейнеров в порядке приоритета
    const containers = [
        "#extensions_settings",
        "#extensions_settings2",
        "#extensions_settings_area",
    ];

    let appended = false;

    for (const selector of containers) {
        const $container = $(selector);
        if ($container.length > 0) {
            $container.append(html);
            console.log(LOG_PREFIX, `UI добавлен в ${selector}`);
            appended = true;
            break;
        }
    }

    if (!appended) {
        console.error(LOG_PREFIX, "Не найден контейнер для UI! Пробовал:", containers.join(", "));
        console.log(LOG_PREFIX, "Доступные #extensions_ элементы:",
            $("[id^='extensions_']").map(function() { return this.id; }).get()
        );
        return;
    }

    // Проверяем что наш элемент реально в DOM
    if ($("#rl-root").length === 0) {
        console.error(LOG_PREFIX, "HTML добавлен, но #rl-root не найден в DOM!");
        return;
    }

    console.log(LOG_PREFIX, "UI элемент #rl-root найден в DOM ✓");

    // Drawer toggle — с защитой от конфликта с ST
    // Останавливаем всплытие, чтобы встроенный обработчик ST
    // не перехватывал клик и не дёргал drawer повторно.
    const drawerToggle = document.getElementById("rl-drawer-toggle");
    const drawerContent = document.getElementById("rl-drawer-content");

    if (drawerToggle && drawerContent) {
        // Убираем класс, который ST использует для автопривязки,
        // чтобы ST вообще не трогал наш drawer.
        drawerToggle.classList.remove("inline-drawer-toggle");

        // Начинаем со свёрнутого состояния
        drawerContent.style.display = "none";

        drawerToggle.addEventListener("click", function (e) {
            e.stopPropagation();
            e.stopImmediatePropagation();

            const $content = $(drawerContent);
            const $icon = $(this).find(".inline-drawer-icon");

            if ($content.is(":visible")) {
                $content.slideUp(200);
                $icon.removeClass("up").addClass("down");
            } else {
                $content.slideDown(200);
                $icon.removeClass("down").addClass("up");
            }
        });

        console.log(LOG_PREFIX, "Drawer toggle привязан вручную (ST-класс удалён) ✓");
    } else {
        console.warn(LOG_PREFIX, "Drawer toggle элементы не найдены!");
    }

    renderCardsList();
    bindUIEvents();

    console.log(LOG_PREFIX, "UI полностью инициализирован ✓");
}

/**
 * Перерисовывает список карточек
 */
function renderCardsList() {
    const settings = getSettings();
    const container = $("#rl-cards-list");

    if (container.length === 0) {
        console.warn(LOG_PREFIX, "#rl-cards-list не найден");
        return;
    }

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

function updateActiveIndicator(activatedCards) {
    const badge = $("#rl-active-badge");
    if (badge.length === 0) return;

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
    // Глобальные настройки
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

    // Карточки: toggle
    $(document).on("change", ".rl-toggle", function () {
        const id = $(this).data("id");
        const card = findCardById(id);
        if (card) {
            card.enabled = $(this).is(":checked");
            saveSettings();
            renderCardsList();
        }
    });

    // Карточки: редактирование
    $(document).on("click", ".rl-btn-edit", function () {
        const id = $(this).data("id");
        const card = findCardById(id);
        if (card) {
            openEditor(card);
        }
    });

    // Карточки: удаление
    $(document).on("click", ".rl-btn-delete", function () {
        const id = $(this).data("id");
        const card = findCardById(id);
        if (!card) return;

        if (confirm(`Удалить карточку «${card.name || "Без названия"}»?\nЭто действие необратимо.`)) {
            const settings = getSettings();
            settings.cards = settings.cards.filter(c => c.id !== id);
            saveSettings();
            renderCardsList();
            closeEditor();
        }
    });

    // Добавить
    $("#rl-add-card").on("click", function () {
        openEditor(null);
    });

    // Сохранить из редактора
    $("#rl-save-card").on("click", function () {
        saveCardFromEditor();
    });

    // Отмена
    $("#rl-cancel-edit").on("click", function () {
        closeEditor();
    });

    // Тест триггеров
    $("#rl-test-triggers").on("click", function () {
        runTriggerTest();
    });

    // Экспорт
    $("#rl-export").on("click", function () {
        exportCards();
    });

    // Импорт
    $("#rl-import").on("click", function () {
        $("#rl-import-file").trigger("click");
    });

    $("#rl-import-file").on("change", function (event) {
        const file = event.target.files[0];
        if (file) {
            importCards(file);
        }
        $(this).val("");
    });
}

// ============================================
//  КАРТОЧКИ: ПОИСК, РЕДАКТОР, СОХРАНЕНИЕ
// ============================================

function findCardById(id) {
    const settings = getSettings();
    return settings.cards.find(c => c.id === id) || null;
}

function openEditor(card) {
    const editor = $("#rl-editor");
    if (editor.length === 0) return;

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

    setTimeout(() => {
        const el = editor[0];
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 220);
}

function closeEditor() {
    $("#rl-editor").slideUp(200);
}

function saveCardFromEditor() {
    const settings = getSettings();
    const editId = $("#rl-edit-id").val();
    const name = $("#rl-edit-name").val().trim();
    const triggersRaw = $("#rl-edit-triggers").val();
    const scanDepth = parseInt($("#rl-edit-depth").val(), 10) || 0;
    const alwaysActive = $("#rl-edit-always").is(":checked");
    const content = $("#rl-edit-content").val().trim();

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

    const triggers = triggersRaw
        .split(",")
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length > 0);

    if (editId) {
        const card = findCardById(editId);
        if (card) {
            card.name = name;
            card.triggers = triggers;
            card.scanDepth = scanDepth;
            card.alwaysActive = alwaysActive;
            card.content = content;
        }
    } else {
        settings.cards.push({
            id: generateId(),
            name: name,
            triggers: triggers,
            scanDepth: scanDepth,
            alwaysActive: alwaysActive,
            content: content,
            enabled: true,
        });
    }

    saveSettings();
    renderCardsList();
    closeEditor();
}

// ============================================
//  ТЕСТ ТРИГГЕРОВ
// ============================================

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

    const previewText = getTextForDepth(globalDepth);
    const previewSnippet = previewText
        ? previewText.substring(0, 300) + (previewText.length > 300 ? "..." : "")
        : "(пусто)";

    alert([
        "🏠 Residence Loader — Тест триггеров",
        "═══════════════════════════════",
        "",
        ...results,
        "",
        "═══════════════════════════════",
        `Сканируемый текст (глубина ${globalDepth}, первые 300 символов):`,
        previewSnippet,
    ].join("\n"));
}

// ============================================
//  ЭКСПОРТ / ИМПОРТ
// ============================================

function exportCards() {
    const settings = getSettings();

    if (!settings.cards || settings.cards.length === 0) {
        alert("📋 Нечего экспортировать — карточек нет.");
        return;
    }

    const json = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        cards: settings.cards,
    }, null, 2);

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

function importCards(file) {
    const reader = new FileReader();

    reader.onload = function (e) {
        try {
            const data = JSON.parse(e.target.result);

            if (!data.cards || !Array.isArray(data.cards)) {
                alert("⚠ Неверный формат файла: не найден массив cards.");
                return;
            }

            const validCards = data.cards.filter(card =>
                card && typeof card.name === "string" && typeof card.content === "string"
            );

            if (validCards.length === 0) {
                alert("⚠ В файле нет валидных карточек.");
                return;
            }

            const settings = getSettings();

            const shouldReplace = confirm(
                `Найдено карточек: ${validCards.length}\n\n` +
                `OK = ЗАМЕНИТЬ все текущие карточки\n` +
                `Отмена = ДОБАВИТЬ к существующим`
            );

            if (shouldReplace) {
                settings.cards = [];
            }

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
            console.error(LOG_PREFIX, "Import error:", err);
        }
    };

    reader.readAsText(file);
}

// ============================================
//  ИНИЦИАЛИЗАЦИЯ
// ============================================

jQuery(async () => {
    try {
        console.log(LOG_PREFIX, "Начинаю инициализацию...");

        // Проверяем критичные зависимости
        if (!extension_settings) {
            console.error(LOG_PREFIX, "FATAL: extension_settings не импортирован. Расширение не может работать.");
            return;
        }

        if (!getContext) {
            console.error(LOG_PREFIX, "FATAL: getContext не импортирован. Расширение не может работать.");
            return;
        }

        // 1. Настройки
        loadSettings();
        console.log(LOG_PREFIX, "Шаг 1/4: настройки ✓");

        // 2. UI
        renderExtensionUI();
        console.log(LOG_PREFIX, "Шаг 2/4: UI ✓");

        // 3. События
        if (eventSource && event_types) {
            if (event_types.GENERATION_STARTED) {
                eventSource.on(event_types.GENERATION_STARTED, () => {
                    debugLog("GENERATION_STARTED — сканирую триггеры...");
                    injectActivatedCards();
                });
                console.log(LOG_PREFIX, "Шаг 3/4: подписка на GENERATION_STARTED ✓");
            } else {
                console.warn(LOG_PREFIX, "event_types.GENERATION_STARTED не определён");
            }

            if (event_types.CHAT_CHANGED) {
                eventSource.on(event_types.CHAT_CHANGED, () => {
                    debugLog("CHAT_CHANGED — очищаю инжекцию");
                    clearInjection();
                    updateActiveIndicator([]);
                });
                console.log(LOG_PREFIX, "Шаг 3/4: подписка на CHAT_CHANGED ✓");
            }
        } else {
            console.warn(LOG_PREFIX, "eventSource или event_types недоступны — подписка на события невозможна");
        }

        // 4. Первичное сканирование
        setTimeout(() => {
            try {
                const activated = scanTriggers();
                updateActiveIndicator(activated);
                debugLog("Первичное сканирование: активных", activated.length);
            } catch (err) {
                console.warn(LOG_PREFIX, "Ошибка первичного сканирования:", err);
            }
        }, 1500);

        console.log(LOG_PREFIX, "✅ Расширение полностью инициализировано!");

    } catch (err) {
        console.error(LOG_PREFIX, "FATAL: Ошибка при инициализации:", err);
    }
});
