const selections = new Map();

export function getSectionSelection(key, fallback = '') {
    return selections.get(key) || fallback;
}
const labels = {
    'Agent Output': 'Output',
    'Agent Settings': 'Settings',
    'Prompt Template': 'Prompt',
    'Output Contract': 'Contract',
    'Knowledge Context': 'Knowledge',
    'JavaScript Action Result': 'Action',
};

export function mountSectionTabs(root, { key, defaultLabel = '', navigationRoot = null, orientation = 'horizontal', onSelect = () => {} }) {
    if (!root || root.dataset.sectionTabs) return;
    const sections = [...root.children].filter(child => child.matches('details, section.sd-card'));
    if (!sections.length) return;
    root.dataset.sectionTabs = key;
    root.classList.add('sd-section-stack');
    root.classList.remove('sd-grid--double');

    const dangerZone = root.querySelector(':scope > .sd-agent-danger-zone');
    if (dangerZone) sections[0].querySelector('.sd-card-body')?.append(dangerZone);
    const nav = document.createElement('div');
    nav.className = 'sd-section-tabs';
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Agent sections');
    nav.setAttribute('aria-orientation', orientation);
    const panels = document.createElement('div');
    panels.className = 'sd-section-panels';
    const buttons = [];
    const titles = sections.map(section => {
        const heading = section.querySelector('.sd-disclosure-title, .sd-card-title') ?? section.querySelector(':scope > summary');
        const title = heading?.textContent.trim() || 'Details';
        return labels[title] || title;
    });
    const preferred = selections.get(key) || defaultLabel;
    let active = Math.max(0, titles.indexOf(preferred));

    const select = (index, focus = false) => {
        active = index;
        selections.set(key, titles[index]);
        sections.forEach((section, position) => {
            section.hidden = position !== index;
            buttons[position].setAttribute('aria-selected', String(position === index));
            buttons[position].tabIndex = position === index ? 0 : -1;
        });
        if (focus) buttons[index].focus();
        onSelect(titles[index]);
    };

    sections.forEach((section, index) => {
        const id = `sd-section-${encodeURIComponent(key)}-${index}`;
        section.id = id;
        section.classList.add('sd-tab-section');
        section.setAttribute('role', 'tabpanel');
        section.setAttribute('aria-labelledby', `${id}-tab`);
        if (section.tagName === 'DETAILS') section.open = true;
        const button = document.createElement('button');
        button.type = 'button';
        button.id = `${id}-tab`;
        button.className = 'sd-section-tab';
        button.textContent = titles[index];
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', id);
        button.addEventListener('click', () => select(index));
        button.addEventListener('keydown', event => {
            let target = active;
            if (event.key === 'ArrowRight' || (orientation === 'vertical' && event.key === 'ArrowDown')) target = (active + 1) % sections.length;
            else if (event.key === 'ArrowLeft' || (orientation === 'vertical' && event.key === 'ArrowUp')) target = (active - 1 + sections.length) % sections.length;
            else if (event.key === 'Home') target = 0;
            else if (event.key === 'End') target = sections.length - 1;
            else return;
            event.preventDefault();
            select(target, true);
        });
        buttons.push(button);
        nav.append(button);
        panels.append(section);
    });
    if (navigationRoot) navigationRoot.replaceChildren(nav);
    else root.append(nav);
    root.append(panels);
    select(active);
}

/** Keep the active view's section tabs directly under its button in one navigation column. */
export function nestAgentSectionNavigation(navigation) {
    if (!navigation) return;
    const views = navigation.querySelector('.sd-agent-view-tabs');
    const sections = navigation.querySelector('.sd-agent-section-navigation');
    if (!views || !sections) return;
    const active = views.querySelector(':scope > .sd-subnav-button--active');
    if (active) active.after(sections);
    for (const button of views.querySelectorAll(':scope > [data-agent-view]')) {
        button.setAttribute('aria-expanded', String(button === active && !!sections.childElementCount));
    }
    if (views.dataset.verticalNavigation) return;
    views.dataset.verticalNavigation = 'true';
    views.addEventListener('keydown', event => {
        if (!event.target.matches('[data-agent-view]')) return;
        const buttons = [...views.querySelectorAll(':scope > [data-agent-view]')];
        const current = buttons.indexOf(event.target);
        let target;
        if (event.key === 'ArrowDown') target = (current + 1) % buttons.length;
        else if (event.key === 'ArrowUp') target = (current - 1 + buttons.length) % buttons.length;
        else if (event.key === 'Home') target = 0;
        else if (event.key === 'End') target = buttons.length - 1;
        else return;
        event.preventDefault();
        buttons[target].click();
        buttons[target].focus();
    });
}
