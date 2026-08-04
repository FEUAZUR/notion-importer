import { Plugin, fetchSyncPost, showMessage } from "siyuan";
import { mount } from "svelte";
import "@/index.scss";

import ImportForm from "@/ImportForm.svelte";
import { svelteDialog } from "./libs/dialog";
import { setI18n, t } from "./libs/i18n";

const NOTION_CARD_SELECTOR = '.protyle-wysiwyg .sb[style*="--notion-importer-block-color-"]';
const NOTION_CARD_REF_SELECTOR = `${NOTION_CARD_SELECTOR} [data-type="block-ref"][data-subtype="d"]`;
const BLOCK_ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;

function decodeEmojiIcon(icon: string): string | null {
    if (!icon || icon.includes("/")) {
        return null;
    }

    try {
        return icon
            .split("-")
            .map((part) => String.fromCodePoint(parseInt(part, 16)))
            .join("");
    } catch {
        return null;
    }
}

function extractIconFromIAL(ial: string): string {
    const match = ial.match(/(?:^|\s)icon="([^"]+)"/);
    return match?.[1] || "";
}

function shouldDecorateBlockRef(ref: HTMLElement): boolean {
    const parent = ref.parentNode;
    if (!parent) {
        return false;
    }

    for (const node of Array.from(parent.childNodes)) {
        if (node === ref) {
            break;
        }
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
            return false;
        }
        if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).innerText.trim()) {
            return false;
        }
    }

    return true;
}

async function fetchDocIcons(ids: string[]): Promise<Map<string, string>> {
    const safeIDs = ids.filter((id) => BLOCK_ID_PATTERN.test(id));
    if (!safeIDs.length) {
        return new Map();
    }

    const quoted = safeIDs.map((id) => `'${id}'`).join(",");
    const response: any = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT id, ial FROM blocks WHERE type = 'd' AND id IN (${quoted})`,
    });
    const rows: Array<{ id: string; ial: string }> = response?.data ?? [];
    return new Map(rows.map((row) => [row.id, extractIconFromIAL(row.ial || "")]));
}

function applyRefIcon(ref: HTMLElement, icon: string) {
    ref.dataset.notionImporterDecorated = "true";
    if (!icon) {
        return;
    }

    const emoji = decodeEmojiIcon(icon);
    if (emoji) {
        ref.dataset.notionImporterDocIconKind = "emoji";
        ref.dataset.notionImporterDocIconText = emoji;
        return;
    }

    ref.dataset.notionImporterDocIconKind = "image";
    ref.style.setProperty("--notion-importer-doc-icon-image", `url("/emojis/${icon}")`);
}

async function decorateNotionRefs() {
    const refs = Array.from(document.querySelectorAll(NOTION_CARD_REF_SELECTOR)) as HTMLElement[];
    const undecorated = refs.filter((ref) => !ref.dataset.notionImporterDecorated && shouldDecorateBlockRef(ref));
    if (!undecorated.length) {
        return;
    }

    const ids = Array.from(new Set(undecorated.map((ref) => ref.getAttribute("data-id") || "").filter(Boolean)));
    const iconMap = await fetchDocIcons(ids);

    for (const ref of undecorated) {
        const id = ref.getAttribute("data-id") || "";
        applyRefIcon(ref, iconMap.get(id) || "");
    }
}

function installNotionRuntimeDecorators() {
    let disposed = false;
    let scheduled = false;
    let observer: MutationObserver | null = null;
    let intervalID = 0;

    const schedule = () => {
        if (disposed || scheduled) {
            return;
        }
        scheduled = true;
        window.setTimeout(async () => {
            scheduled = false;
            if (disposed) {
                return;
            }
            try {
                await decorateNotionRefs();
            } catch (error) {
                console.warn("Failed to decorate Notion refs", error);
            }
        }, 120);
    };

    observer = new MutationObserver(() => schedule());
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-id", "data-type", "style"],
    });

    intervalID = window.setInterval(() => schedule(), 1500);
    schedule();

    return () => {
        disposed = true;
        observer?.disconnect();
        observer = null;
        if (intervalID) {
            window.clearInterval(intervalID);
        }
    };
}

export default class NotionImporterPlugin extends Plugin {
    private cleanupNotionDecorators?: () => void;
    private openForm: { isRunning?: () => boolean; abort?: () => void } | null = null;

    async onload() {
        setI18n(this.i18n as unknown as Record<string, string>);

        this.addIcons(`
<symbol id="iconCYImportLine" viewBox="0 0 36 36">
  <path d="M28 4H14.87L8 10.86V15h2v-1.39h7.61V6H28v24H8a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm-12 8h-6v-.32L15.7 6h.3Z" class="clr-i-outline clr-i-outline-path-1"/>
  <path d="M11.94 26.28a1 1 0 1 0 1.41 1.41L19 22l-5.68-5.68a1 1 0 0 0-1.41 1.41L15.2 21H3a1 1 0 1 0 0 2h12.23Z" class="clr-i-outline clr-i-outline-path-2"/>
  <path fill="none" d="M0 0h36v36H0z"/>
</symbol>
`);

        this.addTopBar({
            icon: "iconCYImportLine",
            title: this.i18n.addTopBarIcon,
            position: "right",
            callback: () => this.showDialog(),
        });

        this.addCommand({
            langKey: "commandImport",
            callback: () => this.showDialog(),
        });

        this.cleanupNotionDecorators = installNotionRuntimeDecorators();
    }

    async onunload() {
        this.cleanupNotionDecorators?.();
        this.openForm?.abort?.();
        this.openForm = null;
    }

    private get isMobile(): boolean {
        return document.body.classList.contains("body--mobile");
    }

    private showDialog() {
        if (this.openForm?.isRunning?.()) {
            showMessage(t("importAlreadyRunning"), 3000, "error");
            return;
        }

        this.openForm = svelteDialog({
            title: this.i18n.dialogTitle,
            width: this.isMobile ? "92vw" : "800px",
            constructor: (container: HTMLElement) => mount(ImportForm, { target: container }),
            onDestroy: (component) => {
                // Without this the import keeps running, invisibly writing into the workspace.
                (component as { abort?: () => void }).abort?.();
                this.openForm = null;
            },
        });
    }
}
