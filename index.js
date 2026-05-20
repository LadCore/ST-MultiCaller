console.log('[RP Router] Carregando...');

const EXTENSION_NAME = 'MultiCaller';

const DEFAULT_CONFIG = {
    routerProfileId:   '',
    contextMessages:   5,
    maxTokens:         10,
    enabled:           true,
    manageTV:          true,
    routerPrompt: `You are a routing controller for a roleplay session.
Players: {{players}}.
Last speaker: {{lastSpeaker}}

Read the context and reply with ONE WORD ONLY — the name of who speaks next.
Valid options: {{players}}
No explanation. No punctuation. One word.`,
    characters: [],
    // characters: [{ name, profileId, profileName }]
};

let config = { ...DEFAULT_CONFIG };
let isProcessing = false;
let lastActiveChar = null;

// ================= FLOW LOG =================

const T0 = Date.now();
function fl(direction, method, detail = '') {
    const t = ((Date.now() - T0) / 1000).toFixed(2);
    const det = detail ? ` | ${detail}` : '';
    console.log(`[RP Router][${t}s] ${direction} ${method}${det}`);
}

// ================= CONFIG =================

function saveConfig() {
    localStorage.setItem(`st_${EXTENSION_NAME}_settings`, JSON.stringify(config));
}

function loadConfig() {
    const saved = localStorage.getItem(`st_${EXTENSION_NAME}_settings`);
    if (saved) {
        config = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
    }
}

// ================= SOUND =================

const USER_SOUND_URL = '/scripts/extensions/third-party/MultiCaller/sounds/User.mp3';

function playUserSound() {
    try {
        const audio = new Audio(USER_SOUND_URL);
        audio.volume = 0.5;
        audio.play().catch(() => {});
    } catch (_) {}
}

// ================= CHAT LOCK =================

function lockChat() {
    $('#send_textarea').prop('disabled', true);
    $('#send_but').prop('disabled', true);
}

function unlockChat() {
    $('#send_textarea').prop('disabled', false);
    $('#send_but').prop('disabled', false);
    $('#send_textarea').focus();
}

// ================= TUNNELVISION TOGGLE =================

function getTVInput() {
    return document.querySelector('.tv-toggle-slider')?.parentElement?.querySelector('input');
}

function disableTV() {
    if (!config.manageTV) return;
    const input = getTVInput();
    if (input?.checked) document.querySelector('.tv-toggle-slider').click();
}

function enableTV() {
    if (!config.manageTV) return;
    const input = getTVInput();
    if (input && !input.checked) document.querySelector('.tv-toggle-slider').click();
}

// ================= CHARACTER NOTE =================

const CHAR_NOTE_KEY = 'rp-router-char-note';

function setCharacterNote(charName) {
    const ctx = SillyTavern.getContext();
    const note = `[Write the next reply only as ${charName}. Do NOT speak as any other character.]`;
    if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(CHAR_NOTE_KEY, note, 2, 0);
    }
}

function clearCharacterNote() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(CHAR_NOTE_KEY, '', 2, 0);
    }
}

// ================= CONNECTION SERVICE =================

let _connService = null;
async function getConnService() {
    if (!_connService) {
        const mod = await import('/scripts/extensions/shared.js');
        _connService = mod.ConnectionManagerRequestService;
    }
    return _connService;
}

// ================= ROUTER =================

async function callRouterAgent(chatHistory) {
    if (!config.enabled || !config.routerProfileId) return null;

    const realMessages = chatHistory.filter(m =>
        !m.is_system &&
        m.extra?.type !== 'tool_call' &&
        m.extra?.type !== 'tool_response' &&
        m.mes != null
    );

    const lastSpeaker    = realMessages[realMessages.length - 1]?.name || 'Unknown';
    const contextMessages = realMessages.slice(-config.contextMessages);
    const playerNames    = config.characters.map(c => c.name).join(', ');

    const systemPrompt = config.routerPrompt
        .replace(/{{lastSpeaker}}/gi, lastSpeaker)
        .replace(/{{players}}/gi,    playerNames);

    const ctx       = SillyTavern.getContext();
    const humanName = ctx.name1 || '';
    const sanitize  = (text) => humanName ? text.replace(/{{user}}/gi, humanName) : text;

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: contextMessages.map(m => `${m.name}: ${sanitize(m.mes || '')}`).join('\n') },
    ];

    try {
        const service  = await getConnService();
        const response = await service.sendRequest(
            config.routerProfileId, messages, config.maxTokens,
            { stream: false, extractData: true }
        );

        const reasoning = response?.reasoning ?? response?.reasoning_content ?? response?.thinking ?? null;
        if (reasoning) console.log(`[RP Router] Reasoning:`, reasoning);

        let decision;
        if (typeof response === 'string')                    decision = response.trim();
        else if (response?.text)                             decision = String(response.text).trim();
        else if (response?.choices?.[0]?.message?.content)  decision = String(response.choices[0].message.content).trim();
        else if (response?.content)                          decision = String(response.content).trim();
        else { console.warn('[RP Router] Formato de resposta desconhecido:', response); decision = null; }

        return decision || null;

    } catch (error) {
        console.error('[RP Router] Erro no sendRequest:', error);
        return null;
    }
}

// ================= TRIGGER =================


async function triggerChar(char) {
    fl('→ START', 'triggerChar', `char=${char.name} | last=${lastActiveChar} | profile=${char.profileName}`);
    const ctx = SillyTavern.getContext();

    if (char.name !== lastActiveChar && char.profileName) {
        lastActiveChar = char.name;
        fl('  →', 'triggerChar', `/profile await=true "${char.profileName}"`);
        await ctx.executeSlashCommandsWithOptions(`/profile await=true "${char.profileName}"`);
        fl('  ←', 'triggerChar', 'profile switch done — aguardando 250ms');
        await new Promise(r => setTimeout(r, 250));
    } else {
        lastActiveChar = char.name;
    }

    enableTV();
    fl('  ✓', 'triggerChar', 'TV ativado — aguardando 250ms');
    await new Promise(r => setTimeout(r, 250));

    fl('  →', 'triggerChar', `/trigger ${char.name}`);
    ctx.executeSlashCommandsWithOptions(`/trigger ${char.name}`);
    fl('← END', 'triggerChar', `char=${char.name}`);
}

// ================= EXECUÇÃO =================

async function executeDecision(decision, caller = 'unknown') {
    fl('→ START', 'executeDecision', `caller=${caller} | decision="${decision}"`);
    const clean = decision.trim().toLowerCase();

    const char = config.characters.find(c => {
        const name = c.name.toLowerCase().trim();
        return name === clean || name.includes(clean) || clean.includes(name);
    });

    if (!char) {
        fl('← END', 'executeDecision', `jogador | decision="${decision}"`);
        isProcessing = false;
        unlockChat();
        playUserSound();
        return;
    }

    lockChat();
    setCharacterNote(char.name);
    await triggerChar(char);

    fl('← END', 'executeDecision', `char=${char.name}`);
    // isProcessing fica true — só libera via GENERATION_ENDED
}

async function runRouter(triggerEvent = 'unknown') {
    if (isProcessing) {
        fl('  =', 'runRouter', `bloqueado | isProcessing=true | trigger=${triggerEvent}`);
        return;
    }
    isProcessing = true;
    fl('→ START', 'runRouter', `trigger=${triggerEvent}`);

    disableTV();

    try {
        const ctx      = SillyTavern.getContext();
        const decision = await callRouterAgent(ctx.chat);
        if (decision) {
            await executeDecision(decision, 'runRouter');
        } else {
            fl('← END', 'runRouter', 'sem decisão');
            isProcessing = false;
        }
    } catch (e) {
        console.error('[RP Router] Erro no router:', e);
        fl('← END', 'runRouter', `erro: ${e.message}`);
        isProcessing = false;
    }
}

// ================= UI =================

function renderSettings() {
    const html = `
        <div id="multicaller-settings" class="extension-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>MultiCaller Router</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">

                    <div class="flex-container flex-column flex-gap5 margin-bot-10px">
                        <label class="checkbox flex-container">
                            <input type="checkbox" id="router-enabled" ${config.enabled ? 'checked' : ''}>
                            <span>Router Ativo</span>
                        </label>
                        <label class="checkbox flex-container" title="Se desmarcado, a extensão não toca no TunnelVision em nenhum momento">
                            <input type="checkbox" id="router-manage-tv" ${config.manageTV ? 'checked' : ''}>
                            <span>Gerenciar TunnelVision <span style="color:#888;font-size:0.85em;">ⓘ</span></span>
                        </label>
                    </div>


                    <h4>Router</h4>
                    <div class="flex-container flex-column flex-gap5 margin-bot-10px">
                        <label>Perfil de conexão:</label>
                        <select id="router-profile-dropdown" class="text_pole"></select>
                        <div class="flex-container flex-gap10" style="margin-top:6px;">
                            <div class="flex1">
                                <label>Contexto (msgs):</label>
                                <input type="number" id="router-context" class="text_pole" min="1" max="50" value="${config.contextMessages}">
                            </div>
                            <div class="flex1">
                                <label>Max Tokens:</label>
                                <input type="number" id="router-max-tokens" class="text_pole" min="1" max="200" value="${config.maxTokens}">
                            </div>
                        </div>
                    </div>

                    <h4>Router Prompt</h4>
                    <div class="flex-container flex-column flex-gap5 margin-bot-10px">
                        <textarea id="router-prompt" class="text_pole" rows="8" style="width:100%;min-height:150px;resize:vertical;font-family:monospace;font-size:0.9em;">${config.routerPrompt.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
                    </div>

                    <div class="flex-container justify-center margin-top-10px" style="gap:10px">
                        <button id="router-save-btn" class="menu_button primary">Salvar</button>
                        <button id="router-simulate-btn" class="menu_button">Simular Decisão</button>
                        <button id="router-load-group-btn" class="menu_button">Carregar do Grupo</button>
                    </div>

                    <div id="router-group-members" style="margin-top:10px;"></div>

                </div>
            </div>
        </div>

        <style>
            #multicaller-settings .flex-container { display: flex; }
            #multicaller-settings .flex-column { flex-direction: column; }
            #multicaller-settings .flex-gap5 { gap: 5px; }
            #multicaller-settings .flex-gap10 { gap: 10px; }
            #multicaller-settings .flex1 { flex: 1; }
            #multicaller-settings .margin-bot-10px { margin-bottom: 10px; }
            #multicaller-settings .margin-top-10px { margin-top: 10px; }
            #multicaller-settings .justify-center { justify-content: center; }
            #multicaller-settings h4 { margin: 15px 0 10px 0; border-bottom: 1px solid #444; padding-bottom: 5px; }
            #multicaller-settings label { font-size: 0.9em; color: #ccc; }
            #multicaller-settings .primary { background: #2d7d46; }
            #multicaller-settings .primary:hover { background: #36a355; }
        </style>
    `;

    $('#extensions_settings').append(html);
}

function loadGroupMembers() {
    const ctx   = SillyTavern.getContext();
    const group = ctx.groups.find(g => g.id === ctx.groupId);

    if (!group) {
        $('#router-group-members').html('<small style="color:#888;">Nenhum grupo ativo.</small>');
        return;
    }

    const groupNames = group.members
        .map(avatar => ctx.characters.find(c => c.avatar === avatar))
        .filter(Boolean)
        .map(c => c.name);

    const existing    = config.characters || [];
    config.characters = groupNames.map(name => {
        const saved = existing.find(c => c.name === name);
        return saved ?? { name, profileId: '', profileName: '' };
    });

    renderGroupMembers();
}

function renderGroupMembers() {
    if (!config.characters.length) {
        $('#router-group-members').html('<small style="color:#888;">Nenhum personagem carregado.</small>');
        return;
    }

    const html = config.characters.map((char, idx) => `
        <div class="char-config-block" data-name="${char.name}" data-idx="${idx}" style="border:1px solid #333; border-radius:4px; padding:8px; margin-bottom:8px;">
            <div style="margin-bottom:6px;">
                <b style="color:#eee;">${char.name}</b>
            </div>
            <label style="font-size:0.85em; color:#aaa;">Perfil de conexão:</label>
            <select id="char-profile-${idx}" class="char-profile text_pole" style="width:100%; margin-top:3px;"></select>
        </div>
    `).join('');

    $('#router-group-members').html(`<h4>Personagens</h4>${html}`);

    // Inicializa o dropdown de cada personagem após o HTML estar no DOM
    initCharProfileDropdowns();
}

async function initRouterProfileDropdown() {
    const service = await getConnService();
    service.handleDropdown(
        '#router-profile-dropdown',
        config.routerProfileId,
        (profile) => { config.routerProfileId = profile?.id ?? ''; }
    );
}

async function initCharProfileDropdowns() {
    const service = await getConnService();
    config.characters.forEach((char, idx) => {
        service.handleDropdown(
            `#char-profile-${idx}`,
            char.profileId,
            (profile) => {
                config.characters[idx].profileId   = profile?.id   ?? '';
                config.characters[idx].profileName = profile?.name ?? '';
            }
        );
    });
}

function attachEvents() {
    $('#router-save-btn').on('click', () => {
        config.routerProfileId = $('#router-profile-dropdown').val() || config.routerProfileId;
        config.contextMessages = parseInt($('#router-context').val());
        config.maxTokens       = parseInt($('#router-max-tokens').val());
        config.enabled         = $('#router-enabled').is(':checked');
        config.manageTV        = $('#router-manage-tv').is(':checked');
        config.routerPrompt    = $('#router-prompt').val();
        // config.characters já está atualizado pelos callbacks dos dropdowns

        saveConfig();
        toastr.success('Configurações salvas!', 'RP Router');
    });

    $('#router-load-group-btn').on('click', () => loadGroupMembers());

    $('#router-simulate-btn').on('click', async () => {
        const ctx = SillyTavern.getContext();
        toastr.info('Consultando...', 'RP Router');
        const decision = await callRouterAgent(ctx.chat);
        toastr.info(decision ? `Decisão: ${decision}` : 'Sem resposta', 'RP Router');
    });
}

// ================= MAIN =================

jQuery(document).ready(async () => {
    loadConfig();
    renderSettings();
    attachEvents();
    initRouterProfileDropdown();
    if (config.characters.length) renderGroupMembers();

    const ctx = SillyTavern.getContext();

    ctx.registerSlashCommand?.('router', async () => {
        await runRouter('manual');
        return '';
    }, [], 'Executa o router manualmente');

    ctx.eventSource.on(ctx.event_types.USER_MESSAGE_RENDERED, () => {
        setTimeout(() => {
            runRouter('USER_MESSAGE_RENDERED');
        }, 300);
    });

    ctx.eventSource.on(ctx.event_types.CHARACTER_MESSAGE_RENDERED, () => {
        setTimeout(() => {
            const c = SillyTavern.getContext();
            const lastMsg = c.chat[c.chat.length - 1];
            if (lastMsg?.extra?.type === 'tool_call' || lastMsg?.extra?.type === 'tool_response') {
                return; // ignora mensagens de tool call — GM ainda está gerando
            }
            runRouter('CHARACTER_MESSAGE_RENDERED');
        }, 300);
    });

    ctx.eventSource.on(ctx.event_types.GENERATION_ENDED, () => {
        const c = SillyTavern.getContext();
        const lastMsg = c.chat[c.chat.length - 1];
        const type = lastMsg?.extra?.type;
        const isEmpty = !lastMsg?.mes?.trim();
        const isToolCycle = isEmpty || type === 'tool_call' || type === 'tool_response';
        fl('← EVT', 'GENERATION_ENDED', `isProcessing=${isProcessing} | type=${type ?? (isEmpty ? 'empty' : 'msg')} | toolCycle=${isToolCycle}`);
        if (!isProcessing) return;
        if (isToolCycle) {
            fl('  =', 'GENERATION_ENDED', 'tool_call pendente — mantendo isProcessing');
            return;
        }
        clearCharacterNote();
        disableTV();
        isProcessing = false;
        fl('  ✓', 'GENERATION_ENDED', 'isProcessing liberado');
    });

    ctx.eventSource.on(ctx.event_types.GENERATION_STOPPED, () => {
        fl('← EVT', 'GENERATION_STOPPED', `isProcessing=${isProcessing}`);
        if (!isProcessing) return;
        clearCharacterNote();
        disableTV();
        isProcessing = false;
        fl('  ✓', 'GENERATION_STOPPED', 'isProcessing liberado (stop forçado)');
    });

    ctx.eventSource.on(ctx.event_types.GROUP_MEMBER_DRAFTED, (charName) => {
        fl('← EVT', 'GROUP_MEMBER_DRAFTED', `char=${charName}`);
        lastActiveChar = charName;
    });

    ctx.eventSource.on(ctx.event_types.CHAT_COMPLETION_PROMPT_READY, ({ chat, dryRun }) => {
        if (dryRun) return;


        const noteMsg    = chat.findLast(m => m.role === 'system' && m.content?.includes('Write the next reply only as '));
        const match      = noteMsg?.content?.match(/Write the next reply only as (.+?)\./);
        const activeChar = match?.[1];

        // Sempre remapeia: só o personagem ativo fica como assistant, todos os outros viram user
        if (activeChar) {
            let remapped = 0;
            for (const msg of chat) {
                if (msg.role !== 'assistant') continue;
                if (!String(msg.content ?? '').startsWith(activeChar + ':')) {
                    msg.role = 'user';
                    remapped++;
                }
            }
            if (remapped > 0) console.log(`[RP Router] Role remap: ${remapped} msgs → user (gerando como ${activeChar})`);
        }

    });

    ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
        fl('← EVT', 'CHAT_CHANGED', `isProcessing=${isProcessing} | lastActiveChar=${lastActiveChar}`);
        lastActiveChar = null;
        loadGroupMembers();
    });

    loadGroupMembers();

    console.log('[RP Router] Pronto!');
});
