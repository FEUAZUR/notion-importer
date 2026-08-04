import { Client } from '@siyuan-community/siyuan-sdk';
import { showMessage } from 'siyuan';
import { WebPickedFile } from '../../filesystem.js';
import { clearSiYuanIDCache, generateSiYuanID, parseHTML } from '../../util.js';
import { applyInlineStyleMarkersToBlockDOM, readToMarkdown } from './convert-to-md.js';
import { collectNotionExport } from './export-parser.js';
import { buildSiYuanWritePlan } from './notion-normalizer.js';
import { ImportCancelledError } from './notion-types.js';
import type { ImportResult, ImportStats, NotionImportReporter, NotionWritePlanDocument, SiYuanWritePlan } from './notion-types.js';
import { t } from '../../i18n.js';

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

function timestampSuffix(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
		+ ` ${pad(date.getHours())}h${pad(date.getMinutes())}`;
}

/**
 * Never reuses or deletes an existing notebook. The previous version called
 * removeNotebook() on any notebook named "Notion", so a second import destroyed the
 * first one (recoverable only from SiYuan's retention-limited history).
 */
async function createImportNotebook(client: Client, reporter: NotionImportReporter, baseName: string) {
	const listRes = await client.lsNotebooks();
	const taken = new Set((listRes?.data?.notebooks ?? []).map((notebook: any) => notebook.name));

	let name = baseName;
	if (taken.has(name)) {
		name = `${baseName} (${timestampSuffix(new Date())})`;
		for (let attempt = 2; taken.has(name); attempt += 1) {
			name = `${baseName} (${timestampSuffix(new Date())}) ${attempt}`;
		}
	}

	const createRes = await client.createNotebook({ name });
	if (createRes.code !== 0) {
		throw new Error(`Failed to create notebook "${name}": ${createRes.msg}`);
	}
	reporter.log('info', t('logNotebookCreated', name));
	return { id: createRes.data.notebook.id as string, name };
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
	const topLevelBlocks = Array.from(dom.querySelector('body')?.children || [])
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
	return (codeBlock?.textContent || dom.querySelector('body')?.textContent || '')
		.replace(/\u200b/g, '')
		.replace(/\r\n/g, '\n')
		.trim();
}

/**
 * Reads the definition back through the official endpoint. The kernel silently returns an
 * empty AV for content it cannot parse (wrong spec, ciphertext in an encrypted notebook),
 * so a successful putFile alone proves nothing.
 * Returns a problem description, or '' when the database is sound.
 */
async function verifyAttributeView(av: any): Promise<string> {
	try {
		const response = await apiJson('/api/av/getAttributeView', { id: av.id });
		if (response?.code !== 0) {
			return response?.msg || 'getAttributeView failed';
		}
		const stored = response?.data?.av;
		if (!stored?.id) {
			return 'the kernel could not read the database back';
		}
		const expectedKeys = Array.isArray(av.keyValues) ? av.keyValues.length : 0;
		const storedKeys = Array.isArray(stored.keyValues) ? stored.keyValues.length : 0;
		if (storedKeys < expectedKeys) {
			return `only ${storedKeys} of ${expectedKeys} fields were stored`;
		}
		return '';
	} catch (error: any) {
		return error?.message || String(error);
	}
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
		// Writing the AV definition directly is only sound because every import mints fresh
		// avIDs the kernel has never parsed (its in-memory AV cache has no TTL and no HTTP
		// flush). verifyAttributeView below turns a silent miss into a reported error.
		const putRes = await client.putFile({
			file: new File([blob], 'data.json', { type: 'application/json' }),
			path: `/data/storage/av/${av.id}.json`,
		});
		if (putRes.code !== 0) {
			reporter.log('error', t('logDatabaseFailed', av.name || av.id, putRes.msg));
			stats.errors += 1;
		} else {
			const problem = await verifyAttributeView(av);
			if (problem) {
				reporter.log('error', t('logDatabaseFailed', av.name || av.id, problem));
				stats.errors += 1;
			} else {
				uploadedAttributeViewIDs.add(av.id);
				stats.databases += 1;
			}
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

	// custom-avs is a comma-separated list: a block bound to several databases must keep
	// every id, so accumulate first and write each block once.
	const avIDsByBlock = new Map<string, Set<string>>();
	for (const av of markdownInfo.attributeViews) {
		for (const keyValue of av.keyValues) {
			if (keyValue.key.type !== 'block') {
				continue;
			}
			for (const rowValue of keyValue.values) {
				const boundID = rowValue?.block?.id;
				if (rowValue?.isDetached || !boundID) {
					continue;
				}
				const ids = avIDsByBlock.get(boundID) ?? new Set<string>();
				ids.add(av.id);
				avIDsByBlock.set(boundID, ids);
			}
		}
	}
	for (const [blockID, avIDs] of avIDsByBlock) {
		attrPromises.push(client.setBlockAttrs({
			attrs: { 'custom-avs': Array.from(avIDs).join(',') },
			id: blockID,
		}));
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

const SENTINELS = ['SYINLINESTYLE', 'SYFOLDFOLDSTART', 'SYFOLDFOLDEND', 'SYCOLOR_', 'SYCOLROW', 'SYCOLCOL'];

/**
 * Last-resort audit. Conversion markers leaking into the finished notebook is a silent
 * corruption: a real import was found carrying SYINLINESTYLE and SYFOLDFOLD markers that
 * every fix-up pass had missed. Surface them instead of shipping them.
 */
async function reportResidualMarkers(reporter: NotionImportReporter, notebookIDs: string[], stats: ImportStats) {
	if (!notebookIDs.length) {
		return;
	}
	const boxList = notebookIDs.map((id) => `'${id}'`).join(',');
	for (const sentinel of SENTINELS) {
		const rows: Array<{ count: number }> = await sqlQuery(
			`SELECT COUNT(*) AS count FROM blocks WHERE box IN (${boxList}) AND content LIKE '%${sentinel}%'`,
		);
		const count = Number(rows?.[0]?.count ?? 0);
		if (count > 0) {
			stats.warnings += 1;
			reporter.log('warn', `${count} block(s) still contain the conversion marker "${sentinel}"`);
		}
	}
	reporter.updateStats({ ...stats });
}

async function rebuildResidualHtmlDocuments(
	reporter: NotionImportReporter,
	notebookIDs: string[],
) {
	if (!notebookIDs.length) {
		return 0;
	}

	const boxList = notebookIDs.map((id) => `'${id}'`).join(',');
	// Not `type = 'html'`: Lute also parks unconverted content in a code block with
	// data-type="yaml-front-matter", which is exactly where markers were found surviving
	// in a real import. Match on content and let the extractor decide.
	const htmlBlocks: Array<{ root_id: string; content: string }> = await sqlQuery(
		`SELECT root_id, content FROM blocks WHERE box IN (${boxList}) AND type IN ('html', 'c') AND content LIKE '%SYINLINESTYLE\\_%' ESCAPE '\\' LIMIT 5000`,
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
): Promise<ImportResult> {
	clearSiYuanIDCache();
	const stats: ImportStats = { docs: 0, attachments: 0, databases: 0, warnings: 0, errors: 0 };
	const client = new Client();
	const pickedFiles = Array.from(files).map((file) => new WebPickedFile(file));
	let currentProgress = 0;
	let totalProgress = 0;
	let notebookName = '';

	const bumpProgress = () => {
		currentProgress += 1;
		reporter.updateProgress(currentProgress, totalProgress);
	};
	const checkAborted = () => {
		if (reporter.signal?.aborted) {
			throw new ImportCancelledError();
		}
	};

	try {
		reporter.setPhase('collecting');
		reporter.updateStats({ ...stats });
		reporter.updateProgress(0, 1);
		reporter.log('info', t('logScanning'));

		const registry = await collectNotionExport(pickedFiles, reporter);
		checkAborted();
		const plan = buildSiYuanWritePlan(registry);
		reporter.log(
			'info',
			t(
				'logManifestReady',
				plan.documents.length,
				plan.attachments.length,
				Object.keys(registry.resolverInfo.csvFileInfos).length,
			),
		);

		reporter.setPhase('creating');
		const notebook = await createImportNotebook(client, reporter, plan.notebookName);
		const notebookID = notebook.id;
		notebookName = notebook.name;
		const parentCount = buildParentCount(plan);
		// Content-addressed assets collapse duplicates: upload each distinct target once.
		const uniqueAttachments = Array.from(
			new Map(plan.attachments.map((item) => [item.attachmentInfo.pathInSiYuanFs, item])).values(),
		);
		totalProgress = plan.documents.length * 3 + uniqueAttachments.length;
		currentProgress = 0;
		reporter.updateProgress(currentProgress, totalProgress);

		for (const document of plan.documents) {
			checkAborted();
			reporter.setCurrentItem(document.fileInfo.displayTitle || document.fileInfo.title);
			const shouldSkip = !document.fileInfo.hasContent && !parentCount.has(document.notionID);
			if (shouldSkip) {
				reporter.log('info', `Skipping empty leaf page: "${document.fileInfo.displayTitle || document.fileInfo.title}"`);
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
				reporter.log('error', t('logCreateDocFailed', syPath, createRes.msg));
				bumpProgress();
				continue;
			}
			document.fileInfo.blockID = createRes.data;
			stats.docs += 1;
			reporter.updateStats({ ...stats });
			bumpProgress();
		}

		reporter.setPhase('writing');
		reporter.log('info', t('logUploadingAttachments'));
		await runPool(uniqueAttachments, CONCURRENCY, async ({ entry, attachmentInfo }) => {
			checkAborted();
			reporter.setCurrentItem(entry.name);
			try {
				const data = await entry.read();
				const putRes = await client.putFile({
					file: new File([data], entry.name),
					path: attachmentInfo.pathInSiYuanFs,
				});
				if (putRes.code !== 0) {
					stats.errors += 1;
					reporter.log('error', t('logUploadFailed', entry.name, putRes.msg));
				} else {
					stats.attachments += 1;
					reporter.updateStats({ ...stats });
				}
			} catch (error: any) {
				if (error instanceof ImportCancelledError) {
					throw error;
				}
				stats.errors += 1;
				reporter.log('error', t('logUploadFailed', entry.name, error?.message || error));
			} finally {
				reporter.updateStats({ ...stats });
				bumpProgress();
			}
		});

		const markdownCache = new Map<string, Awaited<ReturnType<typeof readToMarkdown>>>();
		reporter.log('info', t('logAnalyzingDocuments'));
		for (const document of plan.documents) {
			checkAborted();
			if (!document.fileInfo.blockID) {
				bumpProgress();
				continue;
			}
			reporter.setCurrentItem(document.fileInfo.displayTitle || document.fileInfo.title);
			try {
				const markdownInfo = await readToMarkdown(plan.registry.resolverInfo, document.entry, document.notionID);
				if (markdownInfo.warnings?.length) {
					for (const warning of markdownInfo.warnings) {
						// Warnings are not errors: conflating them made the summary claim
						// "N errors" and then show a green "completed successfully".
						stats.warnings += 1;
						reporter.log('warn', `[${document.fileInfo.title}] ${warning}`);
					}
				}
				markdownCache.set(document.notionID, markdownInfo);
			} catch (error: any) {
				stats.errors += 1;
				reporter.log('error', t('logAnalyzeFailed', document.fileInfo.title, error?.message || error));
			} finally {
				reporter.updateStats({ ...stats });
				bumpProgress();
			}
		}

		reporter.log('info', t('logWritingDocuments'));
		const uploadedAttributeViewIDs = new Set<string>();
		let expectedFolds = 0;
		await runPool(plan.documents, CONCURRENCY, async (document) => {
			checkAborted();
			if (!document.fileInfo.blockID) {
				bumpProgress();
				return;
			}
			reporter.setCurrentItem(document.fileInfo.displayTitle || document.fileInfo.title);
			try {
				expectedFolds += await writeDocumentContent(client, reporter, document, plan, markdownCache, uploadedAttributeViewIDs, stats);
			} catch (error: any) {
				if (error instanceof ImportCancelledError) {
					throw error;
				}
				stats.errors += 1;
				reporter.log('error', t('logWriteFailed', document.fileInfo.title, error?.message || error));
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

		await reportResidualMarkers(reporter, [notebookID], stats);

		reporter.setPhase('done');
		reporter.log(
			'info',
			t('logImportFinished', stats.docs, stats.attachments, stats.databases, stats.warnings, stats.errors),
		);
		showMessage(
			stats.errors > 0 ? t('importWithErrors') : t('importSuccess'),
			-1,
			stats.errors > 0 ? 'error' : 'info',
		);
		return { ...stats, outcome: 'completed', notebookName };
	} catch (error: any) {
		reporter.setPhase('done');
		if (error instanceof ImportCancelledError) {
			reporter.log('warn', t('logImportCancelled'));
			reporter.updateStats({ ...stats });
			showMessage(t('importCancelled'), 5000, 'info');
			return { ...stats, outcome: 'cancelled', notebookName };
		}
		stats.errors += 1;
		reporter.updateStats({ ...stats });
		reporter.log('error', t('logFatalError', error?.message || error));
		showMessage(t('logFatalError', error?.message || error), 5000, 'error');
		return { ...stats, outcome: 'failed', notebookName };
	}
}
