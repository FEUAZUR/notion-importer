<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { runNotionImport } from '@/libs/formats/notion/siyuan-writer';
	import type { ImportLogLevel, ImportStats, NotionImportReporter } from '@/libs/formats/notion/notion-types';

	const dispatch = createEventDispatcher();

	let current = 0;
	let total = 100;
	let stats: ImportStats = { docs: 0, attachments: 0, databases: 0, errors: 0 };

	$: dispatch('progressChange', { current, total });

	const reporter: NotionImportReporter = {
		setPhase(phase: string) {
			dispatch('phaseChange', { phase });
		},
		log(level: ImportLogLevel, message: string) {
			dispatch('logEntry', { level, message });
		},
		updateProgress(nextCurrent: number, nextTotal: number) {
			current = nextCurrent;
			total = nextTotal;
		},
		setCurrentItem(name: string) {
			dispatch('currentItem', { name });
		},
		updateStats(nextStats: ImportStats) {
			stats = { ...nextStats };
			dispatch('statsUpdate', { ...stats });
		},
	};

	export async function startImport(files: FileList | File[], notebookName: string = 'Notion', importMode: 'replace' | 'incremental' = 'replace') {
		current = 0;
		total = 100;
		stats = { docs: 0, attachments: 0, databases: 0, errors: 0 };
		dispatch('statsUpdate', { ...stats });
		const finalStats = await runNotionImport(files, reporter, notebookName, importMode);
		dispatch('importComplete', finalStats);
	}
</script>
