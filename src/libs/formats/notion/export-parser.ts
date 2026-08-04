import { parseFilePath, type PickedFile } from '../../filesystem.js';
import { parseHTML } from '../../util.js';
import { readZip, ZipEntryFile } from '../../zip.js';
import { parseFileInfo } from './parse-info.js';
import {
	type NotionExportRegistry,
	type NotionImportReporter,
	type WorkspaceManifest,
	type WorkspaceManifestNode,
	NotionResolverInfo,
} from './notion-types.js';
import { getNotionId, normalizeNotionLookup, stripNotionId } from './notion-utils.js';

function decodeHTML(value: string) {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

function cleanManifestTitle(rawTitle: string) {
	const decoded = decodeHTML(rawTitle).trim();
	const withoutInlineLabel = decoded.replace(/\s*\(Inline database\)\s*$/i, '');
	const withoutExtension = withoutInlineLabel.replace(/\.(html|csv)\s*$/i, '');
	const withoutNotionID = stripNotionId(withoutExtension);
	return withoutNotionID.trim();
}

function createManifestNode(rawID: string, parentID: string | null): WorkspaceManifestNode | null {
	const notionID = getNotionId(rawID);
	if (!notionID) {
		return null;
	}

	return {
		kind: 'page',
		rawID,
		notionID,
		title: '',
		href: '',
		parentID,
		parentIDs: [],
		childIDs: [],
		depth: 0,
		normalizedTitle: '',
		normalizedHref: '',
	};
}

function extractAnchorDisplayTitle(anchor: HTMLAnchorElement) {
	const clone = anchor.cloneNode(true) as HTMLAnchorElement;
	clone.querySelectorAll('span.icon, img.icon').forEach((icon) => icon.remove());
	const title = cleanManifestTitle(clone.textContent?.replace(/\s+/g, ' ') ?? '');
	if (!title || /^https?:\/\//i.test(title) || /\.(html|csv)$/i.test(title)) {
		return '';
	}
	return title;
}

function choosePreferredLinkedTitle(fallbackTitle: string, counts: Map<string, number>) {
	const fallbackNormalized = normalizeNotionLookup(fallbackTitle);
	const ranked = Array.from(counts.entries())
		.filter(([candidate]) => candidate)
		.sort(([leftTitle, leftCount], [rightTitle, rightCount]) => {
			const leftScore =
				leftCount * 100
				+ leftTitle.length
				+ (/[/:#]/.test(leftTitle) ? 25 : 0)
				+ (normalizeNotionLookup(leftTitle) !== fallbackNormalized ? 10 : 0);
			const rightScore =
				rightCount * 100
				+ rightTitle.length
				+ (/[/:#]/.test(rightTitle) ? 25 : 0)
				+ (normalizeNotionLookup(rightTitle) !== fallbackNormalized ? 10 : 0);
			return rightScore - leftScore;
		});
	return ranked[0]?.[0] ?? '';
}

export async function collectLinkedTitleHints(htmlEntriesByID: Record<string, ZipEntryFile>) {
	const titleCounts = new Map<string, Map<string, number>>();

	for (const entry of Object.values(htmlEntriesByID)) {
		const html = await entry.readText();
		const dom = parseHTML(html);
		for (const anchor of Array.from(dom.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
			const href = decodeURI(anchor.getAttribute('href') ?? '');
			const notionID = getNotionId(href);
			if (!notionID) {
				continue;
			}
			const displayTitle = extractAnchorDisplayTitle(anchor);
			if (!displayTitle) {
				continue;
			}
			const counts = titleCounts.get(notionID) ?? new Map<string, number>();
			counts.set(displayTitle, (counts.get(displayTitle) ?? 0) + 1);
			titleCounts.set(notionID, counts);
		}
	}

	return titleCounts;
}

export function applyLinkedTitleHints(
	info: NotionResolverInfo,
	titleHints: Map<string, Map<string, number>>,
) {
	for (const [notionID, counts] of titleHints.entries()) {
		const fileInfo = info.idsToFileInfo[notionID];
		if (!fileInfo || counts.size === 0) {
			continue;
		}

		const preferred = choosePreferredLinkedTitle(fileInfo.displayTitle || fileInfo.title, counts);
		if (!preferred) {
			continue;
		}

		fileInfo.displayTitle = preferred;
	}
}

export function parseWorkspaceManifest(indexHTML: string): WorkspaceManifest {
	const nodesByID: Record<string, WorkspaceManifestNode> = {};
	const orderedIDs: string[] = [];
	const rootIDs: string[] = [];

	// A DOM walk rather than a tag tokenizer: the tokenizer pushed the ancestor stack only
	// for <ul> elements carrying a valid `id::<32hex>` but popped it on EVERY </ul>, so a
	// single plain wrapper <ul> desynchronised the stack and silently re-parented every
	// remaining page to its grandparent. It also leaked nested markup into titles.
	const dom = parseHTML(indexHTML);
	const root: Element = dom.querySelector('body') ?? dom;

	const childListsOf = (element: Element): Element[] =>
		Array.from(element.querySelectorAll('ul')).filter((ul) => ul.parentElement?.closest('ul') === element);

	const directAnchorOf = (element: Element): HTMLAnchorElement | null =>
		(Array.from(element.querySelectorAll('a')) as HTMLAnchorElement[])
			.find((anchor) => anchor.closest('ul') === element) ?? null;

	const visit = (element: Element, parentID: string | null, depth: number) => {
		const rawID = (element.getAttribute('id') ?? '').replace(/^id::/, '');
		const created = createManifestNode(rawID, parentID);

		// An <ul> without a usable id is a layout wrapper: pass the parent through instead
		// of breaking the chain.
		if (!created) {
			for (const child of childListsOf(element)) {
				visit(child, parentID, depth);
			}
			return;
		}

		const existingNode = nodesByID[created.notionID];
		const node = existingNode ?? created;
		if (!existingNode) {
			nodesByID[node.notionID] = node;
			orderedIDs.push(node.notionID);
		}
		node.rawID = rawID;
		if (!node.parentID && parentID) {
			node.parentID = parentID;
		}
		if (depth === 0) {
			node.kind = 'workspace';
		}

		if (parentID && nodesByID[parentID]) {
			if (!nodesByID[parentID].childIDs.includes(node.notionID)) {
				nodesByID[parentID].childIDs.push(node.notionID);
			}
		} else if (node.kind !== 'workspace' && !rootIDs.includes(node.notionID)) {
			rootIDs.push(node.notionID);
		}

		const anchor = directAnchorOf(element);
		if (anchor) {
			node.href = anchor.getAttribute('href') ?? '';
			node.title = cleanManifestTitle(extractAnchorDisplayTitle(anchor));
			node.normalizedTitle = normalizeNotionLookup(node.title);
			node.normalizedHref = normalizeNotionLookup(node.href);

			const anchorText = anchor.textContent ?? '';
			if (/\.csv(\?|$)/i.test(node.href) || /\.csv$/i.test(node.rawID)) {
				node.kind = 'csv';
			} else if (/inline database/i.test(anchorText)) {
				node.kind = 'inline_database';
			} else if (node.kind !== 'workspace') {
				node.kind = 'page';
			}
		}

		for (const child of childListsOf(element)) {
			visit(child, node.notionID, depth + 1);
		}
	};

	for (const topLevel of Array.from(root.querySelectorAll('ul')).filter((ul) => !ul.parentElement?.closest('ul'))) {
		visit(topLevel, null, 0);
	}

	// A single-page export has one <ul> and no children; treating it as the workspace
	// hoisted its subpages to the notebook root.
	for (const notionID of orderedIDs) {
		const node = nodesByID[notionID];
		if (node.kind === 'workspace' && node.childIDs.length === 0) {
			node.kind = 'page';
			if (!rootIDs.includes(notionID)) {
				rootIDs.push(notionID);
			}
		}
	}

	for (const notionID of orderedIDs) {
		const node = nodesByID[notionID];
		const parentIDs: string[] = [];
		let cursor = node.parentID;
		while (cursor && nodesByID[cursor]) {
			if (nodesByID[cursor].kind !== 'workspace') {
				parentIDs.unshift(cursor);
			}
			cursor = nodesByID[cursor].parentID;
		}
		node.parentIDs = parentIDs;
		node.depth = parentIDs.length;
	}

	const workspaceID = orderedIDs[0] ?? '';
	return {
		workspaceID,
		rootIDs,
		orderedIDs,
		nodesByID,
	};
}

function registerCSV(info: NotionResolverInfo, entry: ZipEntryFile) {
	const csvID = getNotionId(entry.name);
	if (!csvID) {
		return;
	}
	const title = decodeHTML(stripNotionId(entry.basename)).trim();
	const parent = decodeHTML(entry.parent || '');
	const collectionPath = parent ? `${parent}/${title}` : title;
	const csvInfo = {
		id: csvID,
		entry,
		title,
		parent,
		collectionPath,
		normalizedTitle: normalizeNotionLookup(title),
		normalizedCollectionPath: normalizeNotionLookup(collectionPath),
	};
	info.csvFiles[csvID] = entry;
	info.csvFileInfos[csvID] = csvInfo;
	(info.csvFilesByCollectionPath[csvInfo.normalizedCollectionPath] ??= []).push(csvInfo);
	(info.csvFilesByTitle[csvInfo.normalizedTitle] ??= []).push(csvInfo);
}

async function walkEntries(
	files: PickedFile[],
	onEntry: (entry: ZipEntryFile) => Promise<void>,
) {
	for (const zipFile of files) {
		await readZip(zipFile, async (_, entries) => {
			for (const entry of entries) {
				if (entry.extension === 'zip' && entry.parent === '') {
					await walkEntries([entry], onEntry);
					continue;
				}
				await onEntry(entry);
			}
		});
	}
}

export async function collectNotionExport(files: PickedFile[], reporter: NotionImportReporter): Promise<NotionExportRegistry> {
	const entries: ZipEntryFile[] = [];
	const htmlEntriesByID: Record<string, ZipEntryFile> = {};
	const assetEntriesByPath: Record<string, ZipEntryFile> = {};
	const resolverInfo = new NotionResolverInfo('', false);
	let indexEntry: ZipEntryFile | undefined;

	await walkEntries(files, async (entry) => {
		if (entry.extension === 'md' && getNotionId(entry.name)) {
			throw new Error('Notion Markdown export detected. Please export Notion data to HTML instead.');
		}

		entries.push(entry);

		const parentDepth = entry.parent ? entry.parent.split('/').filter(Boolean).length : 0;
		if (entry.name === 'index.html' && parentDepth <= 1) {
			indexEntry = entry;
			return;
		}

		if (entry.extension === 'csv' && getNotionId(entry.name)) {
			registerCSV(resolverInfo, entry);
			return;
		}

		await parseFileInfo(resolverInfo, entry);
		if (entry.extension === 'html') {
			const notionID = getNotionId(entry.name);
			if (notionID) {
				htmlEntriesByID[notionID] = entry;
			}
			return;
		}

		// The full path is authoritative. The bare name is only a fallback, so it must not
		// overwrite: two pages each holding an "image.png" made one render the other's asset.
		assetEntriesByPath[normalizeNotionLookup(entry.filepath)] = entry;
		const nameKey = normalizeNotionLookup(entry.name);
		if (!(nameKey in assetEntriesByPath)) {
			assetEntriesByPath[nameKey] = entry;
		}
	});

	let manifest: WorkspaceManifest | undefined;
	if (indexEntry) {
		reporter.log('info', 'Reading workspace manifest from index.html...');
		manifest = parseWorkspaceManifest(await indexEntry.readText());
		applyManifestToResolverInfo(resolverInfo, manifest);
	}

	reporter.log('info', 'Collecting page title hints from HTML links...');
	const linkedTitleHints = await collectLinkedTitleHints(htmlEntriesByID);
	applyLinkedTitleHints(resolverInfo, linkedTitleHints);

	return {
		entries,
		indexEntry,
		manifest,
		resolverInfo,
		htmlEntriesByID,
		assetEntriesByPath,
	};
}

export function applyManifestToResolverInfo(info: NotionResolverInfo, manifest: WorkspaceManifest) {
	for (const notionID of manifest.orderedIDs) {
		const node = manifest.nodesByID[notionID];
		const fileInfo = info.idsToFileInfo[notionID];
		if (!fileInfo) {
			continue;
		}
		fileInfo.parentIds = node.parentIDs.filter((parentID) => manifest.nodesByID[parentID]?.kind !== 'csv');
		// index.html is the most faithful source for page labels; HTML titles are often
		// sanitized from export filenames and can lose characters such as "/".
		if (node.title) {
			fileInfo.displayTitle = node.title;
		}
	}
}

export function getFallbackParentIDsFromPath(filepath: string) {
	const { parent } = parseFilePath(filepath);
	return parent
		.split('/')
		.map((segment) => getNotionId(segment))
		.filter(Boolean) as string[];
}

function decodeNotionPathSegment(segment: string) {
	let decoded = segment ?? '';
	try {
		decoded = decodeURI(decoded);
	} catch {
		// Keep raw path segment when already decoded.
	}
	return stripNotionId(decoded).trim();
}

function getLogicalPathSegments(filepath: string, includeSelf = true) {
	const normalizedPath = filepath.replace(/\\/g, '/');
	const { parent, basename } = parseFilePath(normalizedPath);
	const segments = parent
		.split('/')
		.map((segment) => decodeNotionPathSegment(segment))
		.filter(Boolean);
	if (includeSelf) {
		const selfSegment = decodeNotionPathSegment(basename);
		if (selfSegment) {
			segments.push(selfSegment);
		}
	}
	return segments;
}

function buildLogicalPathIndex(info: NotionResolverInfo) {
	const cached = (info as any).__logicalPathIndex as Map<string, string> | undefined;
	if (cached) {
		return cached;
	}

	const index = new Map<string, string>();
	for (const [notionID, fileInfo] of Object.entries(info.idsToFileInfo)) {
		const segments = getLogicalPathSegments(fileInfo.path, true);
		if (!segments.length) {
			continue;
		}
		index.set(normalizeNotionLookup(segments.join('/')), notionID);
	}

	(info as any).__logicalPathIndex = index;
	return index;
}

export function resolveFallbackParentIDsFromResolver(info: NotionResolverInfo, filepath: string) {
	const logicalPathIndex = buildLogicalPathIndex(info);
	const segments = getLogicalPathSegments(filepath, false);
	const resolvedParentIDs: string[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < segments.length; i += 1) {
		const candidatePath = normalizeNotionLookup(segments.slice(0, i + 1).join('/'));
		const candidateID = logicalPathIndex.get(candidatePath);
		if (!candidateID || seen.has(candidateID)) {
			continue;
		}
		seen.add(candidateID);
		resolvedParentIDs.push(candidateID);
	}

	return resolvedParentIDs;
}
