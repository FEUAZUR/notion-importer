<script lang="ts">
    let {
        files = $bindable<File[]>([]),
        accept_ext = [] as string[],
        disabled = false,
        labelText = '',
    } = $props();

    let dragOver = $state(false);
    let fileInput = $state<HTMLInputElement | null>(null);

    function accepted(candidates: File[]): File[] {
        if (!accept_ext.length) {
            return candidates;
        }
        return candidates.filter((f) => accept_ext.some((ext) => f.name.toLowerCase().endsWith(ext)));
    }

    function handleFileChange(event: Event) {
        const input = event.target as HTMLInputElement;
        files = Array.from(input.files ?? []);
    }

    function handleDrop(event: DragEvent) {
        event.preventDefault();
        dragOver = false;
        if (disabled) return;
        files = accepted(Array.from(event.dataTransfer?.files ?? []));
        if (fileInput && files.length > 0) {
            const dt = new DataTransfer();
            files.forEach((f) => dt.items.add(f));
            fileInput.files = dt.files;
        }
    }

    function handleDragOver(event: DragEvent) {
        event.preventDefault();
        if (!disabled) dragOver = true;
    }

    function openPicker() {
        if (!disabled && fileInput) fileInput.click();
    }

    function formatSize(bytes: number): string {
        // Intl keeps the decimal separator correct for the user's locale.
        const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
        if (bytes < 1024) return `${nf.format(bytes)} B`;
        if (bytes < 1024 * 1024) return `${nf.format(bytes / 1024)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${nf.format(bytes / (1024 * 1024))} MB`;
        return `${nf.format(bytes / (1024 * 1024 * 1024))} GB`;
    }
</script>

<button
    type="button"
    class="file-drop-zone"
    class:drag-over={dragOver}
    class:has-file={files.length > 0}
    {disabled}
    aria-label={labelText}
    ondrop={handleDrop}
    ondragover={handleDragOver}
    ondragleave={() => (dragOver = false)}
    onclick={openPicker}
>
    {#if files.length > 0}
        <div class="file-info">
            <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
            </svg>
            <div class="file-details">
                <span class="file-name">{files[0].name}</span>
                <span class="file-size">{formatSize(files[0].size)}</span>
            </div>
        </div>
    {:else}
        <div class="drop-prompt">
            <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span class="drop-text">{labelText}</span>
        </div>
    {/if}
</button>

<input
    bind:this={fileInput}
    class="fn__none"
    type="file"
    tabindex="-1"
    aria-hidden="true"
    accept={accept_ext.join(',')}
    onchange={handleFileChange}
    {disabled}
/>

<style>
    .file-drop-zone {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        border: 2px dashed var(--b3-border-color);
        border-radius: 8px;
        padding: 24px 16px;
        cursor: pointer;
        transition: all 0.2s ease;
        background: var(--b3-theme-background);
        font-family: inherit;
        min-height: 80px;
    }

    .file-drop-zone:hover:not(:disabled),
    .file-drop-zone:focus-visible {
        border-color: var(--b3-theme-primary);
        background: var(--b3-theme-surface);
    }

    .file-drop-zone.drag-over {
        border-color: var(--b3-theme-primary);
        background: var(--b3-theme-primary-lighter);
        border-style: solid;
    }

    .file-drop-zone:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .file-drop-zone.has-file {
        border-style: solid;
        border-color: var(--b3-theme-primary);
    }

    .drop-prompt {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        color: var(--b3-theme-on-surface);
    }

    .upload-icon {
        width: 32px;
        height: 32px;
        opacity: 0.6;
    }

    .drop-text {
        font-size: 13px;
    }

    .file-info {
        display: flex;
        align-items: center;
        gap: 12px;
        color: var(--b3-theme-on-background);
    }

    .file-icon {
        width: 24px;
        height: 24px;
        color: var(--b3-theme-primary);
        flex-shrink: 0;
    }

    .file-details {
        display: flex;
        flex-direction: column;
        gap: 2px;
        text-align: left;
    }

    .file-name {
        font-size: 13px;
        font-weight: 500;
        word-break: break-all;
    }

    .file-size {
        font-size: 12px;
        color: var(--b3-theme-on-surface);
    }
</style>
