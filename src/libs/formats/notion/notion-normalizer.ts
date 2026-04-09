import { resolveFallbackParentIDsFromResolver } from './export-parser.js';
import type { NotionExportRegistry, SiYuanWritePlan, NotionWritePlanAttachment, NotionWritePlanDocument } from './notion-types.js';
import { normalizeNotionLookup } from './notion-utils.js';

function comparePaths(a: string, b: string) {
	return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

export function buildSiYuanWritePlan(
	registry: NotionExportRegistry,
	notebookName: string = 'Notion',
	existingTitles?: Set<string>,
): SiYuanWritePlan {
	const { resolverInfo, htmlEntriesByID } = registry;

	// Track used titles, initialized with existing titles to avoid conflicts
	const usedTitles = new Set<string>(existingTitles);

	const getUniqueTitle = (title: string): string => {
		if (!usedTitles.has(title)) {
			usedTitles.add(title);
			return title;
		}
		let counter = 1;
		let uniqueTitle = `${title} (${counter})`;
		while (usedTitles.has(uniqueTitle)) {
			counter++;
			uniqueTitle = `${title} (${counter})`;
		}
		usedTitles.add(uniqueTitle);
		return uniqueTitle;
	};

	const documents = Object.entries(resolverInfo.idsToFileInfo)
		.map(([notionID, fileInfo]) => {
			if (!fileInfo.parentIds.length) {
				fileInfo.parentIds = resolveFallbackParentIDsFromResolver(resolverInfo, fileInfo.path);
			}
			const finalTitle = getUniqueTitle(fileInfo.title);
			return {
				notionID,
				depth: fileInfo.parentIds.length,
				entry: htmlEntriesByID[notionID],
				fileInfo,
				finalTitle,
			};
		})
		.filter((doc): doc is NotionWritePlanDocument => Boolean(doc.entry))
		.sort((left, right) => {
			if (left.depth !== right.depth) {
				return left.depth - right.depth;
			}
			return comparePaths(left.fileInfo.path, right.fileInfo.path);
		});

	const attachments = Object.entries(resolverInfo.pathsToAttachmentInfo)
		.map(([path, attachmentInfo]) => {
			const entry =
				registry.assetEntriesByPath[normalizeNotionLookup(path)] ||
				registry.assetEntriesByPath[normalizeNotionLookup(attachmentInfo.nameWithExtension)];
			return {
				entry,
				attachmentInfo,
			};
		})
		.filter((item): item is NotionWritePlanAttachment => Boolean(item.entry))
		.sort((left, right) => comparePaths(left.attachmentInfo.path, right.attachmentInfo.path));

	return {
		notebookName,
		registry,
		documents,
		attachments,
	};
}
