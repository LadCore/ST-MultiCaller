import { ensureAceLoaded } from './agent-script-editor.js';

const instances = new Map();
let mountVersion = 0;

function createTool(icon, label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sd-editor-tool';
    button.title = label;
    button.setAttribute('aria-label', label);
    const glyph = document.createElement('i');
    glyph.className = `fa-solid fa-${icon}`;
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph);
    button.addEventListener('click', action);
    return button;
}

export async function mountTextEditors(root) {
    const version = mountVersion;
    const sources = [...(root?.querySelectorAll(
        '#agent-prompt, #agent-output, #agent-ooc-request, #router-prompt, #router-ooc-request, #character-summary-text, .sd-agent-content pre[data-token-count-source]',
    ) ?? [])].filter(source => !instances.has(source) && source.getClientRects().length);
    if (!sources.length) return;
    const ace = await ensureAceLoaded();
    if (version !== mountVersion) return;
    ace.config.setModuleUrl('ace/ext/searchbox', '/scripts/extensions/third-party/MultiCaller/vendor/ace/ext-searchbox.js');

    for (const source of sources) {
        if (!source.isConnected || instances.has(source) || !source.getClientRects().length) continue;
        const readOnly = source.tagName !== 'TEXTAREA';
        const shell = document.createElement('div');
        shell.className = `sd-text-editor-shell${readOnly ? ' sd-text-editor-shell--readonly' : ''}`;
        const toolbar = document.createElement('div');
        toolbar.className = 'sd-text-editor-toolbar';
        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', readOnly ? 'Text viewer' : 'Text editor');
        const host = document.createElement('div');
        host.className = 'sd-text-editor';
        const status = document.createElement('span');
        status.className = 'sd-editor-position';
        status.setAttribute('aria-live', 'polite');
        shell.append(toolbar, host);
        source.after(shell);
        const editor = ace.edit(host);
        editor.setTheme('ace/theme/one_dark');
        editor.session.setMode('ace/mode/text');
        editor.session.setUseWorker(false);
        editor.setOptions({ fontSize: '14px', showPrintMargin: false, wrap: true, readOnly, showFoldWidgets: false });
        editor.setValue(readOnly ? source.textContent : source.value, -1);
        editor.textInput.getElement().setAttribute('aria-label', source.id || 'Agent text');
        const entry = { editor, source, shell, dirty: false, destroying: false };
        instances.set(source, entry);
        source.classList.add('sd-editor-source');
        const sync = () => {
            if (readOnly || entry.destroying) return;
            source.value = editor.getValue();
            entry.dirty = true;
            source.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const save = () => {
            if (!entry.dirty || entry.destroying) return;
            entry.dirty = false;
            source.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        };
        editor.session.on('change', sync);
        editor.on('blur', save);
        editor.commands.addCommand({ name: 'backstageSave', bindKey: { win: 'Ctrl-S', mac: 'Command-S' }, exec: save });
        if (!readOnly) {
            toolbar.append(createTool('rotate-left', 'Undo', () => editor.undo()));
            toolbar.append(createTool('rotate-right', 'Redo', () => editor.redo()));
        }
        toolbar.append(createTool('magnifying-glass', 'Find', () => editor.execCommand('find')));
        if (!readOnly) toolbar.append(createTool('arrows-rotate', 'Find and replace', () => editor.execCommand('replace')));
        toolbar.append(createTool('copy', 'Copy text', async () => {
            try { await navigator.clipboard.writeText(editor.getValue()); status.textContent = 'Copied'; }
            catch { status.textContent = 'Copy failed'; }
        }));
        const wrap = createTool('align-left', 'Toggle line wrapping', () => {
            const enabled = !editor.session.getUseWrapMode();
            editor.session.setUseWrapMode(enabled);
            wrap.setAttribute('aria-pressed', String(enabled));
        });
        wrap.setAttribute('aria-pressed', 'true');
        toolbar.append(wrap);
        const expand = createTool('expand', 'Expand editor', () => {
            const expanded = shell.classList.toggle('sd-text-editor-shell--focused');
            expand.setAttribute('aria-pressed', String(expanded));
            expand.title = expanded ? 'Restore editor' : 'Expand editor';
            expand.setAttribute('aria-label', expand.title);
            expand.firstElementChild.className = `fa-solid fa-${expanded ? 'compress' : 'expand'}`;
            editor.resize();
            editor.focus();
        });
        expand.setAttribute('aria-pressed', 'false');
        toolbar.append(expand, status);
        editor.commands.addCommand({ name: 'backstageRestore', readOnly: true, bindKey: { win: 'Esc', mac: 'Esc' }, exec: () => {
            if (shell.classList.contains('sd-text-editor-shell--focused')) expand.click();
        } });
        editor.selection.on('changeCursor', () => {
            const position = editor.getCursorPosition();
            status.textContent = `${position.row + 1}:${position.column + 1}`;
        });
        status.textContent = readOnly ? 'Read only' : '1:1';
        entry.observer = new ResizeObserver(() => editor.resize());
        entry.observer.observe(host);
        editor.resize();
    }
}

export function flushTextEditors() {
    for (const entry of instances.values()) {
        if (!entry.dirty) continue;
        entry.dirty = false;
        entry.source.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }
}

export function destroyTextEditors() {
    mountVersion += 1;
    for (const entry of instances.values()) {
        entry.destroying = true;
        entry.observer.disconnect();
        entry.editor.destroy();
        entry.source.classList.remove('sd-editor-source');
        entry.shell.remove();
    }
    instances.clear();
}
