<script lang="ts">
	import { tick } from 'svelte';
	import { showMessage } from 'siyuan';
	import FileInput from '@/FileInput.svelte';
	import { t } from '@/libs/i18n';
	import { runNotionImport } from '@/libs/formats/notion/siyuan-writer';
	import type {
		ImportLogLevel,
		ImportResult,
		ImportStats,
		NotionImportReporter,
	} from '@/libs/formats/notion/notion-types';

	type ImportPhase = 'idle' | 'collecting' | 'creating' | 'writing' | 'done';
	type LogEntry = { level: ImportLogLevel; message: string; time: string };

	// The DOM cost of the log list is unbounded otherwise: a large export emits tens of
	// thousands of lines and every append re-diffs the whole list.
	const MAX_VISIBLE_LOGS = 400;

	const PHASE_STEPS: ImportPhase[] = ['collecting', 'creating', 'writing', 'done'];
	const PHASE_LABELS: Record<string, string> = {
		collecting: 'phaseCollecting',
		creating: 'phaseCreating',
		writing: 'phaseWriting',
		done: 'phaseDone',
	};

	// Translations come from the module-level registry (libs/i18n) so the writer, which has
	// no component context, resolves the same dictionary.
	let phase = $state<ImportPhase>('idle');
	let progressCurrent = $state(0);
	let progressTotal = $state(0);
	let currentFile = $state('');
	let running = $state(false);
	let cancelling = $state(false);

	let logs = $state<LogEntry[]>([]);
	let totalLogCount = $state(0);
	let logContainer = $state<HTMLElement | null>(null);

	let stats = $state<ImportStats>({ docs: 0, attachments: 0, databases: 0, warnings: 0, errors: 0 });
	let errors = $state<string[]>([]);
	let result = $state<ImportResult | null>(null);
	let showErrors = $state(false);

	let files = $state<File[]>([]);
	let controller: AbortController | null = null;

	const progressPercent = $derived(
		progressTotal === 0 ? 0 : Math.min(100, Number(((progressCurrent / progressTotal) * 100).toFixed(1))),
	);
	const phaseIndex = $derived(PHASE_STEPS.indexOf(phase));

	function stamp(): string {
		// Locale-aware rather than the previous hardcoded en-US.
		return new Date().toLocaleTimeString(undefined, { hour12: false });
	}

	async function addLog(level: ImportLogLevel, message: string) {
		totalLogCount += 1;
		const next = logs.length >= MAX_VISIBLE_LOGS ? logs.slice(logs.length - MAX_VISIBLE_LOGS + 1) : logs.slice();
		next.push({ level, message, time: stamp() });
		logs = next;
		if (level === 'error') {
			errors = [...errors, message];
		}
		await tick();
		if (logContainer) {
			logContainer.scrollTop = logContainer.scrollHeight;
		}
	}

	const reporter: NotionImportReporter = {
		setPhase(next: string) {
			if ((PHASE_STEPS as string[]).includes(next)) {
				phase = next as ImportPhase;
			}
		},
		log(level: ImportLogLevel, message: string) {
			void addLog(level, message);
		},
		updateProgress(current: number, total: number) {
			progressCurrent = current;
			progressTotal = total;
		},
		setCurrentItem(name: string) {
			currentFile = name;
		},
		updateStats(next: ImportStats) {
			stats = { ...next };
		},
		get signal() {
			return controller?.signal;
		},
	};

	export function isRunning(): boolean {
		return running;
	}

	export function abort() {
		controller?.abort();
	}

	async function onClickImport() {
		if (running) {
			showMessage(t('importAlreadyRunning'), 3000, 'error');
			return;
		}
		if (!files.length) {
			showMessage(t('pleaseSelectFile'), 3000, 'error');
			return;
		}

		controller = new AbortController();
		running = true;
		cancelling = false;
		phase = 'collecting';
		logs = [];
		totalLogCount = 0;
		errors = [];
		result = null;
		showErrors = false;
		stats = { docs: 0, attachments: 0, databases: 0, warnings: 0, errors: 0 };
		progressCurrent = 0;
		progressTotal = 0;
		currentFile = '';

		try {
			result = await runNotionImport(files, reporter);
			stats = { ...result };
		} catch (error: unknown) {
			// runNotionImport handles its own failures; this only catches a throw before
			// its try block, which used to freeze the wizard at 0% forever.
			const message = error instanceof Error ? error.message : String(error);
			await addLog('error', t('logFatalError', message));
			result = { ...stats, errors: stats.errors + 1, outcome: 'failed', notebookName: '' };
		} finally {
			running = false;
			cancelling = false;
			controller = null;
			phase = 'done';
		}
	}

	function onClickCancel() {
		if (!running || cancelling) {
			return;
		}
		cancelling = true;
		controller?.abort();
	}

	const summaryKey = $derived(
		result?.outcome === 'cancelled'
			? 'importCancelled'
			: stats.errors > 0
				? 'importWithErrors'
				: stats.warnings > 0
					? 'importWithWarnings'
					: 'importSuccess',
	);
</script>

<div class="import-wizard">
	{#if phase === 'idle'}
		<div class="section">
			<div class="section-header">
				<span class="section-label">{t('selectFile')}</span>
			</div>
			<FileInput bind:files accept_ext={['.zip']} labelText={t('dropFileHere')} />
		</div>

		<div class="divider"></div>

		<div class="actions">
			<button class="b3-button b3-button--text import-btn" disabled={files.length === 0} onclick={onClickImport}>
				{t('importButton')}
			</button>
		</div>
	{:else if phase !== 'done'}
		<div class="phase-indicator">
			{#each PHASE_STEPS as step, i (step)}
				<div class="phase-step" class:active={phaseIndex >= i} class:current={phase === step}>
					<div class="phase-dot">
						{#if phaseIndex > i}
							<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"
								><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" /></svg
							>
						{:else}
							<span>{i + 1}</span>
						{/if}
					</div>
					<span class="phase-label">{t(PHASE_LABELS[step])}</span>
				</div>
				{#if i < PHASE_STEPS.length - 1}
					<div class="phase-line" class:active={phaseIndex > i}></div>
				{/if}
			{/each}
		</div>

		<div class="progress-section">
			<div
				class="progress-track"
				role="progressbar"
				aria-valuenow={progressPercent}
				aria-valuemin="0"
				aria-valuemax="100"
			>
				<div class="progress-fill" style:width="{progressPercent}%"></div>
			</div>
			<div class="progress-meta">
				<span class="progress-percent">{progressPercent}%</span>
				{#if currentFile}
					<span class="current-file">{t('processingPrefix')} {currentFile}</span>
				{/if}
			</div>
		</div>

		<div class="log-section">
			<div class="log-header">{t('logSectionTitle')}</div>
			<div class="log-container" bind:this={logContainer} role="log" aria-live="polite" aria-relevant="additions">
				{#if totalLogCount > logs.length}
					<div class="log-entry log-info"><span class="log-message">{t('logTruncated', totalLogCount)}</span></div>
				{/if}
				{#each logs as entry, i (i)}
					<div class="log-entry log-{entry.level}">
						<span class="log-time">{entry.time}</span>
						<span class="log-level-icon" aria-hidden="true">
							{#if entry.level === 'error'}✕{:else if entry.level === 'warn'}!{:else}●{/if}
						</span>
						<span class="log-message">{entry.message}</span>
					</div>
				{/each}
			</div>
		</div>

		<div class="stats-bar" role="status" aria-live="polite">
			<div class="stat-item">
				<span class="stat-value">{stats.docs}</span>
				<span class="stat-label">{t('docsImported')}</span>
			</div>
			<div class="stat-item">
				<span class="stat-value">{stats.attachments}</span>
				<span class="stat-label">{t('attachmentsUploaded')}</span>
			</div>
			<div class="stat-item">
				<span class="stat-value">{stats.databases}</span>
				<span class="stat-label">{t('databasesCreated')}</span>
			</div>
			<div class="stat-item" class:has-warnings={stats.warnings > 0}>
				<span class="stat-value">{stats.warnings}</span>
				<span class="stat-label">{t('warningsCount')}</span>
			</div>
			<div class="stat-item" class:has-errors={stats.errors > 0}>
				<span class="stat-value">{stats.errors}</span>
				<span class="stat-label">{t('errorsCount')}</span>
			</div>
		</div>

		<div class="actions">
			<button class="b3-button b3-button--cancel" onclick={onClickCancel} disabled={cancelling}>
				{cancelling ? t('cancelling') : t('cancelButton')}
			</button>
		</div>
	{:else}
		<div class="summary">
			<div
				class="summary-icon"
				class:success={stats.errors === 0 && result?.outcome === 'completed'}
				class:warning={stats.errors > 0 || result?.outcome !== 'completed'}
				aria-hidden="true"
			>
				{#if stats.errors === 0 && result?.outcome === 'completed'}
					<svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48"
						><path
							d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
						/></svg
					>
				{:else}
					<svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48"
						><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" /></svg
					>
				{/if}
			</div>

			<div class="summary-title">{t(summaryKey)}</div>
			{#if result?.notebookName}
				<div class="summary-notebook">{t('notebookCreatedAs', result.notebookName)}</div>
			{/if}

			<div class="summary-stats">
				<div class="summary-stat">
					<span class="summary-stat-value">{stats.docs}</span>
					<span class="summary-stat-label">{t('docsImported')}</span>
				</div>
				<div class="summary-stat">
					<span class="summary-stat-value">{stats.attachments}</span>
					<span class="summary-stat-label">{t('attachmentsUploaded')}</span>
				</div>
				<div class="summary-stat">
					<span class="summary-stat-value">{stats.databases}</span>
					<span class="summary-stat-label">{t('databasesCreated')}</span>
				</div>
				<div class="summary-stat" class:has-warnings={stats.warnings > 0}>
					<span class="summary-stat-value">{stats.warnings}</span>
					<span class="summary-stat-label">{t('warningsCount')}</span>
				</div>
				<div class="summary-stat" class:has-errors={stats.errors > 0}>
					<span class="summary-stat-value">{stats.errors}</span>
					<span class="summary-stat-label">{t('errorsCount')}</span>
				</div>
			</div>

			{#if errors.length > 0}
				<div class="errors-section">
					<button
						class="errors-toggle"
						onclick={() => (showErrors = !showErrors)}
						aria-expanded={showErrors}
						aria-controls="notion-importer-errors"
					>
						<span>{t('errorsSectionTitle')} ({errors.length})</span>
						<span class="toggle-arrow" class:open={showErrors} aria-hidden="true">▶</span>
					</button>
					{#if showErrors}
						<div class="errors-list" id="notion-importer-errors">
							{#each errors as err, i (i)}
								<div class="error-item">
									<span class="error-num">{i + 1}.</span>
									<span class="error-text">{err}</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.import-wizard {
		padding: 8px 0;
		font-family: var(--b3-font-family);
		color: var(--b3-theme-on-background);
	}

	.section {
		margin-bottom: 8px;
	}
	.section-header {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 8px;
	}
	.section-label {
		font-size: 14px;
		font-weight: 600;
	}

	.divider {
		height: 1px;
		background: var(--b3-border-color);
		margin: 16px 0;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.import-btn {
		padding: 8px 24px;
		font-size: 14px;
	}
	.import-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.phase-indicator {
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 20px;
		padding: 12px 0;
	}
	.phase-step {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		min-width: 80px;
	}
	.phase-dot {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 600;
		background: var(--b3-theme-surface);
		color: var(--b3-theme-on-surface);
		border: 2px solid var(--b3-border-color);
		transition: all 0.3s;
	}
	.phase-step.active .phase-dot {
		background: var(--b3-theme-primary);
		color: var(--b3-theme-on-primary);
		border-color: var(--b3-theme-primary);
	}
	.phase-step.current .phase-dot {
		box-shadow: 0 0 0 3px var(--b3-theme-primary-lighter);
	}
	.phase-label {
		font-size: 11px;
		color: var(--b3-theme-on-surface);
		text-align: center;
		white-space: nowrap;
	}
	.phase-step.active .phase-label {
		color: var(--b3-theme-on-background);
		font-weight: 500;
	}
	.phase-line {
		flex: 1;
		height: 2px;
		background: var(--b3-border-color);
		margin: 0 4px 24px;
		transition: background 0.3s;
	}
	.phase-line.active {
		background: var(--b3-theme-primary);
	}

	.progress-section {
		margin-bottom: 16px;
	}
	.progress-track {
		height: 8px;
		border-radius: 4px;
		background: var(--b3-theme-surface);
		overflow: hidden;
	}
	.progress-fill {
		height: 100%;
		background: var(--b3-theme-primary);
		transition: width 0.2s ease;
	}
	.progress-meta {
		display: flex;
		gap: 8px;
		align-items: baseline;
		margin-top: 4px;
		font-size: 12px;
		color: var(--b3-theme-on-surface);
	}
	.progress-percent {
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
	}
	.current-file {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.log-section {
		margin-bottom: 12px;
	}
	.log-header {
		font-size: 12px;
		font-weight: 600;
		color: var(--b3-theme-on-surface);
		margin-bottom: 6px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.log-container {
		max-height: 200px;
		overflow-y: auto;
		border: 1px solid var(--b3-border-color);
		border-radius: 6px;
		background: var(--b3-theme-surface);
		padding: 6px;
		font-family: var(--b3-font-family-code, monospace);
		font-size: 11px;
		line-height: 1.5;
	}
	.log-entry {
		display: flex;
		gap: 6px;
		padding: 1px 0;
	}
	.log-time {
		color: var(--b3-theme-on-surface);
		flex-shrink: 0;
	}
	.log-level-icon {
		flex-shrink: 0;
		width: 10px;
		text-align: center;
		font-size: 10px;
	}
	.log-info .log-level-icon {
		color: var(--b3-theme-primary);
	}
	.log-warn .log-level-icon,
	.log-warn .log-message {
		color: var(--b3-card-warning-color, #f0a020);
	}
	.log-error .log-level-icon,
	.log-error .log-message {
		color: var(--b3-card-error-color, #e53935);
	}
	.log-message {
		word-break: break-word;
	}

	.stats-bar {
		display: flex;
		justify-content: space-around;
		padding: 10px 0;
		border-top: 1px solid var(--b3-border-color);
		margin-bottom: 12px;
	}
	.stat-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}
	.stat-value {
		font-size: 18px;
		font-weight: 700;
		color: var(--b3-theme-on-background);
		font-variant-numeric: tabular-nums;
	}
	.stat-label {
		font-size: 11px;
		color: var(--b3-theme-on-surface);
	}
	.stat-item.has-warnings .stat-value {
		color: var(--b3-card-warning-color, #f0a020);
	}
	.stat-item.has-errors .stat-value {
		color: var(--b3-card-error-color, #e53935);
	}

	.summary {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 20px 0;
		gap: 12px;
	}
	.summary-icon {
		display: flex;
	}
	.summary-icon.success {
		color: var(--b3-card-success-color, #43a047);
	}
	.summary-icon.warning {
		color: var(--b3-card-warning-color, #f0a020);
	}
	.summary-title {
		font-size: 16px;
		font-weight: 600;
		text-align: center;
	}
	.summary-notebook {
		font-size: 12px;
		color: var(--b3-theme-on-surface);
	}
	.summary-stats {
		display: flex;
		gap: 24px;
		padding: 8px 0;
	}
	.summary-stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}
	.summary-stat-value {
		font-size: 22px;
		font-weight: 700;
		color: var(--b3-theme-on-background);
		font-variant-numeric: tabular-nums;
	}
	.summary-stat-label {
		font-size: 12px;
		color: var(--b3-theme-on-surface);
	}
	.summary-stat.has-warnings .summary-stat-value {
		color: var(--b3-card-warning-color, #f0a020);
	}
	.summary-stat.has-errors .summary-stat-value {
		color: var(--b3-card-error-color, #e53935);
	}

	.errors-section {
		width: 100%;
		max-width: 500px;
	}
	.errors-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		cursor: pointer;
		padding: 8px 12px;
		border: 1px solid var(--b3-border-color);
		border-radius: 6px;
		font-size: 13px;
		font-weight: 500;
		font-family: inherit;
		color: var(--b3-card-error-color, #e53935);
		background: var(--b3-theme-surface);
	}
	.errors-toggle:hover {
		background: var(--b3-theme-background-light);
	}
	.toggle-arrow {
		transition: transform 0.2s;
		font-size: 10px;
	}
	.toggle-arrow.open {
		transform: rotate(90deg);
	}
	.errors-list {
		border: 1px solid var(--b3-border-color);
		border-top: none;
		border-radius: 0 0 6px 6px;
		max-height: 200px;
		overflow-y: auto;
		padding: 8px;
		background: var(--b3-theme-surface);
	}
	.error-item {
		display: flex;
		gap: 6px;
		padding: 4px 0;
		font-size: 12px;
		color: var(--b3-card-error-color, #e53935);
		border-bottom: 1px solid var(--b3-border-color);
	}
	.error-item:last-child {
		border-bottom: none;
	}
	.error-num {
		flex-shrink: 0;
		font-weight: 600;
	}
	.error-text {
		word-break: break-word;
	}
</style>
