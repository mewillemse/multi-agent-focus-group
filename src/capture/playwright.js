const fs = require('fs/promises');
const path = require('path');
const { chromium, devices } = require('playwright');

const DEVICE_PROFILES = {
    desktop: { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 },
    mobile: devices['iPhone 13'],
};

const MAX_ELEMENTS = 120;
const MAX_TEXT_LENGTH = 4000;

// "Accept all" buttons of common consent platforms.
const CONSENT_SELECTORS = [
    '[data-testid="uc-accept-all-button"]', // Usercentrics
    '#onetrust-accept-btn-handler', // OneTrust
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', // Cookiebot
    '#CybotCookiebotDialogBodyButtonAccept',
    '#didomi-notice-agree-button', // Didomi
    '.fc-cta-consent', // Google Funding Choices
    '#truste-consent-button', // TrustArc
    '[data-cookiefirst-action="accept"]', // CookieFirst
    '.cky-btn-accept', // CookieYes
    '.cmplz-accept', // Complianz
];

// Fallback: a visible button whose whole label is an accept phrase.
const CONSENT_LABEL = new RegExp(
    '^\\s*(' + [
        'akkoord', 'ja,? ik ga akkoord', 'ik ga akkoord', 'alles? accepteren', 'alle cookies accepteren',
        'accepteer( alle( cookies)?)?', 'cookies accepteren', 'alle cookies toestaan', 'alles toestaan', 'toestaan',
        'accept', 'accept all', 'accept all cookies', 'accept cookies', 'allow all', 'allow all cookies',
        'i agree', 'agree', 'got it', 'ok', 'okay',
        'alle akzeptieren', 'akzeptieren', 'zustimmen', 'tout accepter', 'accepter', 'aceptar', 'aceptar todo',
    ].join('|') + ')\\s*$',
    'i',
);

let browserPromise = null;

// One shared browser; relaunched if it crashed or was closed (e.g. killed by the OS).
async function getBrowser() {
    if (browserPromise) {
        const browser = await browserPromise.catch(() => null);
        if (browser?.isConnected()) return browser;
        browserPromise = null;
    }

    const launching = chromium.launch().then((browser) => {
        browser.on('disconnected', () => {
            if (browserPromise === launching) browserPromise = null;
        });
        return browser;
    });
    launching.catch(() => {
        if (browserPromise === launching) browserPromise = null;
    });
    browserPromise = launching;
    return launching;
}

async function newContext(profile) {
    try {
        return await (await getBrowser()).newContext(profile);
    } catch (error) {
        // The browser can die between getBrowser() and newContext(); one fresh attempt.
        if (!/has been closed/i.test(error.message)) throw error;
        browserPromise = null;
        return (await getBrowser()).newContext(profile);
    }
}

async function closeBrowser() {
    if (!browserPromise) return;
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    await browser?.close();
}

// Fields a persona must never fill in: the simulation does not submit personal data to real sites.
const SENSITIVE_INPUT = 'input[type="password"], input[type="email"], input[type="tel"], [autocomplete^="cc-"]';

/**
 * One persona's own browser tab. It stays open across steps so the persona
 * can click, type, scroll and go back, and each capture() records what is
 * on screen at that moment.
 */
class BrowserSession {
    static async open({ url, device = 'desktop', acceptCookies = true }) {
        const profile = DEVICE_PROFILES[device] || DEVICE_PROFILES.desktop;
        const context = await newContext(profile);
        const session = new BrowserSession(context, await context.newPage(), device);

        try {
            const response = await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            session.status = response?.status() ?? null;
            await session.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            session.cookieConsent = acceptCookies ? await acceptCookieBanner(session.page) : null;
        } catch (error) {
            await session.close();
            throw error;
        }
        return session;
    }

    constructor(context, page, device) {
        this.context = context;
        this.page = page;
        this.device = device;
        this.status = null;
        this.cookieConsent = null;
        this.elements = [];

        // Links that open a new tab would leave this page behind; follow them here instead.
        context.on('page', async (popup) => {
            const target = popup.url();
            await popup.close().catch(() => {});
            if (target && target !== 'about:blank') {
                await this.page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});
            }
        });
    }

    /**
     * Records what a visitor sees right now: a JPEG screenshot of the viewport,
     * the visible text, and an element registry mapping short ids (e1, e2, ...)
     * to a selector and a viewport-relative bounding box.
     */
    async capture({ outputDir, name }) {
        await this.#waitForStableScreen();

        const { elements, text, visibleText } = await this.page.evaluate(extractPageModel, {
            maxElements: MAX_ELEMENTS,
            maxTextLength: MAX_TEXT_LENGTH,
        });
        this.elements = elements;

        await fs.mkdir(outputDir, { recursive: true });
        const screenshotFile = `${name}.jpg`;
        const screenshot = await this.page.screenshot({ type: 'jpeg', quality: 75 });
        await fs.writeFile(path.join(outputDir, screenshotFile), screenshot);

        return {
            url: this.page.url(),
            status: this.status,
            blockedReason: detectBlock(this.status, elements),
            cookieConsent: this.cookieConsent,
            title: await this.page.title(),
            device: this.device,
            viewport: this.page.viewportSize(),
            screenshotFile,
            screenshotBase64: screenshot.toString('base64'),
            text,
            visibleText,
            elements,
        };
    }

    /**
     * Carries out a persona's nextAction against the latest capture.
     * Returns { ok, description } in plain words for the persona to read.
     */
    async perform({ type, elementId, text } = {}) {
        const element = this.elements.find((item) => item.id === elementId);
        const label = element ? `${element.role}${element.name ? ` "${element.name}"` : ''} [${element.id}]` : `[${elementId}]`;
        const urlBefore = this.page.url();

        const describeResult = (what) => {
            const now = this.page.url();
            return `${what} ${now === urlBefore ? 'You are still on the same page.' : `The page changed to ${now}.`}`;
        };

        try {
            if (type === 'scroll') {
                const { moved, where } = await this.page.evaluate(scrollDown);
                await this.page.waitForTimeout(600); // lazy-loaded content
                return moved > 0
                    ? { ok: true, description: `You scrolled down ${where}.` }
                    : { ok: false, description: `You tried to scroll down ${where}, but you are already at the bottom of it.` };
            }

            if (type === 'back') {
                const response = await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
                if (!response) return { ok: false, description: 'You tried to go back, but there is no previous page.' };
                await this.page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
                return { ok: true, description: describeResult('You went back.') };
            }

            if (!element) {
                return { ok: false, description: `You tried to ${type} ${label}, but that element is not on the current screen.` };
            }

            const locator = this.page.locator(`[data-fg-id="${element.id}"]`).first();

            if (type === 'click') {
                await this.#runAndSettle(() => locator.click({ timeout: 5000 }));
                return { ok: true, description: describeResult(`You clicked ${label}.`) };
            }

            if (type === 'type') {
                if (!text) return { ok: false, description: `You wanted to type into ${label}, but did not say what.` };
                const field = await this.#editableField(locator);
                if (!field) return { ok: false, description: `You tried to type into ${label}, but there was no text field to type in.` };
                if (await field.evaluate((node, selector) => node.matches(selector), SENSITIVE_INPUT)) {
                    return { ok: false, description: `This study does not fill in personal details, so you did not type into ${label}.` };
                }
                await field.fill(text, { timeout: 5000 });
                await this.#runAndSettle(() => field.press('Enter'));
                return { ok: true, description: describeResult(`You typed "${text}" into ${label} and pressed Enter.`) };
            }

            return { ok: false, description: `"${type}" is not something you can do in this study.` };
        } catch (error) {
            const reason = error.message.split('\n')[0].replace(/^[\w.]+: /, '');
            return { ok: false, description: `You tried to ${type} ${label}, but it did not work (${reason}).` };
        }
    }

    // The element itself if it takes text; otherwise click it (e.g. a search button that opens a field) and use what got focus.
    async #editableField(locator) {
        const isEditable = (node) => node.matches('input, textarea, [contenteditable="true"]');
        if (await locator.evaluate(isEditable)) return locator;

        await locator.click({ timeout: 5000 });
        await this.page.waitForTimeout(500);
        const focused = this.page.locator('*:focus').first();
        if (await focused.count() && await focused.evaluate(isEditable)) return focused;

        const visibleInput = this.page.locator('input[type="search"]:visible, input[type="text"]:visible, input:not([type]):visible').first();
        return (await visibleInput.count()) ? visibleInput : null;
    }

    // Fades, spinners and overlays after a click would otherwise end up in the screenshot.
    async #waitForStableScreen({ timeoutMs = 3000, intervalMs = 250 } = {}) {
        const deadline = Date.now() + timeoutMs;
        let previous = null;
        while (Date.now() < deadline) {
            const frame = await this.page.screenshot({ type: 'jpeg', quality: 30 }).catch(() => null);
            if (frame && previous && frame.equals(previous)) return;
            previous = frame;
            await this.page.waitForTimeout(intervalMs);
        }
    }

    // Runs a click or key press and waits for its effect. If it started a page
    // navigation, wait for the new document; otherwise the screenshot would show
    // the old page fading out.
    async #runAndSettle(action) {
        let newDocument = null;
        const onRequest = (request) => {
            if (!newDocument && request.isNavigationRequest() && request.frame() === this.page.mainFrame()) {
                newDocument = this.page.waitForEvent('domcontentloaded', { timeout: 15000 }).catch(() => {});
            }
        };

        this.page.on('request', onRequest);
        try {
            await action();
            await this.page.waitForTimeout(300); // time for a click-triggered navigation to start
            if (newDocument) await newDocument;
        } finally {
            this.page.off('request', onRequest);
        }
        await this.page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    }

    async close() {
        await this.context.close().catch(() => {});
    }
}

/**
 * Clicks "accept all" on a cookie banner, if there is one, so personas see
 * the page itself. Looks in every frame; Playwright locators also pierce
 * open shadow roots. Returns { accepted, method, label } or { accepted: false }.
 */
async function acceptCookieBanner(page) {
    const findButton = async () => {
        for (const frame of page.frames()) {
            for (const selector of CONSENT_SELECTORS) {
                const button = frame.locator(selector).first();
                if (await button.isVisible().catch(() => false)) return { button, method: selector };
            }
        }
        for (const frame of page.frames()) {
            const button = frame.getByRole('button', { name: CONSENT_LABEL }).first();
            if (await button.isVisible().catch(() => false)) return { button, method: 'button label' };
        }
        return null;
    };

    const found = await findButton();
    if (!found) return { accepted: false };

    const label = ((await found.button.textContent().catch(() => '')) || '').trim().slice(0, 60);
    try {
        await found.button.click({ timeout: 3000 });
        await found.button.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
        // Some sites reload or re-render after consent.
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    } catch (error) {
        return { accepted: false, method: found.method, label, error: error.message.split('\n')[0] };
    }
    return { accepted: true, method: found.method, label };
}

// Runs inside the page. Scrolls whatever the visitor is looking at: an open
// pop-up or panel with its own scroll area if there is one, else the page.
function scrollDown() {
    const x = window.innerWidth / 2;
    const y = window.innerHeight / 2;
    let node = document.elementFromPoint(x, y);
    while (node?.shadowRoot) {
        const inner = node.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === node) break;
        node = inner;
    }

    for (; node && node !== document.body && node !== document.documentElement; node = node.parentElement || node.getRootNode().host) {
        if (!(node instanceof Element)) continue;
        const { overflowY } = getComputedStyle(node);
        if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight + 1) {
            const before = node.scrollTop;
            node.scrollBy(0, Math.round(node.clientHeight * 0.8));
            const rect = node.getBoundingClientRect();
            const coversScreen = rect.width >= window.innerWidth * 0.95 && rect.height >= window.innerHeight * 0.9;
            return { moved: node.scrollTop - before, where: coversScreen ? 'the page' : 'inside the pop-up or panel' };
        }
    }

    const before = window.scrollY;
    window.scrollBy(0, Math.round(window.innerHeight * 0.8));
    return { moved: window.scrollY - before, where: 'the page' };
}

// Bot walls and error pages give personas nothing real to react to.
function detectBlock(status, elements) {
    if (status && status >= 400) {
        return `The site answered with HTTP ${status}; it probably blocks automated browsers.`;
    }
    if (elements.length === 0) {
        return 'The page has no visible links, buttons or headings; it may be a bot check or still loading.';
    }
    return null;
}

// Runs inside the page. Must be self-contained.
function extractPageModel({ maxElements, maxTextLength }) {
    const SELECTOR = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
        'h1', 'h2', 'h3', 'img[alt]:not([alt=""])', 'nav', 'form',
    ].join(',');

    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    function isVisible(el, rect) {
        if (rect.width < 2 || rect.height < 2) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    }

    function accessibleName(el) {
        const labelledBy = el.getAttribute('aria-labelledby');
        const byId = labelledBy && labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText).join(' ');
        const label = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText;
        const raw = el.getAttribute('aria-label') || byId || label || el.getAttribute('alt')
            || (['nav', 'form'].includes(el.tagName.toLowerCase()) ? '' : el.innerText)
            || el.getAttribute('placeholder') || el.getAttribute('title') || el.value
            || el.querySelector('img[alt]')?.getAttribute('alt')
            || el.querySelector('svg[aria-label]')?.getAttribute('aria-label') || '';
        return raw.replace(/\s+/g, ' ').trim().slice(0, 100);
    }

    function role(el) {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'img') return 'image';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'nav') return 'navigation';
        if (tag === 'input') return el.type === 'submit' || el.type === 'button' ? 'button' : `input:${el.type || 'text'}`;
        return tag;
    }

    function cssPath(el) {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body) {
            if (node.id) {
                parts.unshift(`#${CSS.escape(node.id)}`);
                break;
            }
            const tag = node.tagName.toLowerCase();
            const siblings = Array.from(node.parentElement?.children || []).filter((child) => child.tagName === node.tagName);
            parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
            node = node.parentElement;
        }
        return parts.join(' > ');
    }

    // Cookie banners and widgets often live in (open) shadow roots.
    function queryAllDeep(root, selector, found = []) {
        found.push(...root.querySelectorAll(selector));
        for (const host of root.querySelectorAll('*')) {
            if (host.shadowRoot) queryAllDeep(host.shadowRoot, selector, found);
        }
        return found;
    }

    function composedContains(ancestor, node) {
        for (let current = node; current; current = current.parentNode || current.host) {
            if (current === ancestor) return true;
        }
        return false;
    }

    // Visible right now: on screen and not covered by something else (e.g. a cookie banner).
    function isUncovered(el, rect) {
        const x = Math.min(Math.max(rect.left + rect.width / 2, 0), viewportWidth - 1);
        const y = Math.min(Math.max(rect.top + rect.height / 2, 0), viewportHeight - 1);
        let top = document.elementFromPoint(x, y);
        while (top?.shadowRoot) {
            const inner = top.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === top) break;
            top = inner;
        }
        return !top || composedContains(el, top) || composedContains(top, el);
    }

    // Ids are per capture; drop the ones from the previous step so clicks cannot hit stale targets.
    for (const el of queryAllDeep(document, '[data-fg-id]')) el.removeAttribute('data-fg-id');

    const candidates = [];
    for (const el of queryAllDeep(document, SELECTOR)) {
        const rect = el.getBoundingClientRect();
        if (!isVisible(el, rect)) continue;
        if (rect.right <= 0 || rect.left >= viewportWidth) continue; // off-canvas menus etc.
        const onScreen = rect.top < viewportHeight && rect.bottom > 0;
        candidates.push({ el, rect, inViewport: onScreen && isUncovered(el, rect) });
    }

    // Prefer what is above the fold, then document order.
    candidates.sort((a, b) => Number(b.inViewport) - Number(a.inViewport));

    const elements = candidates.slice(0, maxElements).map(({ el, rect, inViewport }, index) => {
        const id = `e${index + 1}`;
        el.setAttribute('data-fg-id', id);
        return {
            id,
            role: role(el),
            name: accessibleName(el),
            href: el.getAttribute('href') || undefined,
            selector: cssPath(el),
            // Relative to the viewport, i.e. to this capture's screenshot.
            box: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            },
            inViewport,
        };
    });

    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxTextLength);

    // Only the text a visitor can read without scrolling, so personas cannot "see" below the fold.
    const roots = [document.body, ...queryAllDeep(document, '*').filter((node) => node.shadowRoot).map((node) => node.shadowRoot)];
    const range = document.createRange();
    const visibleParts = [];
    for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const value = node.textContent.replace(/\s+/g, ' ').trim();
            if (!value || !node.parentElement || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.parentElement.tagName)) continue;

            range.selectNodeContents(node);
            const rect = range.getBoundingClientRect();
            if (rect.bottom <= 0 || rect.top >= viewportHeight || rect.right <= 0 || rect.left >= viewportWidth) continue;
            if (!isVisible(node.parentElement, node.parentElement.getBoundingClientRect())) continue;
            if (!isUncovered(node.parentElement, rect)) continue; // e.g. behind a sticky "add to cart" bar

            if (visibleParts[visibleParts.length - 1] !== value) visibleParts.push(value);
        }
    }
    const visibleText = visibleParts.join('\n').slice(0, maxTextLength);

    return { elements, text, visibleText };
}

// Compact, LLM-readable listing of the registry, e.g. `[e3] button "Add to cart"`.
function describeElements(elements, { onlyInViewport = false } = {}) {
    return elements
        .filter((element) => !onlyInViewport || element.inViewport)
        .map((element) => {
            const name = element.name ? ` "${element.name}"` : '';
            const fold = element.inViewport ? '' : ' (not visible yet: below the fold or covered)';
            return `[${element.id}] ${element.role}${name}${fold}`;
        })
        .join('\n');
}

module.exports = { BrowserSession, closeBrowser, describeElements };
