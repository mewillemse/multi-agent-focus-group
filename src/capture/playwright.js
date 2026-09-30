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

/**
 * Opens `url` and captures what a visitor sees before scrolling:
 * a JPEG screenshot, the visible text, and an element registry mapping
 * short ids (e1, e2, ...) to a selector and bounding box.
 */
async function capturePage({ url, device = 'desktop', outputDir, name = 'initial', acceptCookies = true }) {
    const profile = DEVICE_PROFILES[device] || DEVICE_PROFILES.desktop;
    const context = await newContext(profile);
    const page = await context.newPage();

    try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

        const cookieConsent = acceptCookies ? await acceptCookieBanner(page) : null;

        const { elements, text, visibleText } = await page.evaluate(extractPageModel, {
            maxElements: MAX_ELEMENTS,
            maxTextLength: MAX_TEXT_LENGTH,
        });

        await fs.mkdir(outputDir, { recursive: true });
        const screenshotFile = `${name}.jpg`;
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 75 });
        await fs.writeFile(path.join(outputDir, screenshotFile), screenshot);

        const status = response?.status() ?? null;

        return {
            requestedUrl: url,
            url: page.url(),
            status,
            blockedReason: detectBlock(status, elements),
            cookieConsent,
            title: await page.title(),
            device,
            viewport: page.viewportSize(),
            screenshotFile,
            screenshotBase64: screenshot.toString('base64'),
            text,
            visibleText,
            elements,
        };
    } finally {
        await context.close();
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
            box: {
                x: Math.round(rect.left + window.scrollX),
                y: Math.round(rect.top + window.scrollY),
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

module.exports = { capturePage, closeBrowser, describeElements };
