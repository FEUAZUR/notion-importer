import { Client } from '@siyuan-community/siyuan-sdk';
import { showMessage } from 'siyuan';
import { WebPickedFile } from '../../filesystem.js';
import { clearSiYuanIDCache, generateSiYuanID, parseHTML } from '../../util.js';
import { applyInlineStyleMarkersToBlockDOM, readToMarkdown } from './convert-to-md.js';
import { collectNotionExport } from './export-parser.js';
import { buildSiYuanWritePlan } from './notion-normalizer.js';
import type { ImportStats, NotionImportReporter, NotionWritePlanDocument, SiYuanWritePlan } from './notion-types.js';

type ImportMode = 'replace' | 'incremental';

const CONCURRENCY = 8;

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const current = cursor++;
			await fn(items[current]);
		}
	}
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
	await Promise.all(workers);
}

async function getExistingPageTitles(client: Client, notebookId: string): Promise<Set<string>> {
	const titles = new Set<string>();
	try {
		const res = await client.sql({
			stmt: `SELECT content FROM blocks WHERE box='${notebookId}' AND type='d' AND content != ''`,
		});
		if (res?.data) {
			for (const row of res.data) {
				if (row.content) {
					titles.add(row.content.trim());
				}
			}
		}
	} catch (error) {
		console.warn('Failed to get existing page titles:', error);
	}
	return titles;
}

async function ensureNotebook(client: Client, reporter: NotionImportReporter, notebookName: string, importMode: ImportMode = 'replace') {
	const listRes = await client.lsNotebooks({});
	const existing = listRes?.data?.notebooks?.find((notebook: any) => notebook.name === notebookName);
	if (existing) {
		if (importMode === 'incremental') {
			reporter.log('info', `Using existing notebook: ${notebookName}`);
			return existing.id as string;
		}
		reporter.log('info', `Replacing existing notebook: ${notebookName}`);
		const removeRes = await client.removeNotebook({ notebook: existing.id as string });
		if (removeRes.code !== 0) {
			throw new Error(`Failed to replace notebook "${notebookName}": ${removeRes.msg}`);
		}
	}

	const createRes = await client.createNotebook({ name: notebookName });
	if (createRes.code !== 0) {
		throw new Error(`Failed to create notebook "${notebookName}": ${createRes.msg}`);
	}
	reporter.log('info', `Created notebook: ${notebookName}`);
	return createRes.data.notebook.id as string;
}

function buildParentCount(plan: SiYuanWritePlan) {
	const parentCount = new Map<string, number>();
	for (const document of plan.documents) {
		document.fileInfo.parentIds.forEach((parentID) => {
			parentCount.set(parentID, (parentCount.get(parentID) ?? 0) + 1);
		});
	}
	return parentCount;
}

async function resolvePageIcon(client: Client, reporter: NotionImportReporter, pageIcon: string) {
	if (!pageIcon.startsWith('assets/')) {
		return pageIcon;
	}

	try {
		const iconTarget = pageIcon.replace(/^assets\//, 'notion-importer/');
		const response = await fetch('/api/file/getFile', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: `/data/${pageIcon}` }),
		});
		if (!response.ok) {
			reporter.log('warn', `Could not read uploaded icon asset "${pageIcon}"`);
			return '';
		}
		const blob = await response.blob();
		const fileName = iconTarget.split('/').pop() || 'icon.png';
		const putRes = await client.putFile({
			file: new File([blob], fileName, { type: blob.type || 'application/octet-stream' }),
			path: `/data/emojis/${iconTarget}`,
		});
		if (putRes.code !== 0) {
			reporter.log('warn', `Could not copy icon to emojis directory: ${putRes.msg}`);
			return '';
		}
		return iconTarget;
	} catch (error: any) {
		reporter.log('warn', `Could not resolve image icon "${pageIcon}": ${error?.message || error}`);
		return '';
	}
}

function getAuthHeaders() {
	const token = (window as any).siyuan?.config?.api?.token ?? '';
	return token ? { Authorization: `Token ${token}` } : {};
}

async function apiJson(url: string, body: object) {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
		body: JSON.stringify(body),
	});
	return response.json();
}

async function sqlQuery<T = any>(stmt: string): Promise<T[]> {
	const response = await apiJson('/api/query/sql', { stmt });
	return response?.data ?? [];
}

function parseAttributeViewID(markdown: string) {
	const match = markdown.match(/data-av-id="([^"]+)"/);
	return match?.[1] ?? '';
}

async function applyAttributeViewBlockViews(
	client: Client,
	reporter: NotionImportReporter,
	rootBlockID: string,
	attributeViewBlocks: Array<{ avID: string; viewID?: string }>,
) {
	const placements = attributeViewBlocks.filter((item) => item.viewID);
	if (!placements.length) {
		return;
	}

	let avBlocks: Array<{ id: string; markdown: string }> = [];
	for (let attempt = 0; attempt < 10; attempt += 1) {
		avBlocks = await sqlQuery(
			`SELECT id, markdown FROM blocks WHERE root_id='${rootBlockID}' AND type='av' ORDER BY sort`,
		);
		const availableMatches = avBlocks.filter((block) => placements.some((item) => parseAttributeViewID(block.markdown) === item.avID));
		if (availableMatches.length >= placements.length) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 400));
	}

	let cursor = 0;
	const attrPromises: Promise<any>[] = [];
	for (const placement of placements) {
		while (cursor < avBlocks.length && parseAttributeViewID(avBlocks[cursor].markdown) !== placement.avID) {
			cursor += 1;
		}
		if (cursor >= avBlocks.length) {
			reporter.log('warn', `Could not bind database view "${placement.viewID}" for AV "${placement.avID}" in document ${rootBlockID}`);
			continue;
		}
		attrPromises.push(client.setBlockAttrs({
			attrs: { 'custom-sy-av-view': placement.viewID! },
			id: avBlocks[cursor].id,
		}));
		cursor += 1;
	}

	if (attrPromises.length > 0) {
		await Promise.all(attrPromises);
	}
}

async function replaceDocumentChildrenWithBlockDOM(rootBlockID: string, blockDOM: string) {
	const existingChildren = await sqlQuery<{ id: string }>(
		`SELECT id FROM blocks WHERE parent_id='${rootBlockID}' ORDER BY sort`,
	);
	for (const child of existingChildren) {
		await apiJson('/api/block/deleteBlock', { id: child.id });
	}

	const dom = parseHTML(blockDOM);
	const topLevelBlocks = Array.from(dom.body?.children || [])
		.map((node) => (node as HTMLElement).outerHTML)
		.filter(Boolean);
	const chunks = topLevelBlocks.length
		? Array.from({ length: Math.ceil(topLevelBlocks.length / 24) }, (_, index) =>
			topLevelBlocks.slice(index * 24, (index + 1) * 24).join(''))
		: [blockDOM];

	let lastRes: any = { code: 0, msg: '' };
	for (const chunk of chunks) {
		lastRes = await apiJson('/api/block/appendBlock', {
			dataType: 'dom',
			data: chunk,
			parentID: rootBlockID,
		});
		if (lastRes.code !== 0) {
			return lastRes;
		}
	}

	return lastRes;
}

function extractMarkdownFromResidualHtmlBlock(content: string) {
	if (!content) {
		return '';
	}

	const dom = parseHTML(content);
	const codeBlock = dom.querySelector('code[data-type="yaml-front-matter"], pre > code');
	return (codeBlock?.textContent || dom.body?.textContent || '')
		.replace(/\u200b/g, '')
		.replace(/\r\n/g, '\n')
		.trim();
}

async function writeDocumentContent(
	client: Client,
	reporter: NotionImportReporter,
	document: NotionWritePlanDocument,
	plan: SiYuanWritePlan,
	markdownCache: Map<string, Awaited<ReturnType<typeof readToMarkdown>>>,
	uploadedAttributeViewIDs: Set<string>,
	stats: ImportStats,
) {
	const markdownInfo =
		markdownCache.get(document.notionID) ||
		await readToMarkdown(plan.registry.resolverInfo, document.entry, document.notionID);

	for (const av of markdownInfo.attributeViews) {
		if (uploadedAttributeViewIDs.has(av.id)) {
			continue;
		}
		const blob = new Blob([JSON.stringify(av)], { type: 'application/json' });
		const putRes = await client.putFile({
			file: new File([blob], 'data.json', { type: 'application/json' }),
			path: `/data/storage/av/${av.id}.json`,
		});
		if (putRes.code !== 0) {
			reporter.log('error', `Failed to upload database "${av.id}": ${putRes.msg}`);
			stats.errors += 1;
		} else {
			uploadedAttributeViewIDs.add(av.id);
			stats.databases += 1;
			reporter.updateStats({ ...stats });
		}
	}

	const hasInlineStyles =
		(markdownInfo.inlineStyleMarkers && Object.keys(markdownInfo.inlineStyleMarkers).length > 0) ||
		/SYINLINESTYLE(?:\\_)?/.test(markdownInfo.content);
	const updateRes = hasInlineStyles
		? await replaceDocumentChildrenWithBlockDOM(
			document.fileInfo.blockID,
			applyInlineStyleMarkersToBlockDOM(window.Lute.New().Md2BlockDOM(markdownInfo.content), markdownInfo.inlineStyleMarkers),
		)
		: await client.updateBlock({
			data: markdownInfo.content,
			dataType: 'markdown',
			id: document.fileInfo.blockID,
		});
	if (updateRes.code !== 0) {
		throw new Error(`Failed to write content for "${document.fileInfo.title}": ${updateRes.msg}`);
	}

	const attrPromises: Promise<any>[] = [];
	if (markdownInfo.coverImage) {
		const cssURL = /^https?:\/\//i.test(markdownInfo.coverImage)
			? `url("${markdownInfo.coverImage}")`
			: `url("/${markdownInfo.coverImage}")`;
		attrPromises.push(client.setBlockAttrs({
			attrs: {
				'title-img': `background-image: ${cssURL}; background-position: center; background-size: cover; background-repeat: no-repeat;`,
			},
			id: document.fileInfo.blockID,
		}));
	}
	if (markdownInfo.pageIcon) {
		const resolvedIcon = await resolvePageIcon(client, reporter, markdownInfo.pageIcon);
		const finalIcon = resolvedIcon || markdownInfo.pageIcon;
		attrPromises.push(client.setBlockAttrs({
			attrs: { icon: finalIcon },
			id: document.fileInfo.blockID,
		}));
	}
	if (document.fileInfo.displayTitle && document.fileInfo.displayTitle !== document.fileInfo.title) {
		attrPromises.push(client.setBlockAttrs({
			attrs: { title: document.fileInfo.displayTitle },
			id: document.fileInfo.blockID,
		}));
	}

	for (const av of markdownInfo.attributeViews) {
		for (const keyValue of av.keyValues) {
			if (keyValue.key.type !== 'block') {
				continue;
			}
			for (const rowValue of keyValue.values) {
				if (rowValue?.isDetached) {
					continue;
				}
				attrPromises.push(client.setBlockAttrs({
					attrs: { 'custom-avs': av.id },
					id: rowValue.block.id,
				}));
			}
		}
	}

	if (attrPromises.length > 0) {
		await Promise.all(attrPromises);
	}

	await applyAttributeViewBlockViews(
		client,
		reporter,
		document.fileInfo.blockID,
		markdownInfo.attributeViewBlocks,
	);

	return (markdownInfo.content.match(/SYFOLDFOLDSTART/g) ?? []).length;
}

async function fixFoldBlocks(
	reporter: NotionImportReporter,
	notebookIDs: string[],
	expectedFolds: number,
) {
	if (!notebookIDs.length || expectedFolds === 0) {
		return 0;
	}

	let sqlEndpoint = '/api/query/sql';
	try {
		const probe = await fetch('/api/query/sql', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
			body: JSON.stringify({ stmt: 'SELECT 1' }),
		});
		if (!probe.ok) {
			sqlEndpoint = '/api/sql';
		}
	} catch {
		sqlEndpoint = '/api/sql';
	}

	async function api(url: string, body: object) {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
			body: JSON.stringify(body),
		});
		return response.json();
	}

	async function sql(stmt: string) {
		return (await api(sqlEndpoint, { stmt }))?.data || [];
	}

	const boxList = notebookIDs.map((id) => `'${id}'`).join(',');
	const startedAt = Date.now();
	const maxWaitMs = 300_000;
	let lastCount = -1;
	let stablePolls = 0;
	let foldParas: Array<{ id: string; parent_id: string }> = [];

	while (true) {
		foldParas = await sql(`SELECT id, parent_id FROM blocks WHERE box IN (${boxList}) AND type = 'p' AND content = 'SYFOLDFOLDSTART'`);
		if (foldParas.length >= expectedFolds) {
			break;
		}
		if (foldParas.length === lastCount) {
			stablePolls += 1;
			if (stablePolls >= 2 && foldParas.length > 0) {
				break;
			}
		} else {
			lastCount = foldParas.length;
			stablePolls = 0;
		}
		if (Date.now() - startedAt >= maxWaitMs) {
			reporter.log('warn', `Timed out waiting for fold markers (${foldParas.length}/${expectedFolds})`);
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}

	let totalFixed = 0;
	for (let round = 0; round < 10; round += 1) {
		if (!foldParas.length) {
			break;
		}
		let fixedThisRound = 0;
		for (const fold of foldParas) {
			try {
				const siblings: Array<{ id: string; content: string }> = await sql(
					`SELECT id, content FROM blocks WHERE parent_id='${fold.parent_id}' ORDER BY sort LIMIT 500`,
				);
				const foldIndex = siblings.findIndex((item) => item.id === fold.id);
				if (foldIndex < 0) {
					continue;
				}

				let depth = 1;
				const contentIDs: string[] = [];
				let closeID: string | null = null;
				for (let index = foldIndex + 1; index < siblings.length; index += 1) {
					const item = siblings[index];
					if (item.content === 'SYFOLDFOLDSTART') {
						depth += 1;
					} else if (item.content === 'SYFOLDFOLDEND') {
						depth -= 1;
						if (depth === 0) {
							closeID = item.id;
							break;
						}
					}
					if (depth > 0) {
						contentIDs.push(item.id);
					}
				}

				if (!closeID) {
					await api('/api/block/deleteBlock', { id: fold.id });
					fixedThisRound += 1;
					continue;
				}

				if (contentIDs.length === 0) {
					await api('/api/block/deleteBlock', { id: fold.id });
					await api('/api/block/deleteBlock', { id: closeID });
					fixedThisRound += 1;
					continue;
				}

				const foldBlockID = generateSiYuanID();
				const dummyID = generateSiYuanID();
				const foldDOM = `<div data-node-id="${foldBlockID}" data-type="NodeSuperBlock" class="sb" data-sb-layout="fold"><div data-node-id="${dummyID}" data-type="NodeParagraph" class="p"><div contenteditable="true">&#8203;</div><div class="protyle-attr" contenteditable="false">&#8203;</div></div></div>`;

				const insertRes = await api('/api/block/insertBlock', {
					dataType: 'dom',
					data: foldDOM,
					previousID: closeID,
				});
				if (insertRes.code !== 0) {
					continue;
				}

				let previousID = dummyID;
				let moveFailed = false;
				for (const contentID of contentIDs) {
					const moveRes = await api('/api/block/moveBlock', {
						id: contentID,
						previousID,
						parentID: foldBlockID,
					});
					if (moveRes.code !== 0) {
						moveFailed = true;
						break;
					}
					previousID = contentID;
				}
				if (moveFailed) {
					continue;
				}

				await api('/api/block/deleteBlock', { id: dummyID });
				await api('/api/block/deleteBlock', { id: fold.id });
				await api('/api/block/deleteBlock', { id: closeID });
				fixedThisRound += 1;
			} catch (error: any) {
				reporter.log('warn', `Failed to fix toggle block ${fold.id}: ${error?.message || error}`);
			}
		}

		totalFixed += fixedThisRound;
		if (fixedThisRound === 0) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 3000));
		foldParas = await sql(`SELECT id, parent_id FROM blocks WHERE box IN (${boxList}) AND type = 'p' AND content = 'SYFOLDFOLDSTART'`);
	}

	const staleEnds: Array<{ id: string }> = await sql(`SELECT id FROM blocks WHERE box IN (${boxList}) AND type = 'p' AND content = 'SYFOLDFOLDEND'`);
	for (const block of staleEnds) {
		await api('/api/block/deleteBlock', { id: block.id });
	}
	const staleStarts: Array<{ id: string }> = await sql(`SELECT id FROM blocks WHERE box IN (${boxList}) AND type = 'p' AND content = 'SYFOLDFOLDSTART'`);
	for (const block of staleStarts) {
		await api('/api/block/deleteBlock', { id: block.id });
	}

	return totalFixed;
}

async function fixInlineStyleBlocks(
	reporter: NotionImportReporter,
	notebookIDs: string[],
) {
	if (!notebookIDs.length) {
		return 0;
	}

	const boxList = notebookIDs.map((id) => `'${id}'`).join(',');
	let totalFixed = 0;

	for (let round = 0; round < 5; round += 1) {
		const inlineBlocks: Array<{ id: string }> = await sqlQuery(
			`SELECT id FROM blocks WHERE box IN (${boxList}) AND (markdown LIKE '%SYINLINESTYLE_%' OR content LIKE '%SYINLINESTYLE_%') LIMIT 5000`,
		);
		if (!inlineBlocks.length) {
			break;
		}

		let fixedThisRound = 0;
		for (const block of inlineBlocks) {
			try {
				const domRes = await apiJson('/api/block/getBlockDOM', { id: block.id });
				const blockDOM = domRes?.data?.dom;
				if (!blockDOM || typeof blockDOM !== 'string') {
					continue;
				}

				const convertedDOM = applyInlineStyleMarkersToBlockDOM(blockDOM);
				if (convertedDOM === blockDOM || convertedDOM.includes('SYINLINESTYLE_')) {
					continue;
				}

				const updateRes = await apiJson('/api/block/updateBlock', {
					dataType: 'dom',
					data: convertedDOM,
					id: block.id,
				});
				if (updateRes.code === 0) {
					fixedThisRound += 1;
				}
			} catch (error: any) {
				reporter.log('warn', `Failed to fix inline style block ${block.id}: ${error?.message || error}`);
			}
		}

		totalFixed += fixedThisRound;
		if (fixedThisRound === 0) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	return totalFixed;
}

function normalizeNativeInlineHighlightDOM(blockDOM: string) {
	const dom = parseHTML(blockDOM);
	let changed = false;

	for (const span of Array.from(dom.querySelectorAll('span[data-type="text"][style*="background-color: var(--b3-font-background"]'))) {
		const htmlSpan = span as HTMLElement;
		const style = htmlSpan.getAttribute('style') || '';
		if (!style) {
			continue;
		}

		const bgMatch = style.match(/background-color:\s*(var\(--b3-font-background\d+\))/);
		if (!bgMatch) {
			continue;
		}

		const declarations = style
			.split(';')
			.map((part) => part.trim())
			.filter(Boolean)
			.filter((part) => !part.startsWith('font-size:'));
		const backgroundValue = bgMatch[1];
		if (!declarations.some((part) => part.startsWith('--b3-parent-background:'))) {
			declarations.push(`--b3-parent-background: ${backgroundValue}`);
		}

		const normalizedStyle = `${declarations.join('; ')};`;
		if (normalizedStyle !== style) {
			htmlSpan.setAttribute('style', normalizedStyle);
			changed = true;
		}
	}

	return changed ? dom.querySelector('body')?.innerHTML ?? blockDOM : blockDOM;
}

async function normalizeNativeInlineHighlights(
	reporter: NotionImportReporter,
	notebookIDs: string[],
) {
	if (!notebookIDs.length) {
		return 0;
	}

	const boxList = notebookIDs.map((id) => `'${id}'`).join(',');
	const nativeHighlightBlocks: Array<{ id: string }> = await sqlQuery(
		`SELECT id FROM blocks WHERE box IN (${boxList}) AND markdown LIKE '%font-size: 16px; background-color: var(--b3-font-background%' LIMIT 5000`,
	);
	if (!nativeHighlightBlocks.length) {
		return 0;
	}

	let normalizedBlocks = 0;
	for (const block of nativeHighlightBlocks) {
		try {
			const domRes = await apiJson('/api/block/getBlockDOM', { id: block.id });
			const blockDOM = domRes?.data?.dom;
			if (!blockDOM || typeof blockDOM !== 'string') {
				continue;
			}

			const normalizedDOM = normalizeNativeInlineHighlightDOM(blockDOM);
			if (normalizedDOM === blockDOM) {
				continue;
			}

			const updateRes = await apiJson('/api/block/updateBlock', {
				dataType: 'dom',
				data: normalizedDOM,
				id: block.id,
			});
			if (updateRes.code === 0) {
				normalizedBlocks += 1;
			}
		} catch (error: any) {
			reporter.log('warn', `Failed to normalize native inline highlight ${block.id}: ${error?.message || error}`);
		}
	}

	return normalizedBlocks;
}

async function rebuildResidualHtmlDocuments(
	reporter: NotionImportReporter,
	notebookIDs: string[],
) {
	if (!notebookIDs.length) {
		return 0;
	}

	const boxList = notebookIDs.map((id) => `'${id}'`).join(',');
	const htmlBlocks: Array<{ root_id: string; content: string }> = await sqlQuery(
		`SELECT root_id, content FROM blocks WHERE box IN (${boxList}) AND type = 'html' AND content LIKE '%SYINLINESTYLE_%' LIMIT 5000`,
	);
	if (!htmlBlocks.length) {
		return 0;
	}

	let rebuiltDocuments = 0;
	const htmlByRoot = new Map<string, string>();
	for (const block of htmlBlocks) {
		if (!htmlByRoot.has(block.root_id)) {
			htmlByRoot.set(block.root_id, block.content);
		}
	}

	for (const [rootID, content] of htmlByRoot) {
		try {
			const markdown = extractMarkdownFromResidualHtmlBlock(content);
			if (!markdown || !/SYINLINESTYLE(?:\\_)?/.test(markdown)) {
				continue;
			}

			const blockDOM = applyInlineStyleMarkersToBlockDOM(window.Lute.New().Md2BlockDOM(markdown));
			if (!blockDOM || /SYINLINESTYLE(?:\\_)?/.test(blockDOM)) {
				continue;
			}

			const replaceRes = await replaceDocumentChildrenWithBlockDOM(rootID, blockDOM);
			if (replaceRes.code === 0) {
				rebuiltDocuments += 1;
			}
		} catch (error: any) {
			reporter.log('warn', `Failed to rebuild residual HTML document ${rootID}: ${error?.message || error}`);
		}
	}

	return rebuiltDocuments;
}

export async function runNotionImport(
	files: FileList | File[],
	reporter: NotionImportReporter,
	notebookName: string = 'Notion',
	importMode: ImportMode = 'replace',
) {
	clearSiYuanIDCache();
	const stats: ImportStats = { docs: 0, attachments: 0, databases: 0, errors: 0 };
	const client = new Client({});
	const pickedFiles = Array.from(files).map((file) => new WebPickedFile(file));
	let currentProgress = 0;
	let totalProgress = 0;

	const bumpProgress = () => {
		currentProgress += 1;
		reporter.updateProgress(currentProgress, totalProgress);
	};

	try {
		reporter.setPhase('collecting');
		reporter.updateStats({ ...stats });
		reporter.updateProgress(0, 1);
		reporter.log('info', 'Scanning Notion HTML export...');

		const registry = await collectNotionExport(pickedFiles, reporter);

		reporter.setPhase('creating');
		const notebookID = await ensureNotebook(client, reporter, notebookName, importMode);

		let existingTitles: Set<string> | undefined;
		if (importMode === 'incremental') {
			const listRes = await client.lsNotebooks({});
			const existing = listRes?.data?.notebooks?.find((n: any) => n.name === notebookName);
			if (existing) {
				existingTitles = await getExistingPageTitles(client, existing.id as string);
			}
		}

		const plan = buildSiYuanWritePlan(registry, notebookName, existingTitles);
		reporter.log(
			'info',
			`Manifest ready: ${plan.documents.length} HTML document(s), ${plan.attachments.length} attachment(s), ${Object.keys(registry.resolverInfo.csvFileInfos).length} CSV database file(s).`,
		);
		const parentCount = buildParentCount(plan);
		totalProgress = plan.documents.length + plan.attachments.length + plan.documents.length + plan.documents.length;
		currentProgress = 0;
		reporter.updateProgress(currentProgress, totalProgress);

		for (const document of plan.documents) {
			reporter.setCurrentItem((document as any).finalTitle || document.fileInfo.displayTitle || document.fileInfo.title);
			const shouldSkip = !document.fileInfo.hasContent && !parentCount.has(document.notionID);
			if (shouldSkip) {
				reporter.log('info', `Skipping empty leaf page: "${(document as any).finalTitle || document.fileInfo.displayTitle || document.fileInfo.title}"`);
				bumpProgress();
				continue;
			}

			const syPath = `${plan.registry.resolverInfo.getPathForFile(document.fileInfo)}${document.fileInfo.title}`;
			const createRes = await client.createDocWithMd({
				markdown: '',
				notebook: notebookID,
				path: syPath,
			});
			if (createRes.code !== 0) {
				stats.errors += 1;
				reporter.updateStats({ ...stats });
				reporter.log('error', `Failed to create doc "${syPath}": ${createRes.msg}`);
				bumpProgress();
				continue;
			}
			document.fileInfo.blockID = createRes.data;
			stats.docs += 1;
			reporter.updateStats({ ...stats });
			bumpProgress();
		}

		reporter.setPhase('writing');
		reporter.log('info', 'Uploading attachments...');
		await runPool(plan.attachments, CONCURRENCY, async ({ entry, attachmentInfo }) => {
			reporter.setCurrentItem(entry.name);
			try {
				const data = await entry.read();
				const putRes = await client.putFile({
					file: new File([data], entry.name),
					path: attachmentInfo.pathInSiYuanFs,
				});
				if (putRes.code !== 0) {
					stats.errors += 1;
					reporter.log('error', `Failed to upload "${entry.name}": ${putRes.msg}`);
				} else {
					stats.attachments += 1;
					reporter.updateStats({ ...stats });
				}
			} catch (error: any) {
				stats.errors += 1;
				reporter.log('error', `Failed to upload "${entry.name}": ${error?.message || error}`);
			} finally {
				reporter.updateStats({ ...stats });
				bumpProgress();
			}
		});

		const markdownCache = new Map<string, Awaited<ReturnType<typeof readToMarkdown>>>();
		reporter.log('info', 'Analyzing documents to stabilize shared database views...');
		for (const document of plan.documents) {
			if (!document.fileInfo.blockID) {
				bumpProgress();
				continue;
			}
			reporter.setCurrentItem((document as any).finalTitle || document.fileInfo.displayTitle || document.fileInfo.title);
			try {
				const markdownInfo = await readToMarkdown(plan.registry.resolverInfo, document.entry, document.notionID);
				if (markdownInfo.warnings?.length) {
					for (const warning of markdownInfo.warnings) {
						stats.errors += 1;
						reporter.log('warn', `[${document.fileInfo.title}] ${warning}`);
					}
				}
				markdownCache.set(document.notionID, markdownInfo);
			} catch (error: any) {
				stats.errors += 1;
				reporter.log('error', `Failed to analyze "${document.fileInfo.title}": ${error?.message || error}`);
			} finally {
				reporter.updateStats({ ...stats });
				bumpProgress();
			}
		}

		reporter.log('info', 'Writing documents and databases...');
		const uploadedAttributeViewIDs = new Set<string>();
		let expectedFolds = 0;
		await runPool(plan.documents, CONCURRENCY, async (document) => {
			if (!document.fileInfo.blockID) {
				bumpProgress();
				return;
			}
			reporter.setCurrentItem((document as any).finalTitle || document.fileInfo.displayTitle || document.fileInfo.title);
			try {
				expectedFolds += await writeDocumentContent(client, reporter, document, plan, markdownCache, uploadedAttributeViewIDs, stats);
			} catch (error: any) {
				stats.errors += 1;
				reporter.log('error', `Failed to write "${document.fileInfo.title}": ${error?.message || error}`);
			} finally {
				reporter.updateStats({ ...stats });
				bumpProgress();
			}
		});

		if (expectedFolds > 0) {
			reporter.log('info', `Converting ${expectedFolds} toggle block(s)...`);
			await fixFoldBlocks(reporter, [notebookID], expectedFolds);
		}
		reporter.log('info', 'Rebuilding residual HTML documents...');
		const rebuiltHtmlDocuments = await rebuildResidualHtmlDocuments(reporter, [notebookID]);
		if (rebuiltHtmlDocuments > 0) {
			reporter.log('info', `Rebuilt ${rebuiltHtmlDocuments} residual HTML document(s).`);
		}
		reporter.log('info', 'Finalizing inline text colors...');
		const fixedInlineBlocks = await fixInlineStyleBlocks(reporter, [notebookID]);
		if (fixedInlineBlocks > 0) {
			reporter.log('info', `Normalized ${fixedInlineBlocks} inline color block(s).`);
		}
		reporter.log('info', 'Normalizing native SiYuan inline highlights...');
		const normalizedNativeHighlights = await normalizeNativeInlineHighlights(reporter, [notebookID]);
		if (normalizedNativeHighlights > 0) {
			reporter.log('info', `Normalized ${normalizedNativeHighlights} native inline highlight block(s).`);
		}

		reporter.setPhase('done');
		reporter.log(
			'info',
			`Import finished. ${stats.docs} docs, ${stats.attachments} attachments, ${stats.databases} databases, ${stats.errors} errors.`,
		);
		showMessage(
			stats.errors > 0 ? `Import completed with ${stats.errors} error(s).` : 'Import completed successfully!',
			-1,
			stats.errors > 0 ? 'error' : 'info',
		);
		return { ...stats };
	} catch (error: any) {
		stats.errors += 1;
		reporter.updateStats({ ...stats });
		reporter.setPhase('done');
		reporter.log('error', `Fatal import error: ${error?.message || error}`);
		showMessage(`Import error: ${error?.message || error}`, 5000, 'error');
		return { ...stats };
	}
}
