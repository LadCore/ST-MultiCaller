const ACE_BASE_URL = '/scripts/extensions/third-party/MultiCaller/vendor/ace';
const ACE_CORE_URL = `${ACE_BASE_URL}/ace.js`;

let activeEditor = null;
let loadingPromise = null;

function loadScriptOnce(src) {
    const existing = document.querySelector(`script[data-backstage-script="${src}"]`);
    if (existing?.dataset.loaded === 'true') return Promise.resolve();

    return new Promise((resolve, reject) => {
        const script = existing ?? document.createElement('script');
        const handleLoad = () => {
            script.dataset.loaded = 'true';
            resolve();
        };
        const handleError = () => reject(new Error(`Failed to load ${src}`));
        script.addEventListener('load', handleLoad, { once: true });
        script.addEventListener('error', handleError, { once: true });

        if (!existing) {
            script.src = src;
            script.async = true;
            script.dataset.backstageScript = src;
            document.head.append(script);
        }
    });
}

async function ensureAceLoaded() {
    if (window.ace) return window.ace;
    loadingPromise ??= loadScriptOnce(ACE_CORE_URL).then(() => {
        if (!window.ace) throw new Error('Ace loaded without exposing window.ace.');
        window.ace.config.set('basePath', ACE_BASE_URL);
        window.ace.config.set('modePath', ACE_BASE_URL);
        window.ace.config.set('themePath', ACE_BASE_URL);
        window.ace.config.set('workerPath', ACE_BASE_URL);
        return window.ace;
    });
    return loadingPromise;
}

export async function mountAgentScriptEditor(elementId, value, { onBlur } = {}) {
    destroyAgentScriptEditor();
    const element = document.getElementById(elementId);
    if (!element) return null;

    const ace = await ensureAceLoaded();
    if (!document.body.contains(element)) return null;

    const editor = ace.edit(element);
    editor.setTheme('ace/theme/one_dark');
    editor.session.setMode('ace/mode/javascript');
    editor.session.setUseWorker(true);
    editor.session.setTabSize(4);
    editor.session.setUseSoftTabs(true);
    editor.setValue(String(value ?? ''), -1);
    editor.setOptions({
        fontSize: '13px',
        showPrintMargin: false,
        wrap: true,
        useWorker: true,
    });
    editor.on('blur', () => onBlur?.(editor.getValue()));
    editor.resize();
    activeEditor = editor;
    return editor;
}

export function getAgentScriptEditorValue() {
    return activeEditor?.getValue() ?? null;
}

export function destroyAgentScriptEditor() {
    if (!activeEditor) return;
    activeEditor.destroy();
    activeEditor.container?.removeAttribute('data-ace-editor');
    activeEditor = null;
}
