<script lang="ts">
	import 'virtual:uno.css';
	import { KProgress } from '@ikun-ui/progress';
	import { tick } from 'svelte';
	import Notion from '@/imports/Notion.svelte';
	import FileInput from '@/FileInput.svelte';
	import { showMessage } from 'siyuan';

	// Import state
	type ImportPhase = 'idle' | 'collecting' | 'creating' | 'writing' | 'done';
	let phase: ImportPhase = 'idle';
	let progressCurrent = 0;
	let progressTotal = 100;
	let currentFile = '';
	let importing = false;

	// Logs
	let logs: Array<{ level: string; message: string; time: string }> = [];
	let logContainer: HTMLElement;

	// Stats
	let stats = { docs: 0, attachments: 0, databases: 0, errors: 0 };
	let errors: string[] = [];

	// File input
	let files: File[] = [];
	let notebookName = 'Notion';
	let importMode: 'replace' | 'incremental' = 'replace';

	// Show errors panel
	let showErrors = false;

	// Notion component reference
	let notionComponent: any;

	// Phase labels
	const phaseLabels = {
		collecting: 'phaseCollecting',
		creating: 'phaseCreating',
		writing: 'phaseWriting',
		done: 'phaseDone',
	};

	const phaseSteps = ['collecting', 'creating', 'writing', 'done'];

	function getPhaseIndex(p: string): number {
		return phaseSteps.indexOf(p);
	}

	async function addLog(entry: { level: string; message: string }) {
		const time = new Date().toLocaleTimeString('en-US', { hour12: false });
		logs = [...logs, { ...entry, time }];
		if (entry.level === 'error') {
			errors = [...errors, entry.message];
		}
		await tick();
		if (logContainer) {
			logContainer.scrollTop = logContainer.scrollHeight;
		}
	}

	// Event handlers from Notion component
	function handlePhaseChange(e) {
		const newPhase = e.detail.phase;
		if (phaseSteps.includes(newPhase)) {
			phase = newPhase as ImportPhase;
		}
	}

	function handleLogEntry(e) {
		addLog(e.detail);
	}

	function handleStatsUpdate(e) {
		stats = e.detail;
	}

	function handleCurrentItem(e) {
		currentFile = e.detail.name;
	}

	function handleImportComplete(e) {
		stats = e.detail;
		importing = false;
		phase = 'done';
	}

	function handleProgressChange(e) {
		progressCurrent = e.detail.current;
		progressTotal = e.detail.total;
	}

	async function onClickImport() {
		if (!files || files.length === 0) {
			showMessage(pluginInstance.i18n.pleaseSelectFile, 3000, 'error');
			return;
		}

		importing = true;
		phase = 'collecting';
		logs = [];
		errors = [];
		stats = { docs: 0, attachments: 0, databases: 0, errors: 0 };
		progressCurrent = 0;
		progressTotal = 100;
		currentFile = '';

		await notionComponent.startImport(files, notebookName, importMode);
	}

	$: progressPercent = progressTotal === 0 ? 0 : Math.min(100, Number((progressCurrent / progressTotal * 100).toFixed(1)));

	export let pluginInstance;
</script>

<Notion
	bind:this={notionComponent}
	on:phaseChange={handlePhaseChange}
	on:logEntry={handleLogEntry}
	on:statsUpdate={handleStatsUpdate}
	on:currentItem={handleCurrentItem}
	on:importComplete={handleImportComplete}
	on:progressChange={handleProgressChange}
/>

<div class="import-wizard">
	{#if phase === 'idle'}
		<!-- STATE: Initial -->
		<div class="section">
			<div class="section-header">
				<span class="section-label">{pluginInstance.i18n.selectFile}</span>
			</div>
			<FileInput
				bind:files
				accept_ext={['.zip']}
				labelText={pluginInstance.i18n.dropFileHere}
			/>
		</div>

		<div class="section">
			<div class="section-header">
				<span class="section-label">{pluginInstance.i18n.notebookName || 'Notebook Name'}</span>
			</div>
			<input
				class="b3-text-field"
				style="width: 100%;"
				type="text"
				bind:value={notebookName}
				placeholder="Notion"
			/>
		</div>

		<div class="section">
			<div class="section-header">
				<span class="section-label">{pluginInstance.i18n.importMode || 'Import Mode'}</span>
			</div>
			<div class="b3-form__checkbox">
				<label class="b3-form__checkbox-label">
					<input type="radio" bind:group={importMode} value="replace" />
					<span>{pluginInstance.i18n.replaceNotebook || 'Replace notebook'}</span>
				</label>
				<label class="b3-form__checkbox-label">
					<input type="radio" bind:group={importMode} value="incremental" />
					<span>{pluginInstance.i18n.incrementalImport || 'Incremental import'}</span>
				</label>
			</div>
		</div>

		<div class="divider"></div>

		<div class="actions">
			<button
				class="b3-button b3-button--text import-btn"
				disabled={!files || files.length === 0}
				on:click={onClickImport}
			>
				{pluginInstance.i18n.importButton}
			</button>
		</div>

	{:else if phase !== 'done'}
		<!-- STATE: Importing -->
		<div class="phase-indicator">
			{#each phaseSteps as step, i}
				<div class="phase-step" class:active={getPhaseIndex(phase) >= i} class:current={phase === step}>
					<div class="phase-dot">
						{#if getPhaseIndex(phase) > i}
							<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
						{:else}
							<span>{i + 1}</span>
						{/if}
					</div>
					<span class="phase-label">{pluginInstance.i18n[phaseLabels[step]] || step}</span>
				</div>
				{#if i < phaseSteps.length - 1}
					<div class="phase-line" class:active={getPhaseIndex(phase) > i}></div>
				{/if}
			{/each}
		</div>

		<div class="progress-section">
			<KProgress percentage={progressPercent}></KProgress>
			{#if currentFile}
				<div class="current-file">Processing: {currentFile}</div>
			{/if}
		</div>

		<div class="log-section">
			<div class="log-header">{pluginInstance.i18n.logSectionTitle}</div>
			<div class="log-container" bind:this={logContainer}>
				{#each logs as entry}
					<div class="log-entry log-{entry.level}">
						<span class="log-time">{entry.time}</span>
						<span class="log-level-icon">
							{#if entry.level === 'error'}●{:else if entry.level === 'warn'}●{:else}●{/if}
						</span>
						<span class="log-message">{entry.message}</span>
					</div>
				{/each}
			</div>
		</div>

		<div class="stats-bar">
			<div class="stat-item">
				<span class="stat-value">{stats.docs}</span>
				<span class="stat-label">{pluginInstance.i18n.docsImported}</span>
			</div>
			<div class="stat-item">
				<span class="stat-value">{stats.attachments}</span>
				<span class="stat-label">{pluginInstance.i18n.attachmentsUploaded}</span>
			</div>
			<div class="stat-item">
				<span class="stat-value">{stats.databases}</span>
				<span class="stat-label">{pluginInstance.i18n.databasesCreated}</span>
			</div>
			<div class="stat-item" class:has-errors={stats.errors > 0}>
				<span class="stat-value">{stats.errors}</span>
				<span class="stat-label">{pluginInstance.i18n.errorsCount}</span>
			</div>
		</div>

	{:else}
		<!-- STATE: Complete -->
		<div class="summary">
			<div class="summary-icon" class:success={errors.length === 0} class:warning={errors.length > 0}>
				{#if errors.length === 0}
					<svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
				{:else}
					<svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
				{/if}
			</div>

			<div class="summary-title">
				{#if errors.length === 0}
					{pluginInstance.i18n.importSuccess}
				{:else}
					{pluginInstance.i18n.importWithErrors} ({errors.length})
				{/if}
			</div>

			<div class="summary-stats">
				<div class="summary-stat">
					<span class="summary-stat-value">{stats.docs}</span>
					<span class="summary-stat-label">{pluginInstance.i18n.docsImported}</span>
				</div>
				<div class="summary-stat">
					<span class="summary-stat-value">{stats.attachments}</span>
					<span class="summary-stat-label">{pluginInstance.i18n.attachmentsUploaded}</span>
				</div>
				<div class="summary-stat">
					<span class="summary-stat-value">{stats.databases}</span>
					<span class="summary-stat-label">{pluginInstance.i18n.databasesCreated}</span>
				</div>
				<div class="summary-stat" class:has-errors={errors.length > 0}>
					<span class="summary-stat-value">{errors.length}</span>
					<span class="summary-stat-label">{pluginInstance.i18n.errorsCount}</span>
				</div>
			</div>

			{#if errors.length > 0}
				<div class="errors-section">
					<!-- svelte-ignore a11y-click-events-have-key-events -->
					<div class="errors-toggle" on:click={() => showErrors = !showErrors} role="button" tabindex="0">
						<span>{pluginInstance.i18n.errorsSectionTitle} ({errors.length})</span>
						<span class="toggle-arrow" class:open={showErrors}>▶</span>
					</div>
					{#if showErrors}
						<div class="errors-list">
							{#each errors as err, i}
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

	/* Sections */
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
	.section-hint {
		font-size: 12px;
		color: var(--b3-theme-on-surface, #888);
	}

	.divider {
		height: 1px;
		background: var(--b3-border-color, #e5e5e5);
		margin: 16px 0;
	}

	/* Actions */
	.actions {
		display: flex;
		justify-content: flex-end;
	}
	.import-btn {
		padding: 8px 24px;
		font-size: 14px;
	}
	.import-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* Phase indicator */
	.phase-indicator {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0;
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
		background: var(--b3-theme-surface, #f5f5f5);
		color: var(--b3-theme-on-surface, #888);
		border: 2px solid var(--b3-border-color, #ddd);
		transition: all 0.3s;
	}
	.phase-step.active .phase-dot {
		background: var(--b3-theme-primary, #4285f4);
		color: #fff;
		border-color: var(--b3-theme-primary, #4285f4);
	}
	.phase-step.current .phase-dot {
		box-shadow: 0 0 0 3px var(--b3-theme-primary-lighter, rgba(66, 133, 244, 0.3));
	}
	.phase-label {
		font-size: 11px;
		color: var(--b3-theme-on-surface, #888);
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
		background: var(--b3-border-color, #ddd);
		margin: 0 4px;
		margin-bottom: 24px;
		transition: background 0.3s;
	}
	.phase-line.active {
		background: var(--b3-theme-primary, #4285f4);
	}

	/* Progress */
	.progress-section {
		margin-bottom: 16px;
	}
	.current-file {
		font-size: 12px;
		color: var(--b3-theme-on-surface, #888);
		margin-top: 4px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Log panel */
	.log-section {
		margin-bottom: 12px;
	}
	.log-header {
		font-size: 12px;
		font-weight: 600;
		color: var(--b3-theme-on-surface, #888);
		margin-bottom: 6px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.log-container {
		max-height: 200px;
		overflow-y: auto;
		border: 1px solid var(--b3-border-color, #e5e5e5);
		border-radius: 6px;
		background: var(--b3-theme-surface, #fafafa);
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
		color: var(--b3-theme-on-surface, #999);
		flex-shrink: 0;
	}
	.log-level-icon {
		flex-shrink: 0;
		font-size: 8px;
		line-height: 18px;
	}
	.log-info .log-level-icon {
		color: var(--b3-theme-primary, #4285f4);
	}
	.log-warn .log-level-icon {
		color: #f0a020;
	}
	.log-error .log-level-icon {
		color: #e53935;
	}
	.log-error .log-message {
		color: #e53935;
	}
	.log-message {
		word-break: break-word;
	}

	/* Stats bar */
	.stats-bar {
		display: flex;
		justify-content: space-around;
		padding: 10px 0;
		border-top: 1px solid var(--b3-border-color, #e5e5e5);
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
	}
	.stat-label {
		font-size: 11px;
		color: var(--b3-theme-on-surface, #888);
	}
	.stat-item.has-errors .stat-value {
		color: #e53935;
	}

	/* Summary (done state) */
	.summary {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 20px 0;
		gap: 16px;
	}
	.summary-icon {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.summary-icon.success {
		color: #43a047;
	}
	.summary-icon.warning {
		color: #f0a020;
	}
	.summary-title {
		font-size: 16px;
		font-weight: 600;
		text-align: center;
	}
	.summary-stats {
		display: flex;
		gap: 24px;
		padding: 16px 0;
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
	}
	.summary-stat-label {
		font-size: 12px;
		color: var(--b3-theme-on-surface, #888);
	}
	.summary-stat.has-errors .summary-stat-value {
		color: #e53935;
	}

	/* Errors section */
	.errors-section {
		width: 100%;
		max-width: 500px;
	}
	.errors-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		cursor: pointer;
		padding: 8px 12px;
		border: 1px solid var(--b3-border-color, #e5e5e5);
		border-radius: 6px;
		font-size: 13px;
		font-weight: 500;
		color: #e53935;
		background: var(--b3-theme-surface, #fafafa);
	}
	.errors-toggle:hover {
		background: var(--b3-theme-background-light, #f0f0f0);
	}
	.toggle-arrow {
		transition: transform 0.2s;
		font-size: 10px;
	}
	.toggle-arrow.open {
		transform: rotate(90deg);
	}
	.errors-list {
		border: 1px solid var(--b3-border-color, #e5e5e5);
		border-top: none;
		border-radius: 0 0 6px 6px;
		max-height: 200px;
		overflow-y: auto;
		padding: 8px;
		background: var(--b3-theme-surface, #fafafa);
	}
	.error-item {
		display: flex;
		gap: 6px;
		padding: 4px 0;
		font-size: 12px;
		color: #e53935;
		border-bottom: 1px solid var(--b3-border-color, #eee);
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
