const illegalRe = /[\/\?<>\\:\*\|"]/g;
const controlRe = /[\x00-\x1f\x80-\x9f]/g;
const reservedRe = /^\.+$/;
const windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const windowsTrailingRe = /[\. ]+$/;
const startsWithDotRe = /^\./;
const badLinkRe = /[\[\]#|^]/g; // characters that break SiYuan links: [ ] # | ^

export const assetBaseDir = 'assets';

interface DomElementInfo {
    cls?: string | string[];
    text?: string | DocumentFragment;
    attr?: {
        [key: string]: string | number | boolean | null;
    };
    title?: string;
    parent?: Node;
    value?: string;
    type?: string;
    prepend?: boolean;
    placeholder?: string;
    href?: string;
}

/**
 * Notion appends cache-busting query strings to asset URLs (`icon.png?v=1616143238`).
 * Left in place they become part of the filename and break the extension.
 */
export function stripNotionQuerySuffix(name: string): string {
    return name.replace(/[?&][^/\\]*$/, '');
}

export function sanitizeFileName(name: string) {
    const cleaned = name
        .replace(illegalRe, '')
        .replace(controlRe, '')
        .replace(badLinkRe, '')
        .replace(/%/g, '') // would otherwise make decodeURI throw on names like "100% done.png"
        .replace(reservedRe, '')
        .replace(startsWithDotRe, '')
        // Must run last: stripping the characters above can expose a new trailing dot or space.
        .replace(windowsTrailingRe, '');

    // Prefix rather than blank out, so "CON.txt" does not become a zero-length name.
    return windowsReservedRe.test(cleaned) ? `_${cleaned}` : cleaned;
}

const DANGEROUS_TAGS = 'script,iframe,object,embed,link,meta,base,form';

/**
 * DOMParser produces an inert document, but this tree is later serialised into SiYuan
 * blocks that DO render. Strip active content once, at the single choke point, rather
 * than trusting every downstream transform.
 */
function sanitizeParsedDOM(root: Document): void {
    for (const node of Array.from(root.querySelectorAll(DANGEROUS_TAGS))) {
        node.remove();
    }
    for (const el of Array.from(root.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on')) {
                el.removeAttribute(attr.name);
                continue;
            }
            if ((name === 'href' || name === 'src' || name === 'xlink:href')
                && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) {
                el.removeAttribute(attr.name);
            }
        }
    }
}

export function parseHTML(html: string): HTMLElement {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    sanitizeParsedDOM(doc);
    return doc.documentElement;
}

export function HTMLElementfindAll(ele: HTMLElement, selector: string): HTMLElement[] {
    return Array.from(ele.querySelectorAll(selector)) as HTMLElement[];
}

export function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    o?: DomElementInfo | string,
    callback?: (el: HTMLElementTagNameMap[K]) => void
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);

    if (typeof o === 'string') {
        element.textContent = o;
    } else if (typeof o === 'object' && o !== null) {
        if (o.text !== undefined) {
            if (typeof o.text === 'string') {
                element.textContent = o.text;
            } else {
                element.appendChild(o.text);
            }
        }

        if (o.cls) {
            if (Array.isArray(o.cls)) {
                element.classList.add(...o.cls);
            } else {
                element.className = o.cls;
            }
        }

        if (o.attr) {
            for (const key in o.attr) {
                if (Object.prototype.hasOwnProperty.call(o.attr, key)) {
                    const value = o.attr[key];
                    if (value === null) {
                        element.removeAttribute(key);
                    } else {
                        element.setAttribute(key, String(value));
                    }
                }
            }
        }

        if (o.title) {
            element.title = o.title;
        }

        if (o.value) {
            (element as HTMLInputElement).value = o.value;
        }

        if (o.type) {
            (element as HTMLInputElement).type = o.type;
        }

        if (o.placeholder) {
            (element as HTMLInputElement).placeholder = o.placeholder;
        }

        if (o.href) {
            (element as HTMLAnchorElement).href = o.href;
        }

        if (o.parent) {
            if (o.prepend && o.parent.firstChild) {
                o.parent.insertBefore(element, o.parent.firstChild);
            } else {
                o.parent.appendChild(element);
            }
        }
    }

    if (typeof callback === 'function') {
        callback(element);
    }

    return element;
}

export function createSpan(o?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement {
    return createEl('span', o, callback) as HTMLSpanElement;
}

/** FNV-1a over 4 lanes: 32 hex chars, no dependency, adequate for asset naming. */
export function hashStringHex(input: string): string {
    const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
    const lanes = new Uint32Array(seeds);
    for (let i = 0; i < input.length; i += 1) {
        const code = input.charCodeAt(i);
        for (let lane = 0; lane < 4; lane += 1) {
            lanes[lane] = Math.imul(lanes[lane] ^ (code + lane), 0x01000193) >>> 0;
        }
    }
    return Array.from(lanes, (lane) => lane.toString(16).padStart(8, '0')).join('');
}

/** Content-addressed asset naming: identical bytes reuse one file regardless of source path. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
    const buffer = data instanceof Uint8Array
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
    const digest = await crypto.subtle.digest('SHA-256', buffer as ArrayBuffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randStr(length: number): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function localTimestamp(date: Date): string {
    const pad = (value: number, size = 2) => String(value).padStart(size, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
        + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const generatedIds = new Set<string>();

/**
 * SiYuan derives a block's creation time from the ID prefix using the kernel's LOCAL clock
 * (`time.Now().Format("20060102150405")`). Using toISOString() here shifted every imported
 * block by the UTC offset, corrupting the file tree's Created column and `ORDER BY id`.
 */
export function generateSiYuanID(): string {
    let id: string;
    do {
        id = `${localTimestamp(new Date())}-${randStr(7)}`;
    } while (generatedIds.has(id));
    generatedIds.add(id);
    return id;
}

export function clearSiYuanIDCache(): void {
    generatedIds.clear();
}
