import { parseFilePath } from '../../filesystem.js';
import { HTMLElementfindAll, parseHTML, createEl, createSpan, generateSiYuanID } from '../../util.js';
import { ZipEntryFile } from '../../zip.js';
import {
	type InlineStyleMarker,
	type MarkdownInfo,
	type NotionAttachmentInfo,
	type NotionCSVFileInfo,
	type NotionNumberDisplaySpec,
	type NotionDatabaseViewFilter,
	type NotionDatabaseViewGroupBy,
	type NotionDatabaseViewSort,
	type NotionDatabaseViewSpec,
	type NotionImageDisplay,
	type NotionLink,
	type NotionProperty,
	type NotionPropertyType,
	type NotionResolverInfo,
} from './notion-types.js';
import { mapNotionColumnTypeToSiYuan } from './database-utils.js';
import {
	detectDateOrderPreference,
	escapeHashtags,
	getNotionId,
	hoistChildren,
	normalizeNotionLookup,
	stripNotionId,
	stripParentDirectories,
	toTimestamp,
	timestampIsPureDate,
	parseEuropeanNumber,
} from './notion-utils.js';

let lute = (window as any).Lute.New();

let _currentWarnings: string[] = [];
function addImportWarning(msg: string) {
	_currentWarnings.push(msg);
	console.warn(msg);
}

function htmlToMarkdown(html: string): string {
    return lute.HTML2Md(html)
}

// Couleurs Notion avec leurs valeurs RGBA
const notionBlockColors: Record<string, string> = {
	'block-color-gray_background': 'rgba(240, 239, 237, 1)',
	'block-color-brown_background': 'rgba(245, 237, 233, 1)',
	'block-color-orange_background': 'rgba(251, 235, 222, 1)',
	'block-color-yellow_background': 'rgba(249, 243, 220, 1)',
	'block-color-teal_background': 'rgba(232, 241, 236, 1)',
	'block-color-blue_background': 'rgba(229, 242, 252, 1)',
	'block-color-purple_background': 'rgba(243, 235, 249, 1)',
	'block-color-pink_background': 'rgba(250, 233, 241, 1)',
	'block-color-red_background': 'rgba(252, 233, 231, 1)',
	'block-color-default_background': 'transparent',
};

// Map Notion inline colors to the closest native SiYuan text colors so the
// imported markup uses C1's own palette instead of custom RGBA values.
const notionTextColors: Record<string, string> = {
	'block-color-default': 'inherit',
	'block-color-gray': 'var(--b3-font-color5)',
	'block-color-brown': 'var(--b3-font-color2)',
	'block-color-orange': 'var(--b3-font-color7)',
	'block-color-yellow': 'var(--b3-font-color12)',
	'block-color-teal': 'var(--b3-font-color4)',
	'block-color-blue': 'var(--b3-font-color6)',
	'block-color-purple': 'var(--b3-font-color9)',
	'block-color-pink': 'var(--b3-font-color9)',
	'block-color-red': 'var(--b3-font-color8)',
	'highlight-gray': 'var(--b3-font-color5)',
	'highlight-brown': 'var(--b3-font-color2)',
	'highlight-orange': 'var(--b3-font-color7)',
	'highlight-yellow': 'var(--b3-font-color12)',
	'highlight-teal': 'var(--b3-font-color4)',
	'highlight-blue': 'var(--b3-font-color6)',
	'highlight-purple': 'var(--b3-font-color9)',
	'highlight-pink': 'var(--b3-font-color9)',
	'highlight-red': 'var(--b3-font-color8)',
	'highlight-default': 'inherit',
};

// Map Notion inline highlights to native SiYuan background tokens.
const notionHighlightColors: Record<string, string> = {
	'highlight-gray_background': 'var(--b3-font-background5)',
	'highlight-brown_background': 'var(--b3-font-background2)',
	'highlight-orange_background': 'var(--b3-font-background7)',
	'highlight-yellow_background': 'var(--b3-font-background12)',
	'highlight-teal_background': 'var(--b3-font-background4)',
	'highlight-blue_background': 'var(--b3-font-background6)',
	'highlight-purple_background': 'var(--b3-font-background9)',
	'highlight-pink_background': 'var(--b3-font-background9)',
	'highlight-red_background': 'var(--b3-font-background8)',
	'highlight-default_background': 'transparent',
};

// Map Notion background colors to plugin-scoped CSS variables so the final
// document can mimic Notion more closely in both light and dark themes.
const notionToSiYuanBgStyle: Record<string, string> = {
	'block-color-gray_background': 'background-color: var(--notion-importer-block-color-gray-bg); color: var(--notion-importer-block-color-gray-fg);',
	'block-color-brown_background': 'background-color: var(--notion-importer-block-color-brown-bg); color: var(--notion-importer-block-color-brown-fg);',
	'block-color-orange_background': 'background-color: var(--notion-importer-block-color-orange-bg); color: var(--notion-importer-block-color-orange-fg);',
	'block-color-yellow_background': 'background-color: var(--notion-importer-block-color-yellow-bg); color: var(--notion-importer-block-color-yellow-fg);',
	'block-color-teal_background': 'background-color: var(--notion-importer-block-color-teal-bg); color: var(--notion-importer-block-color-teal-fg);',
	'block-color-blue_background': 'background-color: var(--notion-importer-block-color-blue-bg); color: var(--notion-importer-block-color-blue-fg);',
	'block-color-purple_background': 'background-color: var(--notion-importer-block-color-purple-bg); color: var(--notion-importer-block-color-purple-fg);',
	'block-color-pink_background': 'background-color: var(--notion-importer-block-color-pink-bg); color: var(--notion-importer-block-color-pink-fg);',
	'block-color-red_background': 'background-color: var(--notion-importer-block-color-red-bg); color: var(--notion-importer-block-color-red-fg);',
};

function preserveBlockColors(body: HTMLElement) {
	for (const [className] of Object.entries(notionBlockColors)) {
		const elements = HTMLElementfindAll(body, `.${className}`);
		for (const el of elements) {
			const htmlEl = el as HTMLElement;
			const parent = htmlEl.parentNode;
			if (!parent) continue;
			// Wrap the whole block with markers so the final IAL attaches to the
			// converted block itself rather than to synthetic paragraphs inside it.
			const startMarker = document.createElement('p');
			startMarker.textContent = `SYCOLOR_${className}_START`;
			const endMarker = document.createElement('p');
			endMarker.textContent = `SYCOLOR_END`;
			parent.insertBefore(startMarker, htmlEl);
			if (htmlEl.nextSibling) {
				parent.insertBefore(endMarker, htmlEl.nextSibling);
			} else {
				parent.appendChild(endMarker);
			}
		}
	}
}

// Convert color markers in markdown to SiYuan kramdown IAL attributes
export function convertColorMarkers(markdown: string): string {
	// Lute escapes underscores in plain text, so unescape them in our markers
	markdown = markdown.replace(/SYCOLOR\\_/g, 'SYCOLOR_');
	markdown = markdown.replace(/\\_START/g, '_START');
	markdown = markdown.replace(/\\_END/g, '_END');
	// Also handle cases where underscores within the class name are escaped
	// e.g. block-color-gray\_background -> block-color-gray_background
	markdown = markdown.replace(/(SYCOLOR_block-color-\w+)\\_background/g, '$1_background');

	const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	// Match SYCOLOR_xxx_START ... SYCOLOR_END blocks
	for (const [className, style] of Object.entries(notionToSiYuanBgStyle)) {
		const pattern = new RegExp(
			`${escapeRegExp(`SYCOLOR_${className}_START`)}\\n([\\s\\S]*?)\\n${escapeRegExp('SYCOLOR_END')}(?=\\n|$)`,
			'g'
		);
		markdown = markdown.replace(pattern, (_, content: string) => {
			const trimmed = content.replace(/^\n+|\n+$/g, '');
			if (!trimmed.trim()) return '';
			return `${trimmed}\n{: style="${style}" }`;
		});
	}
	return markdown.replace(/\n{3,}/g, '\n\n');
}

function preserveTextColors(body: HTMLElement) {
	// Gérer les couleurs de texte
	for (const [className, color] of Object.entries(notionTextColors)) {
		const elements = HTMLElementfindAll(body, `.${className}`);
		for (const el of elements) {
			const htmlEl = el as HTMLElement;
			htmlEl.style.color = color;
		}
	}
	
	// Gérer les surlignages (fonds de texte)
	for (const [className, color] of Object.entries(notionHighlightColors)) {
		const elements = HTMLElementfindAll(body, `.${className}`);
		for (const el of elements) {
			const htmlEl = el as HTMLElement;
			htmlEl.style.backgroundColor = color;
			htmlEl.style.padding = '2px 4px';
			htmlEl.style.borderRadius = '3px';
		}
	}
}

function getNodeDepth(node: Node) {
	let depth = 0;
	let cursor = node.parentNode;
	while (cursor) {
		depth += 1;
		cursor = cursor.parentNode;
	}
	return depth;
}

function preserveInlineTextStyles(body: HTMLElement) {
	const selector = [
		...Object.keys(notionTextColors),
		...Object.keys(notionHighlightColors),
	].map((className) => `.${className}`).join(', ');
	const markers = new Map<string, InlineStyleMarker>();
	let markerIndex = 0;

	Array.from(body.querySelectorAll(selector))
		.sort((left, right) => getNodeDepth(right) - getNodeDepth(left))
		.forEach((node) => {
			const htmlEl = node as HTMLElement;
			const parent = htmlEl.parentNode;
			if (!parent) {
				return;
			}

			const marker: InlineStyleMarker = {};
			const styleClasses: string[] = [];

			for (const className of Array.from(htmlEl.classList)) {
				const textColor = notionTextColors[className];
				if (textColor && textColor !== 'inherit') {
					marker.color = textColor;
					styleClasses.push(className);
				}

				const highlightColor = notionHighlightColors[className];
				if (highlightColor && highlightColor !== 'transparent') {
					marker.backgroundColor = highlightColor;
					styleClasses.push(className);
				}
			}

			if (!marker.color && !marker.backgroundColor) {
				return;
			}

			const markerID = `INLINE${markerIndex++}__${Array.from(new Set(styleClasses)).join('__')}`;
			markers.set(markerID, marker);

			parent.insertBefore(document.createTextNode(`SYINLINESTYLE_${markerID}_START`), htmlEl);
			while (htmlEl.firstChild) {
				parent.insertBefore(htmlEl.firstChild, htmlEl);
			}
			parent.insertBefore(document.createTextNode('SYINLINESTYLE_END'), htmlEl);
			htmlEl.remove();
		});

	return markers;
}

function normalizeInlineStyleMarkerEscapes(value: string) {
	return value
		.replace(/<span[^>]*data-type=["']backslash["'][^>]*>_<\/span>/g, '_')
		.replace(/SYINLINESTYLE\\_/g, 'SYINLINESTYLE_')
		.replace(/\\_START/g, '_START')
		.replace(/\\_END/g, '_END');
}

function buildSiYuanInlineTextStyle(marker: InlineStyleMarker) {
	const styles: string[] = [];
	if (marker.color) {
		styles.push(`color: ${marker.color};`);
	}
	if (marker.backgroundColor) {
		styles.push(`background-color: ${marker.backgroundColor};`);
		styles.push(`--b3-parent-background: ${marker.backgroundColor};`);
	}
	return styles.join(' ');
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveEncodedInlineStyleMarker(markerID: string): InlineStyleMarker {
	const marker: InlineStyleMarker = {};
	const classNames = markerID.split('__').slice(1);
	for (const className of classNames) {
		const textColor = notionTextColors[className];
		if (textColor && textColor !== 'inherit') {
			marker.color = textColor;
		}
		const highlightColor = notionHighlightColors[className];
		if (highlightColor && highlightColor !== 'transparent') {
			marker.backgroundColor = highlightColor;
		}
	}
	return marker;
}

export function applyInlineStyleMarkersToBlockDOM(blockDOM: string, markers: Record<string, InlineStyleMarker> = {}) {
	if (!Object.keys(markers).length) {
		const normalized = normalizeInlineStyleMarkerEscapes(blockDOM);
		if (!normalized.includes('SYINLINESTYLE_')) {
			return blockDOM;
		}
	}

	const dom = parseHTML(blockDOM);
	const editableNodes = dom.querySelectorAll('[contenteditable="true"]');

	for (const editableNode of editableNodes) {
		let html = normalizeInlineStyleMarkerEscapes((editableNode as HTMLElement).innerHTML);
		const markerIDs = Array.from(new Set(Array.from(html.matchAll(/SYINLINESTYLE_([A-Za-z0-9_-]+)_START/g)).map((match) => match[1])));
		for (const markerID of markerIDs) {
			const marker = markers[markerID] ?? resolveEncodedInlineStyleMarker(markerID);
			const style = buildSiYuanInlineTextStyle(marker);
			if (!style) {
				continue;
			}
			const pattern = new RegExp(`SYINLINESTYLE_${escapeRegExp(markerID)}_START([\\s\\S]*?)SYINLINESTYLE_END`, 'g');
			html = html.replace(pattern, (_, content: string) => {
				if (!content.trim()) {
					return '';
				}
				return `<span data-type="text" style="${style}">${content}</span>`;
			});
		}
		(editableNode as HTMLElement).innerHTML = html;
	}

	return dom.querySelector('body')?.innerHTML ?? blockDOM;
}

function fixSimpleTables(body: HTMLElement) {
	// Préserver les headers colorés des tableaux simples
	const simpleTables = HTMLElementfindAll(body, 'table.simple-table');
	for (const table of simpleTables) {
		const header = table.querySelector('thead.simple-table-header-color, .simple-table-header');
		if (header) {
			const headerRow = header.querySelector('tr');
			if (headerRow) {
				// Ajouter un style de fond gris clair pour l'en-tête
				const cells = headerRow.querySelectorAll('th, td');
				for (const cell of cells) {
					const htmlCell = cell as HTMLElement;
					htmlCell.style.backgroundColor = 'rgba(247, 246, 243, 1)';
					htmlCell.style.fontWeight = '500';
				}
			}
		}
	}
}

function preserveBadges(body: HTMLElement) {
	// Les badges selected-value avec style inline
	const badges = HTMLElementfindAll(body, 'span.selected-value');
	for (const badge of badges) {
		const htmlBadge = badge as HTMLElement;
		// Préserver le style inline existant
		const existingStyle = htmlBadge.getAttribute('style') || '';
		if (!existingStyle.includes('background-color')) {
			// Couleur par défaut si pas de style
			htmlBadge.style.backgroundColor = 'rgba(206, 205, 202, 0.5)';
		}
		htmlBadge.style.padding = '2px 8px';
		htmlBadge.style.borderRadius = '3px';
		htmlBadge.style.marginRight = '4px';
		htmlBadge.style.display = 'inline-block';
	}
}

function preserveTextDirection(body: HTMLElement) {
	// Préserver les attributs dir="rtl" ou dir="ltr"
	const elementsWithDir = body.querySelectorAll('[dir]');
	for (const el of elementsWithDir) {
		const htmlEl = el as HTMLElement;
		const dir = htmlEl.getAttribute('dir');
		if (dir) {
			htmlEl.style.direction = dir;
		}
	}
}

export async function readToMarkdown(info: NotionResolverInfo, file: ZipEntryFile, pageNotionId?: string): Promise<MarkdownInfo> {
	_currentWarnings = [];
	const text = await file.readText();

	const dom = parseHTML(text);
	const body: HTMLElement = dom.querySelector('div[class=page-body]');

	if (body === null) {
		throw new Error('page body was not found');
	}

	// Extract cover/banner image before processing
	let coverImage = '';
	const coverImg = dom.querySelector('img.page-cover-image') as HTMLImageElement | null;
	const coverDiv = dom.querySelector('div.page-cover-image') as HTMLElement | null;

	if (coverImg) {
		const src = coverImg.getAttribute('src');
		if (src) {
			if (/^https?:\/\//i.test(src)) {
				// External URL - use directly
				coverImage = src;
			} else {
				const decodedSrc = stripParentDirectories(decodeURI(src));
				const attachment = findAttachment(info, decodedSrc) || findAttachmentByFilename(info, decodedSrc);
				if (attachment) {
					coverImage = attachment.pathInSiYuanMd;
				}
			}
		}
	} else if (coverDiv) {
		const style = coverDiv.getAttribute('style') || '';
		const bgMatch = style.match(/background-image:\s*url\(['"]?([^'")\s]+)['"]?\)/);
		if (bgMatch) {
			const bgSrc = bgMatch[1];
			if (/^https?:\/\//i.test(bgSrc)) {
				coverImage = bgSrc;
			} else {
				const decodedSrc = stripParentDirectories(decodeURI(bgSrc));
				const attachment = findAttachment(info, decodedSrc) || findAttachmentByFilename(info, decodedSrc);
				if (attachment) {
					coverImage = attachment.pathInSiYuanMd;
				}
			}
		}
	}

	// Extract page icon — try multiple selectors for different Notion export formats
	let pageIcon = '';
	const iconEl = dom.querySelector('.page-header-icon .icon')
		|| dom.querySelector('span.icon')
		|| dom.querySelector('img.icon');
	if (iconEl) {
		if (iconEl.tagName === 'IMG') {
			const src = (iconEl as HTMLImageElement).getAttribute('src');
			if (src) {
				if (/^https?:\/\//i.test(src)) {
					// External URL icon - not supported as SiYuan icon, skip
				} else {
					const decodedSrc = stripParentDirectories(decodeURI(src));
					const attachment = findAttachment(info, decodedSrc) || findAttachmentByFilename(info, decodedSrc);
					if (attachment) {
						pageIcon = attachment.pathInSiYuanMd;
					}
				}
			}
		} else {
			const emojiText = iconEl.textContent?.trim();
			if (emojiText) {
				// Convert emoji to Unicode codepoint format (e.g., "1f525" for 🔥)
				// SiYuan expects icon values as hex codepoints, not literal emoji chars
				pageIcon = [...emojiText]
					.map(c => c.codePointAt(0).toString(16))
					.join('-');
			}
		}
	}

	cleanInvalidDOM(body);
	preserveBlockColors(body);
	const inlineStyleMarkers = preserveInlineTextStyles(body);
	preserveTextColors(body);
	fixSimpleTables(body);
	preserveBadges(body);
	preserveTextDirection(body);
	normalizeLeadingLinkIconSpacing(body);
	removeNotionPagesSection(body);
	removeTableOfContentsNav(body);

	// Wrap all heading tags in a div to prevent merging with following elements during conversion
	const headings = body.querySelectorAll('h1, h2, h3, h4, h5, h6');
	headings.forEach(heading => {
		const divNode = document.createElement('div');
		divNode.innerHTML = heading.outerHTML;
		heading.replaceWith(divNode);
	});

	// Database processing relies on <a href> to build relations, so it must run before link conversion
	let attributeViews = await getDatabases(info, dom, pageNotionId);

	// Convert all <a> tags to SiYuan bidirectional links
	const notionLinks = getNotionLinks(info, body);
	convertLinksToSiYuanV2(info, notionLinks);

	// Convert standalone <img> elements not wrapped in <a> tags
	convertStandaloneImages(info, body);

	// Convert embedded video elements
	convertVideoElements(info, body);

	// Convert embedded audio elements
	convertAudioElements(info, body);

	let frontMatter: MarkdownInfo['attrs'] = {};

	const rawProperties = dom.querySelector('table[class=properties] > tbody') as HTMLTableSectionElement | undefined;
	if (rawProperties) {
		const propertyLinks = getNotionLinks(info, rawProperties);
		convertLinksToSiYuanV2(info, propertyLinks);
		// YAML only takes raw URLS
		convertHtmlLinksToURLs(rawProperties);

		for (let row of Array.from(rawProperties.rows)) {
			const property = parseProperty(row);
			if (property) {
				property.title = property.title.trim().replace(/ /g, '-');
				if (property.title == 'Tags') {
					property.title = 'tags';
				}
				frontMatter[property.title] = property.content;
			}
		}
	}

	replaceNestedTags(body, 'strong');
	replaceNestedTags(body, 'em');
	fixNotionEmbeds(body, info);
	fixNotionCallouts(body);
	stripLinkFormatting(body);
	fixNotionDates(body);
	fixEquations(body);

	// Some annoying elements Notion throws in as wrappers, which mess up .md
	replaceElementsWithChildren(body, 'div.indented');
	fixToggles(body);
	stripNotionFontSizes(body);
	fixNotionLists(body, 'ul');
	fixNotionLists(body, 'ol');

	fixNotionColumns(body);
	addCheckboxes(body);
	replaceTableOfContents(body);
	formatDatabases(body);

	// Lowercase code block language classes
	// e.g. <code class="language-Mermaid"> -> <code class="language-mermaid">
	dom.querySelectorAll('code[class^=language-]').forEach(codeNode => {
		codeNode.className = codeNode.className.toLowerCase();
	});

	let htmlString = body.innerHTML;

	// Simpler to just use the HTML string for this replacement
	htmlString = splitBrsInFormatting(htmlString, 'strong');
	htmlString = splitBrsInFormatting(htmlString, 'em');


	let markdownBody = htmlToMarkdown(htmlString);

	// Convert column markers to SiYuan super block syntax (must run before
	// singleLineBreaks which would collapse the blank lines super blocks need)
	markdownBody = convertColumnMarkers(markdownBody);
	markdownBody = convertColorMarkers(markdownBody);

	if (info.singleLineBreaks) {
		// Making sure that any blockquote is preceded by an empty line (otherwise messes up formatting with consecutive blockquotes / callouts)
		markdownBody = markdownBody.replace(/\n\n(?!>)/g, '\n');
	}

	markdownBody = escapeHashtags(markdownBody);
	markdownBody = fixDoubleBackslash(markdownBody);

	const description = dom.querySelector('p[class*=page-description]')?.textContent;
	if (description) markdownBody = description + '\n\n' + markdownBody;

	// Cover image is handled via setBlockAttrs (title-img attribute) in Notion.svelte
	// Do NOT prepend it as inline markdown - it would display as a broken/duplicate image

	const attributeViewBlocks: Array<{ avID: string; viewID?: string }> = [];

	// Replace database placeholders in markdown
	markdownBody = markdownBody.replace(/\[:av:([^:\]]+):([^:\]]+):\]/g, (_, avID, viewID) => {
		attributeViewBlocks.push({ avID, viewID });
		return `<div data-type="NodeAttributeView" data-av-id="${avID}" data-av-type="table" custom-sy-av-view="${viewID}"></div>`;
	});
	markdownBody = markdownBody.replace(/\[:av:([^:\]]+):\]/g, (_, avID) => {
		attributeViewBlocks.push({ avID });
		return `<div data-type="NodeAttributeView" data-av-id="${avID}" data-av-type="table"></div>`;
	});

	return {
		'content': markdownBody.trim(),
		'attrs': frontMatter,
		'attributeViews': attributeViews,
		'attributeViewBlocks': attributeViewBlocks,
		'inlineStyleMarkers': Object.fromEntries(inlineStyleMarkers),
		'coverImage': coverImage || undefined,
		'pageIcon': pageIcon || undefined,
		'warnings': _currentWarnings.length > 0 ? [..._currentWarnings] : undefined,
	}
}

const typesMap: Record<NotionProperty['type'], NotionPropertyType[]> = {
	checkbox: ['checkbox'],
	date: ['created_time', 'last_edited_time', 'date'],
	list: ['file', 'multi_select', 'relation'],
	number: ['number', 'auto_increment_id'],
	text: [
		'email',
		'person',
		'phone_number',
		'text',
		'url',
		'status',
		'select',
		'formula',
		'rollup',
		'last_edited_by',
		'created_by',
	],
};

function parseProperty(property: HTMLTableRowElement): {content: string; title: string;} | undefined {
	const notionType = property.className.match(/property-row-(.*)/)?.[1] as NotionPropertyType;
	if (!notionType) {
		throw new Error('property type not found for: ' + property);
	}

	const title = htmlToMarkdown(property.cells[0].textContent ?? '');

	const body = property.cells[1];

	let type = Object.keys(typesMap).find((type: string) =>
		typesMap[type as NotionProperty['type']].includes(notionType)
	) as NotionProperty['type'];

	if (!type) throw new Error('type not found for: ' + body);

	let content: string = '';

	switch (type) {
		case 'checkbox':
			// checkbox-on: checked, checkbox-off: unchecked.
			content = String(body.innerHTML.includes('checkbox-on'));
			break;
		case 'number':
			const numberContent = Number(body.textContent);
			if (isNaN(numberContent)) return;
			content = String(numberContent);
			break;
		case 'date':
			fixNotionDates(body);
			content = body.querySelector('time')?.textContent || '';
			break;
		case 'list':
			const children = body.children;
			const childList: string[] = [];
			for (let i = 0; i < children.length; i++) {
				const itemContent = children.item(i)?.textContent;
				if (!itemContent) continue;
				childList.push(itemContent);
			}
			content = childList.join('\n');
			if (content.length === 0) return;
			break;
		case 'text':
			content = body.textContent ?? '';
			if (content.length === 0) return;
			break;
	}

	return {
		title,
		content,
	};
}

function isImagePath(p: string): boolean {
	return /(\.png|\.jpg|\.webp|\.gif|\.bmp|\.jpeg)\!?\S*$/i.test(p);
}

function isVideoPath(p: string): boolean {
	return /(\.mp4|\.webm|\.mov|\.avi|\.mkv)\!?\S*$/i.test(p);
}

function isAudioPath(p: string): boolean {
	return /(\.mp3|\.wav|\.ogg|\.flac|\.m4a)\!?\S*$/i.test(p);
}

function getDecodedURI(a: HTMLAnchorElement): string {
	return stripParentDirectories(
		decodeURI(a.getAttribute('href') ?? '')
	);
}

function parseInlineStyle(style: string) {
	const declarations: Record<string, string> = {};
	style
		.split(';')
		.map((part) => part.trim())
		.filter(Boolean)
		.forEach((declaration) => {
			const separatorIndex = declaration.indexOf(':');
			if (separatorIndex <= 0) {
				return;
			}
			const key = declaration.slice(0, separatorIndex).trim().toLowerCase();
			const value = declaration.slice(separatorIndex + 1).trim();
			if (key) {
				declarations[key] = value;
			}
		});
	return declarations;
}

function parseJSONAttribute<T>(element: Element | null, attrNames: string[]): T | null {
	if (!element) {
		return null;
	}
	for (const attrName of attrNames) {
		const value = element.getAttribute(attrName);
		if (!value) {
			continue;
		}
		try {
			return JSON.parse(value) as T;
		} catch {
			continue;
		}
	}
	return null;
}

function parseCSVAttribute(element: Element | null, attrNames: string[]) {
	if (!element) {
		return [];
	}
	for (const attrName of attrNames) {
		const value = element.getAttribute(attrName);
		if (!value) {
			continue;
		}
		return value
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean);
	}
	return [];
}

function normalizeWidthValue(value?: string | null) {
	if (!value) {
		return '';
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return '';
	}
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
		return `${trimmed}px`;
	}
	if (/^\d+(?:\.\d+)?(px|%|vw|rem|em)$/.test(trimmed)) {
		return trimmed;
	}
	return '';
}

function extractStyleWidth(node: Element | null) {
	if (!node) {
		return '';
	}
	const style = parseInlineStyle(node.getAttribute('style') || '');
	return normalizeWidthValue(style.width || style['max-width']);
}

function extractStyleAlignment(node: Element | null): NotionImageDisplay['align'] | undefined {
	if (!node) {
		return undefined;
	}
	const style = parseInlineStyle(node.getAttribute('style') || '');
	if (style.width === '100%' || style['max-width'] === '100%') {
		return 'stretch';
	}
	if (style['margin-left'] === 'auto' && style['margin-right'] === 'auto') {
		return 'center';
	}
	if (style['margin-left'] === 'auto') {
		return 'right';
	}
	if (style['margin-right'] === 'auto') {
		return 'left';
	}
	if (style['text-align'] === 'center') {
		return 'center';
	}
	if (style['text-align'] === 'right') {
		return 'right';
	}
	return undefined;
}

export function extractNotionImageDisplay(img: HTMLImageElement): NotionImageDisplay | null {
	const figure = img.closest('figure');
	const wrapper = img.parentElement;
	const width =
		normalizeWidthValue(img.getAttribute('width')) ||
		extractStyleWidth(img) ||
		extractStyleWidth(figure) ||
		extractStyleWidth(wrapper);
	const align =
		extractStyleAlignment(img) ||
		extractStyleAlignment(figure) ||
		extractStyleAlignment(wrapper);

	if (!width && !align) {
		return null;
	}

	return {
		width,
		align,
	};
}

function applyImageDisplay(img: HTMLImageElement, display: NotionImageDisplay | null) {
	const style = parseInlineStyle(img.getAttribute('style') || '');
	style['max-width'] = '100%';
	style.height = style.height || 'auto';

	if (display?.width) {
		style.width = display.width;
	}

	if (display?.align === 'stretch') {
		style.display = 'block';
		style.width = '100%';
		style['margin-left'] = '0';
		style['margin-right'] = '0';
	} else if (display?.align === 'center') {
		style.display = 'block';
		style['margin-left'] = 'auto';
		style['margin-right'] = 'auto';
	} else if (display?.align === 'right') {
		style.display = 'block';
		style['margin-left'] = 'auto';
		delete style['margin-right'];
	} else if (display?.align === 'left') {
		style.display = 'block';
		style['margin-right'] = 'auto';
		delete style['margin-left'];
	}

	const styleValue = Object.entries(style)
		.filter(([, value]) => Boolean(value))
		.map(([key, value]) => `${key}: ${value}`)
		.join('; ');
	if (styleValue) {
		img.setAttribute('style', `${styleValue};`);
	}
}

function getMeaningfulButtonText(button: Element | null) {
	const text = button?.textContent?.replace(/\s+/g, ' ').trim() || '';
	return text && !['Nouveau', 'Modifier les filtres', 'Nouveau/nouvelle page', 'Nouvelle page'].includes(text)
		? text
		: '';
}

function parseDatabaseFilters(containerNode: HTMLElement): NotionDatabaseViewFilter[] {
	return parseJSONAttribute<NotionDatabaseViewFilter[]>(containerNode, [
		'data-notion-filters',
		'data-notion-view-filters',
	]) ?? [];
}

function parseDatabaseSorts(containerNode: HTMLElement): NotionDatabaseViewSort[] {
	return parseJSONAttribute<NotionDatabaseViewSort[]>(containerNode, [
		'data-notion-sorts',
		'data-notion-view-sorts',
	]) ?? [];
}

function parseDatabaseGroupBy(containerNode: HTMLElement): NotionDatabaseViewGroupBy | null {
	return parseJSONAttribute<NotionDatabaseViewGroupBy>(containerNode, [
		'data-notion-group-by',
		'data-notion-view-group-by',
	]);
}

/**
 * Find attachment info matching the given path from info.pathsToAttachmentInfo
 */
function findAttachment(info: NotionResolverInfo, p: string): NotionAttachmentInfo | undefined {
	for (const filename of Object.keys(info.pathsToAttachmentInfo)) {
		if (filename.includes(p)) {
			return info.pathsToAttachmentInfo[filename]
		}
	}
	return undefined;
}

/**
 * Fallback: match by filename only (last path segment).
 * Notion HTML may reference "Business/file.png" but the ZIP path is "Business abc123/file.png".
 */
function findAttachmentByFilename(info: NotionResolverInfo, p: string): NotionAttachmentInfo | undefined {
	const justFilename = p.split('/').pop();
	if (!justFilename) return undefined;
	for (const filename of Object.keys(info.pathsToAttachmentInfo)) {
		if (filename.endsWith('/' + justFilename) || filename === justFilename) {
			return info.pathsToAttachmentInfo[filename];
		}
	}
	return undefined;
}

function getNotionLinks(info: NotionResolverInfo, body: HTMLElement) {
	const links: NotionLink[] = [];

	for (const a of HTMLElementfindAll(body, 'a') as HTMLAnchorElement[]) {
		const decodedURI = getDecodedURI(a);
		const id = getNotionId(decodedURI);

		const attachment = findAttachment(info, decodedURI) || findAttachmentByFilename(info, decodedURI);
		if (id && decodedURI.endsWith('.html')) {
			links.push({ type: 'relation', a, id });
		}
		else if (attachment) {
			let link_type: NotionLink['type'] = 'attachment';
			if (isImagePath(decodedURI)) {
				link_type = 'image'
			}
			links.push({
				type: link_type,
				a,
				path: attachment.path,
			});
		}
	}

	return links;
}

/**
 * Convert standalone <img> elements (not wrapped in <a> tags) to use SiYuan asset paths
 */
function convertStandaloneImages(info: NotionResolverInfo, body: HTMLElement) {
	const images = HTMLElementfindAll(body, 'img') as HTMLImageElement[];
	for (const img of images) {
		if (
			img.classList.contains('icon') ||
			img.classList.contains('notion-emoji') ||
			img.closest('.page-header-icon, .property-icon, span.icon')
		) {
			continue;
		}

		const imageDisplay = extractNotionImageDisplay(img);
		const src = img.getAttribute('src');
		if (!src) continue;

		const decodedSrc = stripParentDirectories(decodeURI(src));
		const attachment = findAttachment(info, decodedSrc) || findAttachmentByFilename(info, decodedSrc);
		if (attachment) {
			img.setAttribute('src', attachment.pathInSiYuanMd);
			if (!img.getAttribute('alt')) {
				img.setAttribute('alt', attachment.nameWithExtension);
			}
		}
		applyImageDisplay(img, imageDisplay);
	}
}

/**
 * Convert embedded <video> elements to use SiYuan asset paths
 */
function convertVideoElements(info: NotionResolverInfo, body: HTMLElement) {
	const videos = HTMLElementfindAll(body, 'video') as HTMLVideoElement[];
	for (const video of videos) {
		// Try to get src from the video element itself or from a <source> child
		let src = video.getAttribute('src');
		if (!src) {
			const source = video.querySelector('source');
			src = source?.getAttribute('src') ?? null;
		}
		if (!src) continue;

		const decodedSrc = stripParentDirectories(decodeURI(src));
		const attachment = findAttachment(info, decodedSrc) || findAttachmentByFilename(info, decodedSrc);
		if (attachment) {
			// Replace with a clean video element
			const newVideo = createEl('video');
			newVideo.setAttribute('controls', 'controls');
			newVideo.setAttribute('src', attachment.pathInSiYuanMd);
			video.replaceWith(newVideo);
		}
	}
}

/**
 * Convert embedded <audio> elements to use SiYuan asset paths
 */
function convertAudioElements(info: NotionResolverInfo, body: HTMLElement) {
	const audios = HTMLElementfindAll(body, 'audio') as HTMLAudioElement[];
	for (const audio of audios) {
		let src = audio.getAttribute('src');
		if (!src) {
			const source = audio.querySelector('source');
			src = source?.getAttribute('src') ?? null;
		}
		if (!src) continue;

		const decodedSrc = stripParentDirectories(decodeURI(src));
		const attachment = findAttachment(info, decodedSrc) || findAttachmentByFilename(info, decodedSrc);
		if (attachment) {
			const newAudio = createEl('audio');
			newAudio.setAttribute('controls', 'controls');
			newAudio.setAttribute('src', attachment.pathInSiYuanMd);
			audio.replaceWith(newAudio);
		}
	}
}

function fixDoubleBackslash(markdownBody: string) {
	// Persistent error during conversion where backslashes in full-path links written as '\\|' become double-slashes \\| in the markdown.
	// In tables, we have to use \| in internal links. This corrects the erroneous \\| in markdown.

	const slashSearch = /\[\[[^\]]*(\\\\)\|[^\]]*\]\]/;
	const doubleSlashes = markdownBody.match(new RegExp(slashSearch, 'g'));
	doubleSlashes?.forEach((slash) => {
		markdownBody = markdownBody.replace(
			slash,
			slash.replace(/\\\\\|/g, '\u005C|')
		);
	});

	return markdownBody;
}

function fixEquations(body: HTMLElement) {
	for (const ele of HTMLElementfindAll(body, '.katex-html')) {
		ele.remove();
	}
	const mathEls = HTMLElementfindAll(body, 'math');
	for (const mathEl of mathEls) {
		const annotation = mathEl.querySelector('annotation')
		if (!annotation) continue;
		annotation.textContent = annotation.textContent.trim();
		// Skip if already a block-level formula
		if (/\\begin\{.*?\}[\s\S]+\\end\{.*?\}/gmi.test(annotation.textContent)) continue;

		mathEl.replaceWith(annotation)
	}
}

function stripToSentence(paragraph: string) {
	const firstSentence = paragraph.match(/^[^\.\?\!\n]*[\.\?\!]?/)?.[0];
	return firstSentence ?? '';
}

function fixNotionCallouts(body: HTMLElement) {
	for (let callout of HTMLElementfindAll(body, 'figure.callout')) {
		const blockquote = createEl('blockquote');
		const span = createSpan();
		span.textContent = '[!important]';
		blockquote.replaceChildren(...callout.childNodes);
		blockquote.insertBefore(span, blockquote.firstChild);
		callout.replaceWith(blockquote);
	}

	// Downgrade headings (h1-h6) inside blockquotes to plain paragraphs.
	// Notion exports callout text as headings (e.g. h3) based on the visual
	// font-size, but in SiYuan blockquotes these render far too large.
	for (const bq of Array.from(body.querySelectorAll('blockquote')) as HTMLElement[]) {
		for (const heading of Array.from(bq.querySelectorAll('h1, h2, h3, h4, h5, h6')) as HTMLElement[]) {
			const p = createEl('p');
			p.innerHTML = heading.innerHTML;
			heading.replaceWith(p);
		}
	}
}

function fixNotionEmbeds(body: HTMLElement, info?: NotionResolverInfo) {
	// Convert Notion bookmark embeds to simple links.
	// Notion exports bookmarks as <a class="bookmark source"> with title/description/image
	// children. We convert them to a plain <p><a href="url">title</a></p>.
	for (let embed of HTMLElementfindAll(body, 'a.bookmark.source')) {
		const link = embed.getAttribute('href') ?? '';
		const title = embed.querySelector('div.bookmark-title')?.textContent?.trim() || link;

		const p = createEl('p');
		const linkEl = createEl('a');
		linkEl.setAttribute('href', link);
		linkEl.textContent = title;
		p.appendChild(linkEl);
		embed.replaceWith(p);
	}
}

// Map Notion select-value-color classes to SiYuan color names
const notionSelectColorToSiYuan: Record<string, string> = {
	'select-value-color-default': '1',
	'select-value-color-gray': '2',
	'select-value-color-brown': '3',
	'select-value-color-orange': '4',
	'select-value-color-yellow': '5',
	'select-value-color-green': '6',
	'select-value-color-blue': '7',
	'select-value-color-purple': '8',
	'select-value-color-pink': '9',
	'select-value-color-red': '10',
};

// Extract color from a select/option element
function extractSelectColor(el: HTMLElement): string {
	for (const className of el.classList) {
		if (notionSelectColorToSiYuan[className]) {
			return notionSelectColorToSiYuan[className];
		}
	}
	return '1'; // default color
}

function formatDatabases(body: HTMLElement) {
	// Notion includes user SVGs which aren't relevant to Markdown, so change them to pure text.
	for (const user of HTMLElementfindAll(body, 'span[class=user]')) {
		user.innerText = user.textContent ?? '';
	}

	for (const checkbox of HTMLElementfindAll(body, 'td div[class*=checkbox]')) {
		const newCheckbox = createSpan();
		newCheckbox.textContent = checkbox.classList.contains('checkbox-on') ? 'X' : '';
		checkbox.replaceWith(newCheckbox);
	}

	for (const select of HTMLElementfindAll(body, 'table span[class*=selected-value]')) {
		const lastChild = select.parentElement?.lastElementChild;
		if (lastChild === select) continue;
		select.textContent = select.textContent + ', ';
	}

	for (const a of HTMLElementfindAll(body, 'a[href]') as HTMLAnchorElement[]) {
		// Strip URLs which aren't valid, changing them to normal text.
		if (!/^(https?:\/\/|www\.)/.test(a.href)) {
			const strippedURL = createSpan();
			strippedURL.textContent = a.textContent ?? '';
			a.replaceWith(strippedURL);
		}
	}
}

function replaceNestedTags(body: HTMLElement, tag: 'strong' | 'em') {
	for (const el of HTMLElementfindAll(body, tag)) {
		if (!el.parentElement || el.parentElement.tagName === tag.toUpperCase()) {
			continue;
		}
		let firstNested = el.querySelector(tag);
		while (firstNested) {
			hoistChildren(firstNested);
			firstNested = el.querySelector(tag);
		}
	}
}

function splitBrsInFormatting(htmlString: string, tag: 'strong' | 'em') {
	const tags = htmlString.match(new RegExp(`<${tag}>(.|\n)*</${tag}>`));
	if (!tags) return htmlString;
	for (let tag of tags.filter((tag) => tag.includes('<br />'))) {
		htmlString = htmlString.replace(
			tag,
			tag.split('<br />').join(`</${tag}><br /><${tag}>`)
		);
	}
	return htmlString;
}

function replaceTableOfContents(body: HTMLElement) {
	const tocLinks = HTMLElementfindAll(body, 'a[href*=\\#]') as HTMLAnchorElement[];
	for (const link of tocLinks) {
		if (link.getAttribute('href')?.startsWith('#')) {
			link.setAttribute('href', '#' + link.textContent);
		}
	}
}

function stripLinkFormatting(body: HTMLElement) {
	for (const link of HTMLElementfindAll(body, 'link')) {
		link.innerText = link.textContent ?? '';
	}
}

function fixNotionDates(body: HTMLElement) {
	// Notion dates always start with @
	for (const time of HTMLElementfindAll(body, 'time')) {
		time.textContent = time.textContent?.replace(/@/g, '') ?? '';
	}
}

/**
 * Strip Notion's inline font-size (and line-height) styles from all elements.
 * Notion uses inline font-size on toggle headings, callout text, etc.
 * These must be removed so SiYuan applies its own default typography.
 */
function stripNotionFontSizes(body: HTMLElement) {
	for (const el of Array.from(body.querySelectorAll('[style]')) as HTMLElement[]) {
		const style = el.getAttribute('style') ?? '';
		// Remove font-size and line-height declarations from inline style
		const cleaned = style
			.replace(/font-size\s*:[^;]+;?/gi, '')
			.replace(/line-height\s*:[^;]+;?/gi, '')
			.trim();
		if (cleaned) {
			el.setAttribute('style', cleaned);
		} else {
			el.removeAttribute('style');
		}
	}
}

function replaceElementsWithChildren(body: HTMLElement, selector: string) {
	let els = HTMLElementfindAll(body, selector);
	for (const el of els) {
		hoistChildren(el);
	}
}

function fixNotionLists(body: HTMLElement, tagName: 'ul' | 'ol') {
	// Notion creates each list item within its own <ol> or <ul>, messing up newlines in the converted Markdown.
	// Iterate all adjacent <ul>s or <ol>s and replace each string of adjacent lists with a single <ul> or <ol>.
	for (const htmlList of HTMLElementfindAll(body, tagName)) {
		const htmlLists: HTMLElement[] = [];
		const listItems: HTMLElement[] = [];
		let nextAdjacentList: HTMLElement = htmlList;

		while (nextAdjacentList.tagName === tagName.toUpperCase()) {
			htmlLists.push(nextAdjacentList);
			for (let i = 0; i < nextAdjacentList.children.length; i++) {
				listItems.push(nextAdjacentList.children[i] as HTMLElement);
			}
			// classes are always "to-do-list, bulleted-list, or numbered-list"
			if (!nextAdjacentList.nextElementSibling || nextAdjacentList.getAttribute('class') !== nextAdjacentList.nextElementSibling.getAttribute('class')) break;
			nextAdjacentList = nextAdjacentList.nextElementSibling as HTMLElement;
		}

		const joinedList = createEl(tagName);
		for (const li of listItems) {
			joinedList.appendChild(li);
		}

		htmlLists[0].replaceWith(joinedList);
		htmlLists.slice(1).forEach(htmlList => htmlList.remove());
	}
}

/**
 * Convert Notion column layouts to SiYuan super block columns.
 * Notion uses div.column-list > div.column for side-by-side columns.
 * SiYuan supports {{{row ... }}} super blocks for horizontal layouts
 * with nested {{{col ... }}} for each column's vertical content.
 *
 * We inject text markers in the HTML that survive Lute conversion,
 * then replace them with super block syntax in post-processing.
 */
/**
 * Remove the Notion-generated "Pages" section appended at the bottom of every
 * page that has child pages. The section is: optional <hr>, <h2>Pages</h2>
 * (exact text varies by export language), then figure.link-to-page elements —
 * all direct children of the page body after display:contents wrappers are stripped.
 * These are redundant since sub-pages are accessible via the SiYuan document tree.
 */
function removeNotionPagesSection(body: HTMLElement) {
	const PAGE_HEADINGS = new Set(['pages', 'sous-pages', 'sub-pages', 'subpages', 'page']);
	for (const h of Array.from(body.querySelectorAll(':scope > h1, :scope > h2, :scope > h3'))) {
		if (!PAGE_HEADINGS.has(h.textContent?.trim().toLowerCase() ?? '')) continue;
		const toRemove: Element[] = [h];
		// Remove preceding <hr> separator if present
		const prev = h.previousElementSibling;
		if (prev?.tagName === 'HR') toRemove.push(prev);
		// Remove all following figure.link-to-page siblings
		let next = h.nextElementSibling;
		while (next?.tagName === 'FIGURE' && next.classList.contains('link-to-page')) {
			toRemove.push(next);
			next = next.nextElementSibling;
		}
		toRemove.forEach(el => el.remove());
		break;
	}
}

/**
 * Remove <nav class="table_of_contents"> elements from the body.
 * These are auto-generated navigation menus in Notion exports and should not be imported.
 */
function removeTableOfContentsNav(body: HTMLElement) {
	for (const nav of Array.from(body.querySelectorAll('nav[class*="table_of_contents"]'))) {
		nav.remove();
	}
}

function fixNotionColumns(body: HTMLElement) {
	// Convert figure.link-to-page to <p> elements globally.
	// Figures may not produce block breaks inside blockquotes when they contain
	// only inline spans (after link conversion), but <p> always creates a block.
	for (const figure of HTMLElementfindAll(body, 'figure.link-to-page')) {
		const p = document.createElement('p');
		while (figure.firstChild) {
			p.appendChild(figure.firstChild);
		}
		figure.replaceWith(p);
	}

	// Handle column-list containers (display:contents wrappers already stripped
	// in cleanInvalidDOM, so div.column are now direct children)
	for (const columnList of HTMLElementfindAll(body, 'div.column-list')) {
		// Remove ALL <hr> elements inside column-list (Notion uses them as decorative
		// separators between the column title and its links; they become "---" in markdown)
		for (const hr of Array.from(columnList.querySelectorAll('hr'))) {
			hr.remove();
		}

		const columns = Array.from(columnList.querySelectorAll(':scope > div.column'));
		if (columns.length === 0) {
			hoistChildren(columnList as HTMLElement);
			continue;
		}

		const fragment = document.createDocumentFragment();

		// Super block row start marker
		const rowStart = document.createElement('p');
		rowStart.textContent = 'SYCOLROWSTART';
		fragment.appendChild(rowStart);

		columns.forEach((column) => {
			let columnBackgroundClass: string | null = null;

			for (const bq of Array.from(column.querySelectorAll(':scope > blockquote'))) {
				const bgClass = Array.from(bq.classList).find((className) => className in notionToSiYuanBgStyle);
				if (!columnBackgroundClass && bgClass) {
					columnBackgroundClass = bgClass;
				}
				if (!bgClass) {
					continue;
				}

				const prev = bq.previousElementSibling as HTMLElement | null;
				if (prev?.tagName === 'P' && prev.textContent === `SYCOLOR_${bgClass}_START`) {
					prev.remove();
				}
				const next = bq.nextElementSibling as HTMLElement | null;
				if (next?.tagName === 'P' && next.textContent === 'SYCOLOR_END') {
					next.remove();
				}
			}

			if (columnBackgroundClass) {
				const colBgStart = document.createElement('p');
				colBgStart.textContent = `SYCOLOR_${columnBackgroundClass}_START`;
				fragment.appendChild(colBgStart);
			}

			// Column start marker
			const colStart = document.createElement('p');
			colStart.textContent = 'SYCOLCOLSTART';
			fragment.appendChild(colStart);

			// Unwrap blockquotes — take inner content directly
			// (blockquotes are just Notion's column wrapper, not semantic quotes)
			for (const bq of Array.from(column.querySelectorAll(':scope > blockquote'))) {
				// Wrap any leading inline/text nodes (e.g. the column section title:
				// "👁 <a>Général</a>") in a <p> so Lute doesn't merge them with the
				// first block element that follows.
				const BLOCK_TAGS = new Set(['P','DIV','H1','H2','H3','H4','H5','H6','UL','OL','BLOCKQUOTE','FIGURE','TABLE','HR','PRE']);
				const leadingNodes: ChildNode[] = [];
				for (const child of Array.from(bq.childNodes)) {
					if (child.nodeType === 1 && BLOCK_TAGS.has((child as Element).tagName)) break;
					leadingNodes.push(child);
				}
				if (leadingNodes.length > 0 && leadingNodes.some(n => n.textContent?.trim())) {
					const wrapper = document.createElement('p');
					leadingNodes.forEach(n => wrapper.appendChild(n));
					bq.insertBefore(wrapper, bq.firstChild);
				}
				const className = bq.className || '';
				const bgClass = Array.from(bq.classList).find((name) => name in notionToSiYuanBgStyle);
				if (bgClass) {
					while (bq.firstChild) {
						bq.parentElement.insertBefore(bq.firstChild, bq);
					}
					bq.remove();
					continue;
				}
				const keepAsBlockquote =
					/\b(block-color-|highlight-|quote-large|quote)\b/.test(className)
					|| bq.querySelector('figure, table, ul.toggle, details, img, video, audio, a.bookmark.source') !== null;
				if (keepAsBlockquote) {
					continue;
				}
				while (bq.firstChild) {
					bq.parentElement.insertBefore(bq.firstChild, bq);
				}
				bq.remove();
			}

			while (column.firstChild) {
				fragment.appendChild(column.firstChild);
			}

			// Column end marker
			const colEnd = document.createElement('p');
			colEnd.textContent = 'SYCOLCOLEND';
			fragment.appendChild(colEnd);
			if (columnBackgroundClass) {
				const colBgEnd = document.createElement('p');
				colBgEnd.textContent = 'SYCOLOR_END';
				fragment.appendChild(colBgEnd);
			}
		});

		// Super block row end marker
		const rowEnd = document.createElement('p');
		rowEnd.textContent = 'SYCOLROWEND';
		fragment.appendChild(rowEnd);

		columnList.replaceWith(fragment);
	}

	// Clean up any remaining orphan column divs
	for (const col of HTMLElementfindAll(body, 'div.column')) {
		hoistChildren(col);
	}
}

function normalizeLeadingLinkIconSpacing(body: HTMLElement) {
	const blocks = HTMLElementfindAll(body, 'blockquote, p, h1, h2, h3, h4, h5, h6, li');

	for (const block of blocks) {
		let firstNode = block.firstChild;
		while (firstNode && firstNode.nodeType === Node.TEXT_NODE && !(firstNode.textContent ?? '').trim()) {
			firstNode = firstNode.nextSibling;
		}

		if (firstNode?.nodeType === Node.TEXT_NODE) {
			const textNode = firstNode as Text;
			const text = textNode.textContent ?? '';
			const trimmed = text.replace(/\u200b/g, '').trimEnd();
			let nextNode = textNode.nextSibling;
			while (nextNode && nextNode.nodeType === Node.TEXT_NODE && !(nextNode.textContent ?? '').trim()) {
				nextNode = nextNode.nextSibling;
			}
			if (
				trimmed
				&& /\p{Extended_Pictographic}$/u.test(trimmed)
				&& nextNode?.nodeType === Node.ELEMENT_NODE
				&& (nextNode as Element).tagName === 'A'
				&& !/[ \t\u00a0]$/.test(text)
			) {
				textNode.textContent = `${text} `;
			}
		}

		const firstElement = Array.from(block.childNodes).find(
			(node) => node.nodeType === Node.ELEMENT_NODE,
		) as HTMLElement | undefined;
		if (!firstElement?.matches('span.icon, img.icon')) {
			continue;
		}

		const nextSibling = firstElement.nextSibling;
		if (nextSibling?.nodeType === Node.TEXT_NODE && /^[ \t\u00a0]/.test(nextSibling.textContent ?? '')) {
			continue;
		}
		firstElement.after(document.createTextNode(' '));
	}
}

/**
 * Convert column text markers to SiYuan super block syntax.
 * Markers are injected as paragraph text in fixNotionColumns and survive
 * Lute's HTML-to-Markdown conversion as plain paragraphs.
 */
export function convertColumnMarkers(md: string): string {
	// Replace markers without consuming surrounding newlines — each marker
	// gets its own newlines so they always land on separate lines, even when
	// Lute merges adjacent <p> elements.
	// Outer column-list → {{{col (flex-direction:row = horizontal layout)
	// Inner per-column wrapper → {{{row (flex-direction:column = vertical within each column)
	md = md.replace(/SYCOLROWSTART/g, '\n{{{col\n');
	md = md.replace(/SYCOLROWEND/g, '\n}}}\n');
	md = md.replace(/SYCOLCOLSTART/g, '\n{{{row\n');
	md = md.replace(/SYCOLCOLEND/g, '\n}}}\n');
	// Fold markers are kept as unique text strings (NOT converted to {{{fold/}}}).
	// Reason: {{{fold ... }}} inside a {{{row ... }}} causes Lute's parser to
	// consume the first }}} it sees as the row's closing marker, so the fold's
	// }}} never lands in the document as a paragraph. fixFoldBlocks() searches
	// for these unique strings directly and converts them to proper fold super
	// blocks via the SiYuan API after the document has been written.
	md = md.replace(/SYFOLDFOLDSTART/g, '\n\nSYFOLDFOLDSTART\n\n');
	md = md.replace(/SYFOLDFOLDEND/g, '\n\nSYFOLDFOLDEND\n\n');
	// Collapse runs of 3+ newlines to double newlines (blank line)
	md = md.replace(/\n{3,}/g, '\n\n');
	return md;
}

/**
 * Convert a single <details> element into fold block markers.
 * Shared helper used for both ul.toggle-wrapped and standalone details.
 */
function convertDetailsToFold(details: HTMLElement) {
	const summary = details.querySelector('summary');
	const summaryText = summary?.textContent?.replace(/\u200b/g, '').trim() || '\u200b';

	// Use text markers (like column system) so they survive Lute conversion.
	// {{{fold must be on its own line with NO text — the title goes on the
	// next line as a separate paragraph.
	const foldStart = createEl('p');
	foldStart.textContent = 'SYFOLDFOLDSTART';

	const summaryPara = createEl('p');
	summaryPara.textContent = summaryText;

	const foldEnd = createEl('p');
	foldEnd.textContent = 'SYFOLDFOLDEND';

	details.parentElement?.insertBefore(foldStart, details);
	details.parentElement?.insertBefore(summaryPara, details);

	// Move all content from details except <summary>
	const children = Array.from(details.childNodes).filter(
		n => !(n.nodeType === 1 && (n as Element).tagName === 'SUMMARY')
	);
	for (const child of children) {
		details.parentElement?.insertBefore(child, details);
	}

	details.parentElement?.insertBefore(foldEnd, details);
	details.remove();
}

function fixToggles(body: HTMLElement) {
	// Handle ul.toggle wrapped toggles
	const toggles = HTMLElementfindAll(body, 'ul.toggle');
	for (const toggle of toggles) {
		const details = toggle.querySelector('details');
		if (!details) {
			hoistChildren(toggle);
			continue;
		}
		convertDetailsToFold(details);
		// Unwrap <li> and <ul> wrappers to keep the fold content in the DOM.
		// Previously toggle.remove() deleted ALL content including images.
		const li = toggle.querySelector('li');
		if (li) hoistChildren(li);
		hoistChildren(toggle);
	}

	// Handle standalone <details> elements (e.g. inside column divs)
	// that are NOT already inside a ul.toggle wrapper.
	for (const details of Array.from(body.querySelectorAll('details')) as HTMLElement[]) {
		if (details.closest('ul.toggle')) continue;
		convertDetailsToFold(details);
	}
}

function addCheckboxes(body: HTMLElement) {
	// To-do lists: handle strikethrough FIRST, before the generic .checkbox replacement
	// removes the .checkbox elements that we need to query here.
	for (const toDoList of HTMLElementfindAll(body, 'ul.to-do-list')) {
		const items = toDoList.querySelectorAll('li');
		for (const item of items) {
			const checkbox = item.querySelector('.checkbox');
			const checkedSpan = item.querySelector('.to-do-children-checked');
			if (checkbox && checkbox.classList.contains('checkbox-on') && checkedSpan) {
				const del = createEl('del');
				del.textContent = checkedSpan.textContent || '';
				checkedSpan.replaceWith(del);
			}
		}
	}

	// Generic checkboxes (tables, properties, etc.)
	for (let checkboxEl of HTMLElementfindAll(body, '.checkbox.checkbox-on')) {
		checkboxEl.replaceWith('[x] ');
	}
	for (let checkboxEl of HTMLElementfindAll(body, '.checkbox.checkbox-off')) {
		checkboxEl.replaceWith('[ ] ');
	}
}

function convertHtmlLinksToURLs(content: HTMLElement) {
	const links = HTMLElementfindAll(content, 'a') as HTMLAnchorElement[];

	if (links.length === 0) return content;
	for (const link of links) {
		const span = createSpan();
		span.textContent = link.getAttribute('href') ?? '';
		link.replaceWith(span);
	}
}

function convertLinksToSiYuan(info: NotionResolverInfo, notionLinks: NotionLink[]) {
	for (let link of notionLinks) {
		let siyuanLink = createSpan();

		switch (link.type) {
			case 'relation':
				const linkInfo = info.idsToFileInfo[link.id];
				if (linkInfo && linkInfo.blockID !== '') {
					// Vérifier d'abord les icônes images
					const imgIcon = link.a.querySelector('img.icon') as HTMLImageElement | null;
					const iconSpan = link.a.querySelector('span.icon');
					
					if (imgIcon) {
						// SiYuan block reference anchor text is plain text — images can't render
						// inside it. Just use the page title as anchor text.
						siyuanLink.textContent = `((${linkInfo.blockID} '${linkInfo.displayTitle || linkInfo.title}'))`;
						break;
					}
					
					// Fallback sur les emojis texte
					const iconText = iconSpan?.textContent?.trim() || '';
					const displayText = iconText ? `${iconText} ${linkInfo.displayTitle || linkInfo.title}` : (linkInfo.displayTitle || linkInfo.title);
					siyuanLink.textContent = `((${linkInfo.blockID} '${displayText}'))`;
				} else {
					addImportWarning('missing relation data for id: ' + link.id);
					const { basename } = parseFilePath(
						decodeURI(link.a.getAttribute('href') ?? '')
					);
					siyuanLink.textContent = `[[${stripNotionId(basename)}]]`;
				}
				break;
			case 'attachment':
				let attachmentInfo = info.pathsToAttachmentInfo[link.path];
				if (!attachmentInfo) {
					addImportWarning('missing attachment data for: ' + link.path);
					continue;
				}
				siyuanLink.textContent = `[${attachmentInfo.nameWithExtension}](${attachmentInfo.pathInSiYuanMd})`;
				break;
			case 'image':
				siyuanLink = createEl('img')
				let imageInfo = info.pathsToAttachmentInfo[link.path];
				if (!imageInfo) {
					addImportWarning('missing image file for: ' + link.path);
					continue;
				}
				siyuanLink.setAttribute('src', imageInfo.pathInSiYuanMd);
				siyuanLink.setAttribute('alt', imageInfo.nameWithExtension);
				break;
		}

		link.a.replaceWith(siyuanLink);
	}
}

// Remove DOM elements that cause SiYuan Lute parser errors
function cleanInvalidDOM(body: HTMLElement) {
	for (const ele of HTMLElementfindAll(body, 'script[src]')) {
		ele.remove();
	}
    for (const ele of HTMLElementfindAll(body, 'link[rel="stylesheet"]')) {
		ele.remove();
	}
	for (const ele of HTMLElementfindAll(body, 'style')) {
		// KaTeX formulas may have <style>@import url('...katex.min.css')</style> before them
		ele.remove();
	}
	// Strip display:contents wrapper divs - Notion wraps nearly every content block
	// in <div style="display:contents"> which are layout artifacts that prevent
	// proper block separation and break CSS child selectors during conversion.
	// Process in reverse (deepest first) for clean unwrapping of nested wrappers.
	const wrappers = Array.from(body.querySelectorAll('div[style*="display:contents"]'));
	for (let i = wrappers.length - 1; i >= 0; i--) {
		hoistChildren(wrappers[i] as HTMLElement);
	}
}

// Generate a column key object with the given info
function generateColumnKey(name: string, colType: string, options: any[]) {
	return {
		"id": generateSiYuanID(),
		"name": name,
		"type": colType,
		"icon": "",
		"numberFormat": "",
		"template": "",
		"options": options,
	}
}

// Map Notion icon image URLs to column type identifiers
const notionIconToType: Record<string, string> = {
	'font': 'typesTitle',
	'text': 'typesText',
	'checkmark-square': 'typesCheckbox',
	'calendar': 'typesDate',
	'number-sign': 'typesNumber',
	'list-selection': 'typesSelect',
	'menu-list': 'typesMultipleSelect',
	'status': 'typesStatus',
	'link': 'typesUrl',
	'email': 'typesEmail',
	'phone': 'typesPhone',
	'file': 'typesFile',
	'created-time': 'typesCreatedTime',
	'edited-time': 'typesLastEditedTime',
	'relation': 'typesRelation',
	'person': 'typesText',
	'formula': 'typesText',
	'rollup': 'typesText',
};

// Detect column type from <th> header element
function detectColumnType(th: HTMLElement): string {
	// Try SVG class (older Notion exports)
	const svg = th.querySelector('span > svg');
	if (svg && svg.classList[0]) return svg.classList[0];
	// Try img src URL (newer Notion exports use <img src="notion.so/icons/...">)
	const img = th.querySelector('span > img') as HTMLImageElement | null;
	if (img) {
		const src = img.getAttribute('src') || '';
		for (const [iconName, typeName] of Object.entries(notionIconToType)) {
			if (src.includes(iconName)) return typeName;
		}
	}
	return 'typesText';
}

// Parse a CSV string into a 2D array, handling quoted fields
function parseCSV(text: string): string[][] {
	// Strip BOM
	if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
	const rows: string[][] = [];
	let i = 0;
	while (i < text.length) {
		const row: string[] = [];
		while (i < text.length) {
			if (text[i] === '"') {
				// Quoted field
				i++;
				let val = '';
				while (i < text.length) {
					if (text[i] === '"') {
						if (i + 1 < text.length && text[i + 1] === '"') {
							val += '"';
							i += 2;
						} else {
							i++; // closing quote
							break;
						}
					} else {
						val += text[i];
						i++;
					}
				}
				row.push(val);
				if (i < text.length && text[i] === ',') i++;
				else if (i < text.length && (text[i] === '\n' || text[i] === '\r')) {
					if (text[i] === '\r' && i + 1 < text.length && text[i + 1] === '\n') i += 2;
					else i++;
					break;
				}
			} else {
				// Unquoted field
				let val = '';
				while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
					val += text[i];
					i++;
				}
				row.push(val);
				if (i < text.length && text[i] === ',') i++;
				else if (i < text.length && (text[i] === '\n' || text[i] === '\r')) {
					if (text[i] === '\r' && i + 1 < text.length && text[i + 1] === '\n') i += 2;
					else i++;
					break;
				}
			}
		}
		if (row.length > 0 && !(row.length === 1 && row[0] === '')) {
			rows.push(row);
		}
	}
	return rows;
}

type DatabaseCellValue = string | string[] | boolean;

type DatabaseColumn = {
	type: string;
	name: string;
	selectValues: Set<string>;
	selectColors: Record<string, string>;
	values: Array<{
		rowid: string;
		hasRelBlock: boolean;
		value: DatabaseCellValue;
	}>;
};

type ParsedDatabaseRow = {
	notionRowID?: string;
	rowid: string;
	hasRelBlock: boolean;
	values: DatabaseCellValue[];
	displayValues: string[];
	signature: string;
	titleKey: string;
};

type DatabaseTableInfo = {
	title: string;
	viewName: string;
	viewSpec: NotionDatabaseViewSpec;
	tableNode: HTMLElement;
	containerNode: HTMLElement;
	collectionId?: string;
	pagePath?: string;
};

type BuiltDatabaseTable = {
	title: string;
	viewName: string;
	viewSpec: NotionDatabaseViewSpec;
	cols: DatabaseColumn[];
	rows: ParsedDatabaseRow[];
	databaseIdentity: string | null;
	csvCollectionPath: string;
	pageCollectionPath: string;
	rowCollectionPaths: string[];
	notionRowIDs: string[];
};

type SharedDatabaseColumn = {
	normalizedName: string;
	name: string;
	type: string;
	keyID: string;
	selectValues: Set<string>;
	selectColors: Record<string, string>;
	numberDisplay: NotionNumberDisplaySpec;
};

type SharedDatabaseRow = {
	key: string;
	notionRowID?: string;
	rowid: string;
	hasRelBlock: boolean;
	valuesByColumn: Record<string, DatabaseCellValue>;
	displayValuesByColumn: Record<string, string>;
};

type SharedDatabaseView = {
	id: string;
	name: string;
	rowKeys: string[];
	visibleColumnNames: string[];
	filters: NotionDatabaseViewFilter[];
	sorts: NotionDatabaseViewSort[];
	groupBy: NotionDatabaseViewGroupBy | null;
};

type SharedDatabaseState = {
	avID: string;
	name: string;
	defaultViewID: string;
	columns: SharedDatabaseColumn[];
	rowsByKey: Map<string, SharedDatabaseRow>;
	rowKeysInOrder: string[];
	views: SharedDatabaseView[];
	avData: any;
};

function decodeNotionValue(value: string) {
	try {
		return decodeURI(value);
	} catch {
		return value;
	}
}

function convertLinksToSiYuanV2(info: NotionResolverInfo, notionLinks: NotionLink[]) {
	for (const link of notionLinks) {
		let siyuanLink = createSpan();

		switch (link.type) {
			case 'relation': {
				const linkInfo = info.idsToFileInfo[link.id];
				if (linkInfo && linkInfo.blockID !== '') {
					siyuanLink.textContent = `((${linkInfo.blockID} '${linkInfo.displayTitle || linkInfo.title}'))`;

					const decoratedLink = document.createDocumentFragment();
					const imgIcon = link.a.querySelector('img.icon') as HTMLImageElement | null;
					if (imgIcon) {
						const src = imgIcon.getAttribute('src') || '';
						if (src && !/^https?:\/\//i.test(src)) {
							const decodedSrc = stripParentDirectories(decodeURI(src));
							const attachment = findAttachment(info, decodedSrc) || findAttachmentByFilename(info, decodedSrc);
							if (attachment) {
								const iconImage = createEl('img') as HTMLImageElement;
								iconImage.setAttribute('src', attachment.pathInSiYuanMd);
								iconImage.setAttribute('alt', 'notion-inline-page-icon');
								decoratedLink.appendChild(iconImage);
								decoratedLink.appendChild(document.createTextNode(' '));
							}
						}
					}

					const iconText = link.a.querySelector('span.icon')?.textContent?.trim() || '';
					if (iconText) {
						decoratedLink.appendChild(document.createTextNode(`${iconText} `));
					}
					decoratedLink.appendChild(siyuanLink);
					link.a.replaceWith(decoratedLink);
					continue;
				}

				addImportWarning('missing relation data for id: ' + link.id);
				const { basename } = parseFilePath(
					decodeURI(link.a.getAttribute('href') ?? '')
				);
				siyuanLink.textContent = `[[${stripNotionId(basename)}]]`;
				break;
			}
			case 'attachment': {
				const attachmentInfo = info.pathsToAttachmentInfo[link.path];
				if (!attachmentInfo) {
					addImportWarning('missing attachment data for: ' + link.path);
					continue;
				}
				siyuanLink.textContent = `[${attachmentInfo.nameWithExtension}](${attachmentInfo.pathInSiYuanMd})`;
				break;
			}
			case 'image': {
				siyuanLink = createEl('img');
				const imageInfo = info.pathsToAttachmentInfo[link.path];
				if (!imageInfo) {
					addImportWarning('missing image file for: ' + link.path);
					continue;
				}
				siyuanLink.setAttribute('src', imageInfo.pathInSiYuanMd);
				siyuanLink.setAttribute('alt', imageInfo.nameWithExtension);
				const sourceImage = link.a.querySelector('img') as HTMLImageElement | null;
				if (sourceImage) {
					applyImageDisplay(siyuanLink as HTMLImageElement, extractNotionImageDisplay(sourceImage));
				}
				break;
			}
		}

		link.a.replaceWith(siyuanLink);
	}
}

function splitNotionDateRange(value: string) {
	return value
		.replace('@', '')
		.split(/→|â†’/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function normalizeDatabaseCellValue(value: DatabaseCellValue) {
	if (Array.isArray(value)) {
		return value.map((part) => normalizeDatabaseCellValue(part)).filter(Boolean).join('||');
	}
	if (typeof value === 'boolean') {
		return value ? 'true' : 'false';
	}
	return String(value ?? '')
		.normalize('NFC')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

function databaseCellValueToText(value: DatabaseCellValue) {
	if (Array.isArray(value)) {
		return value.join(', ');
	}
	if (typeof value === 'boolean') {
		return value ? 'True' : 'False';
	}
	return value || '';
}

function detectNumberFormatFromText(value: string) {
	const trimmed = value.trim();
	if (!trimmed) return '';
	if (trimmed.includes('%')) return 'percent';
	if (/[€]|\bEUR\b/i.test(trimmed)) return 'EUR';
	if (/[£]|\bGBP\b/i.test(trimmed)) return 'GBP';
	if (/[$]|\bUSD\b/i.test(trimmed)) return 'USD';
	if (/[₽]|\bRUB\b/i.test(trimmed)) return 'RUB';
	if (/[₩]|\bKRW\b/i.test(trimmed)) return 'KRW';
	if (/[₹]|\bINR\b/i.test(trimmed)) return 'INR';
	if (/[₺]|\bTRY\b/i.test(trimmed)) return 'TRY';
	if (/[¥]|￥|\bJPY\b/i.test(trimmed)) return 'JPY';
	if (/\bCNY\b/i.test(trimmed)) return 'CNY';
	if (/\bCAD\b/i.test(trimmed)) return 'CAD';
	if (/\bCHF\b/i.test(trimmed)) return 'CHF';
	if (/\bTHB\b/i.test(trimmed)) return 'THB';
	if (/\bAUD\b/i.test(trimmed)) return 'AUD';
	if (/\bHKD\b/i.test(trimmed)) return 'HKD';
	if (/\bTWD\b/i.test(trimmed)) return 'TWD';
	if (/\bMOP\b/i.test(trimmed)) return 'MOP';
	if (/\bSGD\b/i.test(trimmed)) return 'SGD';
	if (/\bNZD\b/i.test(trimmed)) return 'NZD';
	if (/\bILS\b/i.test(trimmed)) return 'ILS';
	if (/[\d\u00A0\u202F\s][,.][\d]{3}\b/.test(trimmed) || /\b\d{1,3}(?:[ .,\u00A0\u202F]\d{3})+\b/.test(trimmed)) {
		return 'commas';
	}
	return '';
}

function formatRoundedNumberValue(value: number, spec: NotionNumberDisplaySpec, fallbackFormatted = '') {
	if (!Number.isFinite(value)) return fallbackFormatted;

	if (spec.numberFormat === 'percent') {
		return `${Math.ceil(value * 100)}%`;
	}

	const roundedValue = Math.ceil(value);
	const formattedInteger = new Intl.NumberFormat('fr-FR', {
		maximumFractionDigits: 0,
		minimumFractionDigits: 0,
	}).format(roundedValue);

	switch (spec.numberFormat) {
		case 'EUR':
			return `${formattedInteger}€`;
		case 'USD':
			return `$${formattedInteger}`;
		case 'GBP':
			return `£${formattedInteger}`;
		case 'JPY':
		case 'CNY':
			return `¥${formattedInteger}`;
		case 'RUB':
			return `${formattedInteger}₽`;
		case 'KRW':
			return `${formattedInteger}₩`;
		case 'INR':
			return `₹${formattedInteger}`;
		case 'TRY':
			return `${formattedInteger}₺`;
		case 'CAD':
		case 'CHF':
		case 'THB':
		case 'AUD':
		case 'HKD':
		case 'TWD':
		case 'MOP':
		case 'SGD':
		case 'NZD':
		case 'ILS':
		case 'commas':
			return formattedInteger;
		default:
			return formattedInteger || fallbackFormatted;
	}
}

function inferNumberDisplaySpecs(cols: DatabaseColumn[], rows: ParsedDatabaseRow[]) {
	const specs: Record<string, NotionNumberDisplaySpec> = {};

	cols.forEach((column, columnIndex) => {
		if (mapNotionColumnTypeToSiYuan(column.type) !== 'number') return;

		let numberFormat = '';
		let sampleDisplay = '';
		let roundedEvidence = 0;
		let contradictoryEvidence = 0;

		for (const row of rows) {
			const rawText = databaseCellValueToText(row.values[columnIndex] ?? '');
			const displayText = (row.displayValues[columnIndex] || '').trim();

			if (!numberFormat) {
				numberFormat = detectNumberFormatFromText(displayText) || detectNumberFormatFromText(rawText);
			}
			if (!sampleDisplay && displayText) {
				sampleDisplay = displayText;
			}

			const rawNumber = parseEuropeanNumber(rawText);
			const visibleNumber = displayText ? parseEuropeanNumber(displayText) : null;
			if (!rawNumber || !visibleNumber) continue;

			if (!Number.isInteger(rawNumber.value) && Number.isInteger(visibleNumber.value)) {
				if (visibleNumber.value === Math.ceil(rawNumber.value)) {
					roundedEvidence += 1;
				} else {
					contradictoryEvidence += 1;
				}
			}
		}

		if (!numberFormat && !sampleDisplay && roundedEvidence === 0) return;

		specs[normalizeNotionLookup(column.name)] = {
			roundedUpToUnit: roundedEvidence > 0 && contradictoryEvidence === 0,
			numberFormat,
			sampleDisplay,
		};
	});

	return specs;
}

function finalizeParsedDatabaseRow(row: ParsedDatabaseRow, priKeyIndex: number, signatureColIndices: number[]) {
	row.titleKey = normalizeDatabaseCellValue(row.values[priKeyIndex] ?? '');
	row.signature = signatureColIndices
		.map((index) => `${index}:${normalizeDatabaseCellValue(row.values[index] ?? '')}`)
		.join('|');
	return row;
}

function shiftQueuedRow(queueMap: Map<string, ParsedDatabaseRow[]>, key: string) {
	const queue = queueMap.get(key);
	if (!queue?.length) return undefined;
	const row = queue.shift();
	if (!queue.length) {
		queueMap.delete(key);
	}
	return row;
}

function makeRowQueueMap(rows: ParsedDatabaseRow[], key: keyof Pick<ParsedDatabaseRow, 'signature' | 'titleKey'>) {
	const queueMap = new Map<string, ParsedDatabaseRow[]>();
	for (const row of rows) {
		const value = row[key];
		if (!value) continue;
		const queue = queueMap.get(value) ?? [];
		queue.push(row);
		queueMap.set(value, queue);
	}
	return queueMap;
}

function extractRowNotionIDFromCSVTitle(value: string) {
	const notionURLMatch = value.match(/\(https?:\/\/(?:www\.)?notion\.so\/[^)]*?([a-f0-9]{32})[^)]*\)/i);
	if (notionURLMatch) return notionURLMatch[1];
	const localPathMatch = value.match(/\(([^)]*?([a-f0-9]{32})[^)]*\.html)\)$/i);
	return localPathMatch?.[2];
}

function stripNotionCSVLinkSuffix(value: string) {
	const trimmed = value.trim();
	const match = trimmed.match(/^(.+?)\s*\((?:https?:\/\/|[^)]*\.html).*?\)$/i);
	return match ? match[1].trim() : trimmed;
}

function isLikelyCheckboxValue(value: string) {
	return /^(yes|no|true|false|0|1)$/i.test(value.trim());
}

function isLikelyEmailValue(value: string) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isLikelyURLValue(value: string) {
	return /^https?:\/\//i.test(value.trim());
}

function isLikelyPhoneValue(value: string) {
	const trimmed = value.trim();
	return /^[+()0-9.\-\s/]+$/.test(trimmed) && /\d/.test(trimmed);
}

function isLikelyDateValue(value: string) {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (!/[a-z]/i.test(trimmed) && !/[/-]/.test(trimmed) && !/\b\d{4}\b/.test(trimmed)) {
		return false;
	}
	return splitNotionDateRange(value).every((part) => part && toTimestamp(part) !== 0);
}

function normalizeColumnNameForInference(name: string) {
	return normalizeNotionLookup(name)
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '');
}

function isLikelySelectColumnName(normalizedName: string) {
	return ['status', 'tag', 'tags', 'topic', 'type', 'category', 'etat', 'state'].some((token) =>
		normalizedName.includes(token)
	);
}

function isLikelyDateColumnName(normalizedName: string) {
	return [
		'date',
		'month',
		'monthyear',
		'mois',
		'moisannee',
		'annee',
		'year',
		'deadline',
		'due',
		'payment',
		'paiement',
		'purchase',
		'achat',
	].some((token) => normalizedName.includes(token));
}

function inferCSVColumnType(name: string, values: string[]) {
	const samples = values.map((value) => value.trim()).filter(Boolean).slice(0, 100);
	if (!samples.length) return 'typesText';

	const normalizedName = normalizeColumnNameForInference(name);
	if (
		['created', 'createdtime', 'creationtime', 'datecreated'].some(
			(token) => normalizedName === token || normalizedName.includes(token)
		)
	) {
		return 'typesCreatedTime';
	}
	if (
		['lastedited', 'lasteditedtime', 'edited', 'editedtime', 'lastmodified', 'modified'].some(
			(token) => normalizedName === token || normalizedName.includes(token)
		)
	) {
		return 'typesLastEditedTime';
	}
	if (samples.every(isLikelyCheckboxValue)) return 'typesCheckbox';
	if (isLikelyDateColumnName(normalizedName) && samples.every(isLikelyDateValue)) return 'typesDate';
	if (samples.every(isLikelyDateValue)) return 'typesDate';
	if (samples.every((value) => parseEuropeanNumber(value) !== null)) return 'typesNumber';
	if (samples.every(isLikelyEmailValue)) return 'typesEmail';
	if (samples.every(isLikelyURLValue)) return 'typesUrl';
	if (samples.every(isLikelyPhoneValue)) return 'typesPhone';
	if (
		samples.some((value) => value.includes(',')) &&
		samples.every((value) =>
			value
				.split(',')
				.map((part) => part.trim())
				.filter(Boolean)
				.every((part) => parseEuropeanNumber(part) === null)
		)
	) {
		return 'typesMultipleSelect';
	}

	const uniqueValues = new Set(samples);
	if (uniqueValues.size <= 20 && (samples.length > uniqueValues.size || isLikelySelectColumnName(normalizedName))) {
		return 'typesSelect';
	}

	return 'typesText';
}

function shouldUpgradeColumnTypeFromCSV(currentType: string, inferredType: string) {
	if (!inferredType || inferredType === 'typesText' || currentType === inferredType) {
		return false;
	}
	if (currentType === 'typesText') {
		return true;
	}
	if (
		['typesDate', 'typesCreatedTime', 'typesLastEditedTime'].includes(currentType) &&
		inferredType === 'typesNumber'
	) {
		return true;
	}
	if (currentType === 'typesSelect' && inferredType === 'typesMultipleSelect') {
		return true;
	}
	if (
		['typesDate', 'typesCreatedTime', 'typesLastEditedTime'].includes(currentType) &&
		['typesCreatedTime', 'typesLastEditedTime'].includes(inferredType)
	) {
		return true;
	}
	return false;
}

function resolveNormalizedDatabaseHref(
	info: NotionResolverInfo,
	tableInfo: DatabaseTableInfo,
	href: string,
) {
	const rawHref = href.split('#')[0].split('?')[0].trim();
	if (!rawHref) return '';

	const decodedHref = decodeNotionValue(rawHref).replace(/\\/g, '/');
	const rowNotionID = getNotionId(decodedHref);
	const rowFilePath = rowNotionID
		? normalizeNotionLookup(info.idsToFileInfo[rowNotionID]?.path ?? '')
		: '';
	const pageDir = tableInfo.pagePath
		? normalizeNotionLookup(parseFilePath(tableInfo.pagePath).parent)
		: '';

	const resolvedFromPage = (() => {
		if (!pageDir) return '';
		const segments = pageDir.split('/').filter(Boolean);
		for (const segment of decodedHref.split('/')) {
			if (!segment || segment === '.') continue;
			if (segment === '..') {
				if (segments.length) segments.pop();
				continue;
			}
			segments.push(segment);
		}
		return normalizeNotionLookup(segments.join('/'));
	})();

	const candidates = [
		normalizeNotionLookup(stripParentDirectories(decodedHref)),
		resolvedFromPage,
	].filter(Boolean);
	let bestCandidate = candidates[0] ?? '';
	let bestScore = -1;
	for (const candidate of candidates) {
		const parent = normalizeNotionLookup(parseFilePath(candidate).parent);
		let score = 0;
		if (parent && info.csvFilesByCollectionPath[parent]?.length) {
			score += 10;
		}
		if (rowFilePath) {
			if (rowFilePath === candidate) {
				score += 20;
			} else if (rowFilePath.endsWith(candidate)) {
				score += 10;
			} else if (parent && rowFilePath.startsWith(`${parent}/`)) {
				score += 8;
			}
		}
		if (score > bestScore) {
			bestScore = score;
			bestCandidate = candidate;
		}
	}
	return bestCandidate;
}

function collectNormalizedRowCollectionPaths(info: NotionResolverInfo, tableInfo: DatabaseTableInfo) {
	const collectionPathCounts = new Map<string, number>();
	const rowNodes = Array.from(tableInfo.tableNode.querySelectorAll('tbody > tr')) as HTMLElement[];
	for (const rowNode of rowNodes) {
		const anchor =
			(rowNode.querySelector('td.cell-title a[href]') as HTMLAnchorElement | null) ||
			(rowNode.querySelector('td:first-child a[href]') as HTMLAnchorElement | null);
		if (!anchor) continue;
		const normalizedHref = resolveNormalizedDatabaseHref(info, tableInfo, anchor.getAttribute('href') ?? '');
		if (!normalizedHref) continue;
		const rowParent = parseFilePath(normalizedHref).parent;
		if (!rowParent) continue;
		const normalizedPath = normalizeNotionLookup(rowParent);
		collectionPathCounts.set(normalizedPath, (collectionPathCounts.get(normalizedPath) ?? 0) + 1);
	}
	return collectionPathCounts;
}

function resolveCSVInfoForTable(info: NotionResolverInfo, tableInfo: DatabaseTableInfo, pageNotionId?: string) {
	const candidates: NotionCSVFileInfo[] = [];
	const seen = new Set<string>();
	const addCandidate = (candidate?: NotionCSVFileInfo | null) => {
		if (!candidate || seen.has(candidate.id)) return;
		seen.add(candidate.id);
		candidates.push(candidate);
	};
	const addUniqueCollectionMatch = (collectionPath?: string) => {
		if (!collectionPath) return;
		const matches = info.csvFilesByCollectionPath[normalizeNotionLookup(collectionPath)];
		if (matches?.length === 1) {
			addCandidate(matches[0]);
		}
	};
	const addUniqueTitleMatch = (title?: string) => {
		if (!title) return;
		const matches = info.csvFilesByTitle[normalizeNotionLookup(title)];
		if (matches?.length === 1) {
			addCandidate(matches[0]);
		}
	};

	if (pageNotionId) {
		addCandidate(info.csvFileInfos[pageNotionId]);
		const pageInfo = info.idsToFileInfo[pageNotionId];
		if (pageInfo?.path && tableInfo.title) {
			const pageParent = parseFilePath(pageInfo.path).parent;
			addUniqueCollectionMatch(pageParent ? `${pageParent}/${tableInfo.title}` : tableInfo.title);
		}
	}

	if (tableInfo.collectionId) {
		addCandidate(info.csvFileInfos[tableInfo.collectionId]);
	}

	const collectionPathCounts = collectNormalizedRowCollectionPaths(info, tableInfo);
	const dominantPath = Array.from(collectionPathCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
	if (dominantPath) {
		const matches = info.csvFilesByCollectionPath[dominantPath];
		if (matches?.length === 1) {
			addCandidate(matches[0]);
		}
	}

	addUniqueTitleMatch(tableInfo.title);

	return candidates[0] ?? null;
}

function resolveDatabaseIdentity(
	info: NotionResolverInfo,
	tableInfo: DatabaseTableInfo,
	csvInfo?: NotionCSVFileInfo | null,
) {
	const dominantPath = Array.from(collectNormalizedRowCollectionPaths(info, tableInfo).entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
	if (dominantPath) {
		return `path:${dominantPath}`;
	}
	if (csvInfo?.normalizedCollectionPath) {
		return `path:${csvInfo.normalizedCollectionPath}`;
	}
	if (csvInfo?.id) {
		return `csv:${csvInfo.id}`;
	}
	if (tableInfo.collectionId) {
		return `collection:${tableInfo.collectionId}`;
	}
	const normalizedTitle = normalizeNotionLookup(tableInfo.title);
	if (normalizedTitle && info.csvFilesByTitle[normalizedTitle]?.length === 1) {
		return `title:${normalizedTitle}`;
	}
	return null;
}

function getRowCollectionPathsForRows(info: NotionResolverInfo, rows: ParsedDatabaseRow[]) {
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (!row.notionRowID) continue;
		const rowPath = info.idsToFileInfo[row.notionRowID]?.path;
		if (!rowPath) continue;
		const rowParent = normalizeNotionLookup(parseFilePath(rowPath).parent);
		if (!rowParent) continue;
		counts.set(rowParent, (counts.get(rowParent) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([path]) => path);
}

function chooseCanonicalDatabaseIdentity(tables: BuiltDatabaseTable[]) {
	const rankedPaths = new Map<string, number>();
	for (const table of tables) {
		for (const [index, path] of table.rowCollectionPaths.entries()) {
			rankedPaths.set(path, (rankedPaths.get(path) ?? 0) + (100 - index));
		}
		if (table.pageCollectionPath) {
			rankedPaths.set(table.pageCollectionPath, (rankedPaths.get(table.pageCollectionPath) ?? 0) + 60);
		}
		if (table.csvCollectionPath) {
			rankedPaths.set(table.csvCollectionPath, (rankedPaths.get(table.csvCollectionPath) ?? 0) + 25);
		}
	}
	const dominantPath = Array.from(rankedPaths.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
	if (dominantPath) {
		return `path:${dominantPath}`;
	}

	const explicitIdentity = tables.map((table) => table.databaseIdentity).find(Boolean);
	return explicitIdentity ?? null;
}

function shouldMergeBuiltTables(a: BuiltDatabaseTable, b: BuiltDatabaseTable) {
	if (normalizeNotionLookup(a.title) !== normalizeNotionLookup(b.title)) {
		return false;
	}

	if (a.csvCollectionPath && b.csvCollectionPath && a.csvCollectionPath === b.csvCollectionPath) {
		return true;
	}
	if (a.pageCollectionPath && b.pageCollectionPath && a.pageCollectionPath === b.pageCollectionPath) {
		return true;
	}

	const sharedRowPath = a.rowCollectionPaths.some((path) => b.rowCollectionPaths.includes(path));
	if (sharedRowPath) {
		return true;
	}

	if (a.pageCollectionPath && b.rowCollectionPaths.includes(a.pageCollectionPath)) {
		return true;
	}
	if (b.pageCollectionPath && a.rowCollectionPaths.includes(b.pageCollectionPath)) {
		return true;
	}
	if (a.pageCollectionPath && b.csvCollectionPath && a.pageCollectionPath === b.csvCollectionPath) {
		return true;
	}
	if (b.pageCollectionPath && a.csvCollectionPath && b.pageCollectionPath === a.csvCollectionPath) {
		return true;
	}

	if (a.csvCollectionPath && b.rowCollectionPaths.includes(a.csvCollectionPath)) {
		return true;
	}
	if (b.csvCollectionPath && a.rowCollectionPaths.includes(b.csvCollectionPath)) {
		return true;
	}

	if (a.notionRowIDs.length > 0 && b.notionRowIDs.length > 0) {
		const bRowIDs = new Set(b.notionRowIDs);
		for (const notionRowID of a.notionRowIDs) {
			if (bRowIDs.has(notionRowID)) {
				return true;
			}
		}
	}

	const aTitleKeys = Array.from(new Set(a.rows.map((row) => row.titleKey).filter(Boolean)));
	const bTitleKeys = new Set(b.rows.map((row) => row.titleKey).filter(Boolean));
	if (aTitleKeys.length > 0 && bTitleKeys.size > 0) {
		let sharedTitleKeys = 0;
		for (const titleKey of aTitleKeys) {
			if (bTitleKeys.has(titleKey)) {
				sharedTitleKeys += 1;
			}
		}
		const smallestSetSize = Math.min(aTitleKeys.length, bTitleKeys.size);
		if (
			sharedTitleKeys >= Math.min(3, smallestSetSize) &&
			sharedTitleKeys / Math.max(1, smallestSetSize) >= 0.4
		) {
			return true;
		}
	}

	return false;
}

function hasStrongColumnOverlap(a: BuiltDatabaseTable, b: BuiltDatabaseTable) {
	const aColumns = Array.from(new Set(a.cols.map((col) => normalizeNotionLookup(col.name)).filter(Boolean)));
	const bColumns = new Set(b.cols.map((col) => normalizeNotionLookup(col.name)).filter(Boolean));
	if (aColumns.length === 0 || bColumns.size === 0) {
		return false;
	}

	let sharedColumns = 0;
	for (const column of aColumns) {
		if (bColumns.has(column)) {
			sharedColumns += 1;
		}
	}

	const smallestSetSize = Math.min(aColumns.length, bColumns.size);
	return (
		sharedColumns >= Math.min(2, smallestSetSize) &&
		sharedColumns / Math.max(1, smallestSetSize) >= 0.6
	);
}

function hasStrongSharedStateColumnOverlap(sharedState: SharedDatabaseState, table: BuiltDatabaseTable) {
	const sharedColumns = new Set(sharedState.columns.map((column) => column.normalizedName).filter(Boolean));
	const tableColumns = Array.from(new Set(table.cols.map((col) => normalizeNotionLookup(col.name)).filter(Boolean)));
	if (sharedColumns.size === 0 || tableColumns.length === 0) {
		return false;
	}

	let overlap = 0;
	for (const column of tableColumns) {
		if (sharedColumns.has(column)) {
			overlap += 1;
		}
	}

	const smallestSetSize = Math.min(sharedColumns.size, tableColumns.length);
	return (
		overlap >= Math.min(2, smallestSetSize) &&
		overlap / Math.max(1, smallestSetSize) >= 0.6
	);
}

function normalizeBuiltDatabaseIdentities(tables: BuiltDatabaseTable[]) {
	const titleGroups = new Map<string, BuiltDatabaseTable[]>();
	for (const table of tables) {
		const titleKey = normalizeNotionLookup(table.title);
		const group = titleGroups.get(titleKey) ?? [];
		group.push(table);
		titleGroups.set(titleKey, group);
	}

	for (const group of titleGroups.values()) {
		if (group.length < 2) continue;
		const visited = new Set<BuiltDatabaseTable>();
		for (const table of group) {
			if (visited.has(table)) continue;
			const component: BuiltDatabaseTable[] = [];
			const queue = [table];
			visited.add(table);

			while (queue.length > 0) {
				const current = queue.shift()!;
				component.push(current);
				for (const candidate of group) {
					if (visited.has(candidate)) continue;
					if (!shouldMergeBuiltTables(current, candidate)) continue;
					visited.add(candidate);
					queue.push(candidate);
				}
			}

			if (component.length < 2) continue;
			const canonicalIdentity = chooseCanonicalDatabaseIdentity(component);
			if (!canonicalIdentity) continue;
			component.forEach((entry) => {
				entry.databaseIdentity = canonicalIdentity;
			});
		}
	}
}

function resolveDatabaseIdentityAlias(info: NotionResolverInfo, identity: string | null) {
	if (!identity) return identity;
	let resolved = identity;
	const seen = new Set<string>();
	while (info.databaseIdentityAliases[resolved] && !seen.has(resolved)) {
		seen.add(resolved);
		resolved = info.databaseIdentityAliases[resolved];
	}
	return resolved;
}

function getDatabaseCorrelationKeys(table: BuiltDatabaseTable) {
	const keys = new Set<string>();
	for (const rowPath of table.rowCollectionPaths) {
		if (rowPath) {
			keys.add(`row:${rowPath}`);
		}
	}
	if (table.csvCollectionPath) {
		keys.add(`csv:${table.csvCollectionPath}`);
	}
	if (table.pageCollectionPath) {
		keys.add(`page:${table.pageCollectionPath}`);
	}
	return Array.from(keys);
}

function registerSharedDatabaseCorrelationKeys(
	info: NotionResolverInfo,
	sharedState: SharedDatabaseState,
	table: BuiltDatabaseTable,
) {
	for (const key of getDatabaseCorrelationKeys(table)) {
		info.attributeViewsByCorrelationKey[key] = sharedState;
	}
}

function harmonizeBuiltDatabaseIdentity(info: NotionResolverInfo, table: BuiltDatabaseTable) {
	const titleKey = normalizeNotionLookup(table.title);
	if (!titleKey) {
		table.databaseIdentity = resolveDatabaseIdentityAlias(info, table.databaseIdentity);
		return;
	}

	const groups = info.databaseCorrelationGroupsByTitle[titleKey] ?? [];
	let matchedGroups = groups.filter((group) =>
		(group.tables as BuiltDatabaseTable[]).some((existingTable) => shouldMergeBuiltTables(existingTable, table)),
	);
	if (matchedGroups.length === 0 && groups.length === 1) {
		matchedGroups = [groups[0]];
	}

	if (matchedGroups.length === 0) {
		const canonicalIdentity =
			resolveDatabaseIdentityAlias(info, table.databaseIdentity) || chooseCanonicalDatabaseIdentity([table]);
		if (table.databaseIdentity && canonicalIdentity && table.databaseIdentity !== canonicalIdentity) {
			info.databaseIdentityAliases[table.databaseIdentity] = canonicalIdentity;
		}
		table.databaseIdentity = canonicalIdentity;
		groups.push({
			canonicalIdentity,
			tables: [table],
		});
		info.databaseCorrelationGroupsByTitle[titleKey] = groups;
		return;
	}

	const mergedTables = new Set<BuiltDatabaseTable>([table]);
	for (const group of matchedGroups) {
		for (const existingTable of group.tables as BuiltDatabaseTable[]) {
			mergedTables.add(existingTable);
		}
	}
	const mergedTableList = Array.from(mergedTables);
	const canonicalIdentity =
		resolveDatabaseIdentityAlias(
			info,
			chooseCanonicalDatabaseIdentity(mergedTableList) || matchedGroups[0].canonicalIdentity || table.databaseIdentity,
		) || null;

	for (const mergedTable of mergedTableList) {
		if (mergedTable.databaseIdentity && canonicalIdentity && mergedTable.databaseIdentity !== canonicalIdentity) {
			info.databaseIdentityAliases[mergedTable.databaseIdentity] = canonicalIdentity;
		}
		mergedTable.databaseIdentity = canonicalIdentity;
	}

	const unmatchedGroups = groups.filter((group) => !matchedGroups.includes(group));
	unmatchedGroups.push({
		canonicalIdentity,
		tables: mergedTableList,
	});
	info.databaseCorrelationGroupsByTitle[titleKey] = unmatchedGroups;
}

function getDatabaseRowKey(row: ParsedDatabaseRow) {
	if (row.notionRowID) {
		return `notion:${row.notionRowID}`;
	}
	return `signature:${row.signature}`;
}

export function extractDatabaseViewSpec(
	containerNode: HTMLElement,
	tableNode: HTMLElement,
	fallbackTitle: string,
	rows: ParsedDatabaseRow[] = [],
): NotionDatabaseViewSpec {
	const liveViewNameButton =
		containerNode.querySelector('[role="tablist"] [role="button"] span') ||
		containerNode.querySelector('.notion-collection_view-block [role="tablist"] [role="button"] span') ||
		containerNode.querySelector('[role="tablist"] [role="button"]');
	const viewName =
		containerNode.getAttribute('data-notion-view-name') ||
		getMeaningfulButtonText(liveViewNameButton) ||
		(containerNode.querySelector('.collection-title') as HTMLElement | null)?.innerText?.trim() ||
		fallbackTitle ||
		'Table';

	const visibleColumnNames = parseCSVAttribute(containerNode, [
		'data-notion-visible-columns',
		'data-notion-view-columns',
	]).map((name) => normalizeNotionLookup(name));
	if (visibleColumnNames.length === 0) {
		Array.from(tableNode.querySelectorAll('thead > tr > th')).forEach((columnNode) => {
			const text = (columnNode.textContent || '').trim();
			if (text) {
				visibleColumnNames.push(normalizeNotionLookup(text));
			}
		});
	}

	const rowOrder = parseCSVAttribute(containerNode, ['data-notion-row-order']);
	if (rowOrder.length === 0 && rows.length > 0) {
		rows.forEach((row) => rowOrder.push(getDatabaseRowKey(row)));
	}

	return {
		name: viewName,
		filters: parseDatabaseFilters(containerNode),
		sorts: parseDatabaseSorts(containerNode),
		groupBy: parseDatabaseGroupBy(containerNode),
		visibleColumnNames,
		rowOrder,
		numericDisplayByColumn: {},
	};
}

function getOrCreateSharedDatabaseState(info: NotionResolverInfo, table: BuiltDatabaseTable) {
	const resolvedIdentity = resolveDatabaseIdentityAlias(info, table.databaseIdentity);
	if (resolvedIdentity) {
		table.databaseIdentity = resolvedIdentity;
	}
	const cacheKey = resolvedIdentity || `ephemeral:${generateSiYuanID()}`;
	let sharedState = info.attributeViewsByDatabaseIdentity[cacheKey] as SharedDatabaseState | undefined;
	if (sharedState) {
		registerSharedDatabaseCorrelationKeys(info, sharedState, table);
		if (!resolvedIdentity) {
			delete info.attributeViewsByDatabaseIdentity[cacheKey];
		}
		return sharedState;
	}

	for (const key of getDatabaseCorrelationKeys(table)) {
		sharedState = info.attributeViewsByCorrelationKey[key] as SharedDatabaseState | undefined;
		if (!sharedState) {
			continue;
		}
		if (resolvedIdentity) {
			info.attributeViewsByDatabaseIdentity[resolvedIdentity] = sharedState;
		}
		registerSharedDatabaseCorrelationKeys(info, sharedState, table);
		return sharedState;
	}

	const normalizedTitle = normalizeNotionLookup(table.title);
	if (normalizedTitle) {
		const titleCandidates = (info.attributeViewsByNormalizedTitle[normalizedTitle] ?? []) as SharedDatabaseState[];
		const matchingCandidates = titleCandidates.filter((candidate) => hasStrongSharedStateColumnOverlap(candidate, table));
		if (matchingCandidates.length === 1) {
			sharedState = matchingCandidates[0];
			if (resolvedIdentity) {
				info.attributeViewsByDatabaseIdentity[resolvedIdentity] = sharedState;
			}
			registerSharedDatabaseCorrelationKeys(info, sharedState, table);
			return sharedState;
		}
	}

	sharedState = {
		avID: generateSiYuanID(),
		name: table.title || table.viewName || 'Table',
		defaultViewID: '',
		columns: [],
		rowsByKey: new Map<string, SharedDatabaseRow>(),
		rowKeysInOrder: [],
		views: [],
		avData: {},
	};

	if (resolvedIdentity) {
		info.attributeViewsByDatabaseIdentity[cacheKey] = sharedState;
	}
	if (normalizedTitle) {
		const titleStates = (info.attributeViewsByNormalizedTitle[normalizedTitle] ?? []) as SharedDatabaseState[];
		if (!titleStates.includes(sharedState)) {
			titleStates.push(sharedState);
			info.attributeViewsByNormalizedTitle[normalizedTitle] = titleStates;
		}
	}
	registerSharedDatabaseCorrelationKeys(info, sharedState, table);
	return sharedState;
}

function mergeBuiltTableIntoSharedState(info: NotionResolverInfo, sharedState: SharedDatabaseState, table: BuiltDatabaseTable) {
	const existingColumns = new Map(sharedState.columns.map((column) => [column.normalizedName, column]));
	const visibleColumnNames: string[] = [];

	table.cols.forEach((column, columnIndex) => {
		const normalizedName = normalizeNotionLookup(column.name);
		if (!visibleColumnNames.includes(normalizedName)) {
			visibleColumnNames.push(normalizedName);
		}
		let sharedColumn = existingColumns.get(normalizedName);
		if (!sharedColumn) {
			sharedColumn = {
				normalizedName,
				name: column.name,
				type: column.type,
				keyID: generateSiYuanID(),
				selectValues: new Set<string>(),
				selectColors: {},
				numberDisplay: {
					roundedUpToUnit: false,
					numberFormat: '',
				},
			};
			sharedState.columns.push(sharedColumn);
			existingColumns.set(normalizedName, sharedColumn);
		} else if (shouldUpgradeColumnTypeFromCSV(sharedColumn.type, column.type)) {
			sharedColumn.type = column.type;
		}

		Array.from(column.selectValues).forEach((value) => sharedColumn!.selectValues.add(value));
		Object.assign(sharedColumn.selectColors, column.selectColors);
		const numberDisplaySpec = table.viewSpec.numericDisplayByColumn[normalizedName];
		if (numberDisplaySpec) {
			if (numberDisplaySpec.roundedUpToUnit) {
				sharedColumn.numberDisplay.roundedUpToUnit = true;
			}
			if (!sharedColumn.numberDisplay.numberFormat && numberDisplaySpec.numberFormat) {
				sharedColumn.numberDisplay.numberFormat = numberDisplaySpec.numberFormat;
			}
			if (!sharedColumn.numberDisplay.sampleDisplay && numberDisplaySpec.sampleDisplay) {
				sharedColumn.numberDisplay.sampleDisplay = numberDisplaySpec.sampleDisplay;
			}
		}

		table.rows.forEach((row) => {
			const rowKey = getDatabaseRowKey(row);
			let sharedRow = sharedState.rowsByKey.get(rowKey);
			if (!sharedRow) {
				const linkedBlockID = row.notionRowID ? info.idsToFileInfo[row.notionRowID]?.blockID : '';
				sharedRow = {
					key: rowKey,
					notionRowID: row.notionRowID,
					rowid: linkedBlockID || row.rowid || generateSiYuanID(),
					hasRelBlock: row.hasRelBlock || Boolean(linkedBlockID),
					valuesByColumn: {},
					displayValuesByColumn: {},
				};
				sharedState.rowsByKey.set(rowKey, sharedRow);
				sharedState.rowKeysInOrder.push(rowKey);
			} else if (!sharedRow.hasRelBlock && row.hasRelBlock) {
				const linkedBlockID = row.notionRowID ? info.idsToFileInfo[row.notionRowID]?.blockID : '';
				sharedRow.hasRelBlock = true;
				if (linkedBlockID) {
					sharedRow.rowid = linkedBlockID;
				}
			}

			sharedRow.valuesByColumn[normalizedName] = row.values[columnIndex] ?? '';
			const displayValue = row.displayValues[columnIndex]?.trim();
			if (displayValue) {
				sharedRow.displayValuesByColumn[normalizedName] = displayValue;
			}
		});
	});

	const rowKeys = table.viewSpec.rowOrder.length > 0
		? table.viewSpec.rowOrder.filter((rowKey) => sharedState.rowsByKey.has(rowKey))
		: table.rows.map((row) => getDatabaseRowKey(row));
	const preferredVisibleColumns = table.viewSpec.visibleColumnNames.length > 0
		? table.viewSpec.visibleColumnNames.filter((name) => existingColumns.has(name))
		: visibleColumnNames;
	const view: SharedDatabaseView = {
		id: generateSiYuanID(),
		name: table.viewSpec.name || table.viewName || table.title || 'Table',
		rowKeys,
		visibleColumnNames: preferredVisibleColumns.length > 0 ? preferredVisibleColumns : visibleColumnNames,
		filters: table.viewSpec.filters,
		sorts: table.viewSpec.sorts,
		groupBy: table.viewSpec.groupBy,
	};
	sharedState.views.push(view);
	if (!sharedState.defaultViewID) {
		sharedState.defaultViewID = view.id;
	}

	return view;
}

function syncAttributeViewData(target: any, next: any) {
	Object.keys(target).forEach((key) => delete target[key]);
	Object.assign(target, next);
	return target;
}

function materializeSharedDatabaseState(info: NotionResolverInfo, sharedState: SharedDatabaseState) {
	const rowOrder = sharedState.rowKeysInOrder
		.map((rowKey) => sharedState.rowsByKey.get(rowKey))
		.filter((row): row is SharedDatabaseRow => Boolean(row));
	const rowOrderByKey = new Map(rowOrder.map((row) => [row.key, row]));

	const keyValues = sharedState.columns.map((column) => {
		const colType = mapNotionColumnTypeToSiYuan(column.type);
		let keyValue: any = {
			key: {},
			values: [],
		};

		if (colType === 'date') {
			const dateSamples = rowOrder.flatMap((row) => {
				const rawValue = row.valuesByColumn[column.normalizedName];
				return Array.isArray(rawValue)
					? rawValue.filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
					: [];
			});
			const dateOrder = detectDateOrderPreference(dateSamples);
			keyValue.key = generateColumnKey(column.name, colType, []);
			keyValue.key.id = column.keyID;
			keyValue.values = rowOrder.map((row) => {
				const rawValue = row.valuesByColumn[column.normalizedName];
				const times = Array.isArray(rawValue)
					? rawValue.map((part) => toTimestamp(part, dateOrder)).filter(Boolean)
					: [];
				if (!times.length) {
					return {
						id: generateSiYuanID(),
						keyID: keyValue.key.id,
						blockID: row.rowid,
						type: colType,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						date: { content: 0, isNotEmpty: false, hasEndDate: false, isNotTime: true, content2: 0, isNotEmpty2: false, formattedContent: '' },
					};
				}
				const value = {
					id: generateSiYuanID(),
					keyID: keyValue.key.id,
					blockID: row.rowid,
					type: colType,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					date: {
						content: times[0],
						isNotEmpty: true,
						hasEndDate: false,
						isNotTime: timestampIsPureDate(times[0]),
						content2: 0,
						isNotEmpty2: false,
						formattedContent: '',
					},
				};
				if (times.length === 2) {
					value.date.hasEndDate = true;
					value.date.content2 = times[1];
					value.date.isNotEmpty2 = true;
				}
				return value;
			});
		} else if (['select', 'mSelect'].includes(colType)) {
			const opts = new Map<string, string>();
			Array.from(column.selectValues).forEach((value, index) => {
				opts.set(value, column.selectColors[value] || `${(index % 10) + 1}`);
			});
			keyValue.key = generateColumnKey(column.name, colType, Array.from(opts, ([name, color]) => ({ name, color })));
			keyValue.key.id = column.keyID;
			keyValue.values = rowOrder.map((row) => {
				const selectedValues = Array.isArray(row.valuesByColumn[column.normalizedName])
					? row.valuesByColumn[column.normalizedName] as string[]
					: [];
				return {
					id: generateSiYuanID(),
					keyID: keyValue.key.id,
					blockID: row.rowid,
					type: colType,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					mSelect: selectedValues.map((value) => ({
						content: value,
						color: opts.get(value),
					})),
				};
			});
		} else if (colType === 'block') {
			keyValue.key = generateColumnKey(column.name, colType, []);
			keyValue.key.id = column.keyID;
			keyValue.values = rowOrder.map((row) => {
				const rawValue = row.valuesByColumn[column.normalizedName];
				return {
					id: generateSiYuanID(),
					keyID: keyValue.key.id,
					blockID: row.rowid,
					type: colType,
					isDetached: !row.hasRelBlock,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					block: {
						id: row.rowid,
						content: databaseCellValueToText(rawValue),
						created: Date.now(),
						updated: Date.now(),
					},
				};
			});
		} else if (colType === 'checkbox') {
			keyValue.key = generateColumnKey(column.name, colType, []);
			keyValue.key.id = column.keyID;
			keyValue.values = rowOrder.map((row) => ({
				id: generateSiYuanID(),
				keyID: keyValue.key.id,
				blockID: row.rowid,
				type: colType,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				checkbox: {
					checked: Boolean(row.valuesByColumn[column.normalizedName]),
				},
			}));
		} else if (colType === 'mAsset') {
			keyValue.key = generateColumnKey(column.name, colType, []);
			keyValue.key.id = column.keyID;
			keyValue.values = rowOrder.map((row) => {
				const assetValues = Array.isArray(row.valuesByColumn[column.normalizedName])
					? row.valuesByColumn[column.normalizedName] as string[]
					: [];
				return {
					id: generateSiYuanID(),
					keyID: keyValue.key.id,
					blockID: row.rowid,
					type: colType,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					mAsset: assetValues.map((value) => {
						let assetType = 'file';
						if (isImagePath(value)) {
							assetType = 'image';
						}
						let assetPath = value;
						const attachment = findAttachment(info, value);
						if (attachment) {
							assetPath = attachment.pathInSiYuanMd;
						}
						return {
							type: assetType,
							name: assetPath,
							content: assetPath,
						};
					}),
				};
			});
		} else if (colType === 'number') {
			keyValue.key = generateColumnKey(column.name, colType, []);
			keyValue.key.id = column.keyID;
			keyValue.key.numberFormat = column.numberDisplay.numberFormat || '';
			keyValue.values = rowOrder.map((row) => {
				const parsed = parseEuropeanNumber(databaseCellValueToText(row.valuesByColumn[column.normalizedName]));
				if (!parsed) {
					return {
						id: generateSiYuanID(),
						keyID: keyValue.key.id,
						blockID: row.rowid,
						type: colType,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						number: {
							content: 0,
							isNotEmpty: false,
							formattedContent: '',
						},
					};
				}
				return {
					id: generateSiYuanID(),
					keyID: keyValue.key.id,
					blockID: row.rowid,
					type: colType,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					number: {
						content: parsed.value,
						isNotEmpty: true,
						formattedContent:
							row.displayValuesByColumn[column.normalizedName] ||
							(column.numberDisplay.roundedUpToUnit
								? formatRoundedNumberValue(parsed.value, column.numberDisplay, parsed.formatted)
								: parsed.formatted),
					},
				};
			});
		} else if (colType === 'url' || colType === 'email' || colType === 'phone') {
			keyValue.key = generateColumnKey(column.name, colType, []);
			keyValue.key.id = column.keyID;
			keyValue.values = rowOrder.map((row) => ({
				id: generateSiYuanID(),
				keyID: keyValue.key.id,
				blockID: row.rowid,
				type: colType,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				[colType]: {
					content: databaseCellValueToText(row.valuesByColumn[column.normalizedName]),
				},
			}));
		} else {
			keyValue.key = generateColumnKey(column.name, 'text', []);
			keyValue.key.id = column.keyID;
			keyValue.values = rowOrder.map((row) => ({
				id: generateSiYuanID(),
				keyID: keyValue.key.id,
				blockID: row.rowid,
				type: 'text',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				text: {
					content: databaseCellValueToText(row.valuesByColumn[column.normalizedName]),
				},
			}));
		}

		return keyValue;
	});

	const materialized = {
		spec: 4,
		id: sharedState.avID,
		name: sharedState.name,
		keyValues,
		keyIDs: null,
		viewID: sharedState.defaultViewID || sharedState.views[0]?.id || generateSiYuanID(),
		views: sharedState.views.map((view) => {
			const visibleColumnSet = new Set(view.visibleColumnNames);
			const orderedColumns = [
				...view.visibleColumnNames
					.map((name) => sharedState.columns.find((column) => column.normalizedName === name))
					.filter((column): column is SharedDatabaseColumn => Boolean(column)),
				...sharedState.columns.filter((column) => !visibleColumnSet.has(column.normalizedName)),
			];
			return {
				id: view.id,
				icon: '',
				name: view.name,
				hideAttrViewName: false,
				desc: '',
				pageSize: 50,
				type: 'table',
				table: {
					spec: 0,
					id: generateSiYuanID(),
					showIcon: true,
					wrapField: false,
					pageSize: 50,
					columns: orderedColumns.map((column) => {
						const col: any = {
							id: column.keyID,
							wrap: false,
							hidden: !visibleColumnSet.has(column.normalizedName),
							pin: false,
							width: '',
						};
						if (mapNotionColumnTypeToSiYuan(column.type) === 'number') {
							col.calc = { operator: 'Sum' };
							if (column.numberDisplay.roundedUpToUnit) {
								const sum = view.rowKeys.reduce((total, rowKey) => {
									const row = rowOrderByKey.get(rowKey);
									if (!row) return total;
									const parsed = parseEuropeanNumber(databaseCellValueToText(row.valuesByColumn[column.normalizedName]));
									return total + (parsed?.value ?? 0);
								}, 0);
								col.calc.result = {
									number: {
										content: Math.ceil(sum),
										isNotEmpty: true,
										formattedContent: formatRoundedNumberValue(sum, column.numberDisplay),
									},
								};
							}
						}
						return col;
					}),
					rowIds: view.rowKeys
						.map((rowKey) => sharedState.rowsByKey.get(rowKey)?.rowid)
						.filter((rowid): rowid is string => Boolean(rowid)),
					filters: view.filters as any[],
					sorts: view.sorts as any[],
				},
				itemIds: view.rowKeys
					.map((rowKey) => sharedState.rowsByKey.get(rowKey)?.rowid)
					.filter((rowid): rowid is string => Boolean(rowid)),
				groupCreated: view.groupBy?.created ?? 0,
				groupItemIds: view.groupBy?.itemIDs ?? null,
				groupFolded: view.groupBy?.folded ?? false,
				groupHidden: view.groupBy?.hidden ?? 0,
				groupSort: view.groupBy?.sort ?? 0,
				rawNotionFilters: view.filters,
				rawNotionSorts: view.sorts,
				rawNotionGroupBy: view.groupBy,
			};
		}),
	};

	return syncAttributeViewData(sharedState.avData, materialized);
}

function parseHTMLDatabaseRows(
	info: NotionResolverInfo,
	tableNode: HTMLElement,
	cols: DatabaseColumn[],
	priKeyIndex: number,
) {
	const rows: ParsedDatabaseRow[] = [];
	Array.from(tableNode.querySelectorAll('tbody > tr')).forEach((trNode: HTMLElement) => {
		try {
			const tdNodes = Array.from(trNode.querySelectorAll('td'));
			while (tdNodes.length < cols.length) {
				tdNodes.push(document.createElement('td'));
			}

			const priKeyCell = tdNodes[priKeyIndex];
			const priKeyAnchor = priKeyCell?.querySelector('a');
			const rowNotionID =
				getNotionId(priKeyAnchor?.getAttribute('href') ?? '') ||
				getNotionId(trNode.getAttribute('id') ?? '');
			const linkedBlockID = rowNotionID ? info.idsToFileInfo[rowNotionID]?.blockID : '';

			const row: ParsedDatabaseRow = {
				notionRowID: rowNotionID,
				rowid: linkedBlockID || generateSiYuanID(),
				hasRelBlock: Boolean(linkedBlockID),
				values: [],
				displayValues: [],
				signature: '',
				titleKey: '',
			};

			tdNodes.forEach((tdNode: HTMLElement, colIndex: number) => {
				row.displayValues[colIndex] = tdNode.innerText.trim();
				if (cols[colIndex].type === 'typesTitle') {
					row.values[colIndex] = (tdNode.querySelector('a')?.innerText ?? tdNode.textContent ?? '').trim();
				} else if (['typesDate', 'typesCreatedTime', 'typesLastEditedTime'].includes(cols[colIndex].type)) {
					row.values[colIndex] = splitNotionDateRange(tdNode.innerText.trim());
				} else if (['typesSelect', 'typesMultipleSelect', 'typesStatus'].includes(cols[colIndex].type)) {
					const opts = Array.from(tdNode.querySelectorAll('span.selected-value')).map((selectSpan: HTMLElement) => {
						const opt = selectSpan.innerText.trim();
						const color = extractSelectColor(selectSpan);
						cols[colIndex].selectValues.add(opt);
						cols[colIndex].selectColors[opt] = color;
						return opt;
					});
					row.values[colIndex] = opts;
				} else if (cols[colIndex].type === 'typesCheckbox') {
					row.values[colIndex] = Boolean(tdNode.querySelector('div.checkbox-on'));
				} else if (cols[colIndex].type === 'typesFile') {
					row.values[colIndex] = Array.from(tdNode.querySelectorAll('a')).map((aNode) => getDecodedURI(aNode));
				} else {
					row.values[colIndex] = tdNode.innerText.trim();
				}
			});

			rows.push(row);
		} catch (e) {
			addImportWarning('Skipping malformed database row: ' + (e instanceof Error ? e.message : String(e)));
		}
	});
	return rows;
}

// Parse a CSV cell value according to the column type
function parseCSVCellValue(value: string, colType: string, selectValues: Set<string>) {
	value = value.trim();
	const normalizedValue =
		colType === 'typesUrl' || colType === 'typesFile' ? value : stripNotionCSVLinkSuffix(value);
	switch (colType) {
		case 'typesTitle': {
			return normalizedValue;
		}
		case 'typesCheckbox':
			return normalizedValue.toLowerCase() === 'yes' || normalizedValue.toLowerCase() === 'true' || normalizedValue === '1';
		case 'typesDate':
		case 'typesCreatedTime':
		case 'typesLastEditedTime': {
			if (!normalizedValue) return [];
			// Handle date ranges with arrow
			const times = splitNotionDateRange(normalizedValue);
			return times;
		}
		case 'typesSelect':
		case 'typesStatus': {
			if (!normalizedValue) return [];
			selectValues.add(normalizedValue);
			return [normalizedValue];
		}
		case 'typesMultipleSelect': {
			if (!normalizedValue) return [];
			const opts = normalizedValue.split(',').map(v => v.trim()).filter(Boolean);
			opts.forEach(o => selectValues.add(o));
			return opts;
		}
		case 'typesFile': {
			if (!value) return [];
			return value.split(',').map(v => v.trim()).filter(Boolean);
		}
		default:
			return normalizedValue;
	}
}

// Convert Notion databases to SiYuan AttributeView format
// and replace database DOM elements with [:av:ID:] placeholders for later processing
async function getDatabases(info: NotionResolverInfo, body: HTMLElement, pageNotionId?: string) {
	let tableInfos: DatabaseTableInfo[] = [];
	// Return early if no database tables
	const hasTable = Boolean(body.querySelector('table[class="collection-content"]'));
	if (!hasTable) {
		return []
	}
	// Check if this is an embedded (inline) database
	const isEmbedTable = Boolean(body.querySelector('div[class="collection-content"]'));
	if (isEmbedTable) {
		tableInfos = Array.from(body.querySelectorAll('div[class="collection-content"]'))
			.map((divNode: HTMLElement) => {
				const tableNode = divNode.querySelector('table[class="collection-content"]') as HTMLElement | null;
				if (!tableNode) return null;
				const title = (divNode.querySelector('.collection-title') as HTMLElement)?.innerText.trim() || '';
				const viewSpec = extractDatabaseViewSpec(divNode, tableNode, title);
				return {
					title,
					viewName: viewSpec.name,
					viewSpec,
					tableNode,
					containerNode: divNode,
					collectionId: getNotionId(divNode.getAttribute('id') ?? '') || getNotionId(tableNode.getAttribute('id') ?? ''),
					pagePath: pageNotionId ? info.idsToFileInfo[pageNotionId]?.path : '',
				};
			})
			.filter(Boolean) as DatabaseTableInfo[];
	} else {
		const tableNode = body.querySelector('table[class="collection-content"]') as HTMLElement | null;
		if (!tableNode) return [];
		const title = (body.querySelector('.page-title') as HTMLElement)?.innerText.trim() || '';
		const containerNode =
			(tableNode.closest('div.collection-content') as HTMLElement | null) ||
			tableNode.parentElement ||
			tableNode;
		const viewSpec = extractDatabaseViewSpec(containerNode, tableNode, title);
		tableInfos = [{
			title,
			viewName: viewSpec.name,
			viewSpec,
			tableNode,
			containerNode,
			collectionId: getNotionId(tableNode.getAttribute('id') ?? '') || pageNotionId,
			pagePath: pageNotionId ? info.idsToFileInfo[pageNotionId]?.path : '',
		}]
	}
	const csvCache = new Map<string, { headers: string[]; rows: string[][] }>();

	const parseCSVValue = (value: string, colType: string, selectValues: Set<string>): DatabaseCellValue => {
		const trimmedValue = value.trim();
		const normalizedValue =
			colType === 'typesUrl' || colType === 'typesFile'
				? trimmedValue
				: stripNotionCSVLinkSuffix(trimmedValue);
		switch (colType) {
			case 'typesTitle': {
				return normalizedValue;
			}
			case 'typesCheckbox':
				return normalizedValue.toLowerCase() === 'yes' || normalizedValue.toLowerCase() === 'true' || normalizedValue === '1';
			case 'typesDate':
			case 'typesCreatedTime':
			case 'typesLastEditedTime':
				return normalizedValue ? splitNotionDateRange(normalizedValue) : [];
			case 'typesSelect':
			case 'typesStatus':
				if (!normalizedValue) return [];
				selectValues.add(normalizedValue);
				return [normalizedValue];
			case 'typesMultipleSelect': {
				if (!normalizedValue) return [];
				const opts = normalizedValue.split(',').map(v => v.trim()).filter(Boolean);
				opts.forEach(opt => selectValues.add(opt));
				return opts;
			}
			case 'typesFile':
				return trimmedValue ? trimmedValue.split(',').map(v => v.trim()).filter(Boolean) : [];
			default:
				return normalizedValue;
		}
	};

	let tables = await Promise.all(tableInfos.map(async (tableInfo) => {
		let tableNode: HTMLElement = tableInfo.tableNode;
		let cols: DatabaseColumn[] = Array.from(tableNode.querySelectorAll('thead > tr > th')).map((x: HTMLElement) => {
			return {
				type: detectColumnType(x),
				name: x.innerText.trim(),
				selectValues: new Set<string>(),
				selectColors: {},
				values: [],
			}
		})
		// Detect title column from cell-title class if SVG/img detection missed it
		const hasTitleCol = cols.some(c => c.type === 'typesTitle');
		if (!hasTitleCol) {
			const firstRow = tableNode.querySelector('tbody > tr');
			if (firstRow) {
				const tds = firstRow.querySelectorAll('td');
				for (let i = 0; i < tds.length && i < cols.length; i++) {
					if (tds[i].classList.contains('cell-title')) {
						cols[i].type = 'typesTitle';
						break;
					}
				}
			}
		}
		let priKeyIndex = 0; // Index of the primary key column
		for (const colIndex of cols.keys()) {
			if (cols[colIndex].type === 'typesTitle') {
				priKeyIndex = colIndex;
				break
			}
		}

		let csvRows: string[][] | null = null;
		let csvHeaders: string[] | null = null;
		const csvInfo = resolveCSVInfoForTable(info, tableInfo, pageNotionId);
		const databaseIdentity = resolveDatabaseIdentity(info, tableInfo, csvInfo);
		if (csvInfo) {
			try {
				if (!csvCache.has(csvInfo.id)) {
					const csvText = await csvInfo.entry.readText();
					const parsed = parseCSV(csvText);
					csvCache.set(csvInfo.id, {
						headers: parsed[0] ?? [],
						rows: parsed.slice(1),
					});
				}
				const cached = csvCache.get(csvInfo.id);
				if (cached?.headers.length) {
					csvHeaders = cached.headers;
					csvRows = cached.rows;
				}
			} catch (e) {
				addImportWarning(`Failed to parse CSV for database "${tableInfo.title}": ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		if (csvHeaders && csvRows) {
			const columnsByName = new Map<string, DatabaseColumn>(cols.map((col) => [normalizeNotionLookup(col.name), col]));
			csvHeaders.forEach((header, headerIndex) => {
				const normalizedHeader = normalizeNotionLookup(header);
				const inferredType = inferCSVColumnType(header, csvRows!.map((row) => row[headerIndex] ?? ''));
				const existingColumn = columnsByName.get(normalizedHeader);
				if (existingColumn) {
					if (shouldUpgradeColumnTypeFromCSV(existingColumn.type, inferredType)) {
						existingColumn.type = inferredType;
					}
					return;
				}
				const nextColumn: DatabaseColumn = {
					type: inferredType,
					name: header.trim(),
					selectValues: new Set<string>(),
					selectColors: {},
					values: [],
				};
				cols.push(nextColumn);
				columnsByName.set(normalizedHeader, nextColumn);
			});
		}

		const signatureColIndices = cols.map((_, index) => index);
		const htmlRows = parseHTMLDatabaseRows(info, tableNode, cols, priKeyIndex);

		for (const row of htmlRows) {
			while (row.values.length < cols.length) {
				row.values.push('');
			}
			finalizeParsedDatabaseRow(row, priKeyIndex, signatureColIndices);
		}

		let csvColMapping: number[] | null = null;
		if (csvHeaders && csvRows) {
			csvColMapping = cols.map((col) => {
				return csvHeaders!.findIndex((header) => normalizeNotionLookup(header) === normalizeNotionLookup(col.name));
			});
		}

		// Use CSV data if available and column mapping is valid
		if (csvRows && csvColMapping && csvColMapping.some(idx => idx >= 0)) {
			for (const csvRow of csvRows) {
				const rowid = generateSiYuanID();
				// Try to find linked page from title column in CSV
				let hasRelBlock = false;
				const titleCsvIdx = csvColMapping[priKeyIndex];
				if (titleCsvIdx >= 0) {
					const titleCell = csvRow[titleCsvIdx] || '';
					// CSV title may contain "Page Name (https://www.notion.so/...id)"
					const urlMatch = titleCell.match(/\(https?:\/\/(?:www\.)?notion\.so\/[^)]*?([a-f0-9]{32})[^)]*\)/);
					if (urlMatch) {
						const rowNotionID = urlMatch[1];
						if (info.idsToFileInfo[rowNotionID]?.blockID) {
							hasRelBlock = true;
						}
					}
				}

				for (let colIndex = 0; colIndex < cols.length; colIndex++) {
					const csvIdx = csvColMapping[colIndex];
					const rawValue = csvIdx >= 0 ? (csvRow[csvIdx] || '') : '';
					const parsedValue = parseCSVValue(rawValue, cols[colIndex].type, cols[colIndex].selectValues);

					cols[colIndex].values.push({
						rowid: rowid,
						hasRelBlock: hasRelBlock,
						value: parsedValue,
					});
				}
			}
		} else {
			// Fallback: use HTML tbody rows
			Array.from(tableNode.querySelectorAll('tbody > tr')).forEach((trNode: HTMLElement) => {
				try {
					const tdNodes = Array.from(trNode.querySelectorAll('td'));
					// Pad with empty elements if row has fewer cells than columns
					while (tdNodes.length < cols.length) {
						tdNodes.push(document.createElement('td'));
					}

					const priKeyCell = tdNodes[priKeyIndex];
					const priKeyAnchor = priKeyCell?.querySelector('a');
					const rowNotionID = priKeyAnchor ? getNotionId(priKeyAnchor.getAttribute('href') ?? '') : undefined;
					const rowid = (rowNotionID && info.idsToFileInfo[rowNotionID]?.blockID) || generateSiYuanID();
					const hasRelBlock = Boolean(rowNotionID && info.idsToFileInfo[rowNotionID] && info.idsToFileInfo[rowNotionID].blockID !== '');

					Array.from(tdNodes).forEach((tdNode: HTMLElement, colIndex: number) => {
						let baseColValue = {
							rowid: rowid,
							hasRelBlock: hasRelBlock,
						}
						if (cols[colIndex].type === 'typesTitle') {
							cols[colIndex].values.push({
								...baseColValue,
								value: (tdNode.querySelector('a')?.innerText ?? tdNode.textContent ?? '').trim()
							})
						} else if (cols[colIndex].type === 'typesDate' || cols[colIndex].type === 'typesCreatedTime' || cols[colIndex].type === 'typesLastEditedTime') {
							const times = tdNode.innerText.trim().replace('@', '').split('→').map(z => {
								return z.trim();
							}).filter(Boolean)
							cols[colIndex].values.push({
								...baseColValue,
								value: times
							})
						} else if (['typesSelect', 'typesMultipleSelect', 'typesStatus'].includes(cols[colIndex].type)) {
							let opts = Array.from(tdNode.querySelectorAll('span.selected-value')).map((selectSpan: HTMLElement) => {
								const opt = selectSpan.innerText.trim();
								const color = extractSelectColor(selectSpan);
								cols[colIndex].selectValues.add(opt);
								// Store color mapping for this option
								if (!cols[colIndex].selectColors) {
									cols[colIndex].selectColors = {};
								}
								cols[colIndex].selectColors[opt] = color;
								return { value: opt, color };
							});
							cols[colIndex].values.push({
								...baseColValue,
								value: opts.map(o => o.value)
							})
						} else if (cols[colIndex].type === 'typesCheckbox') {
							cols[colIndex].values.push({
								...baseColValue,
								value: Boolean(tdNode.querySelector('div.checkbox-on'))
							})
						} else if (cols[colIndex].type === 'typesFile') {
							cols[colIndex].values.push({
								...baseColValue,
								value: Array.from(tdNode.querySelectorAll('a')).map(aNode => {
									return getDecodedURI(aNode);
								})
							})
						} else {
							cols[colIndex].values.push({
								...baseColValue,
								value: tdNode.innerText.trim(),
							});
						}
					})
				} catch (e) {
					addImportWarning('Skipping malformed database row: ' + (e instanceof Error ? e.message : String(e)));
				}
			});
		}
		let mergedRows = htmlRows;
		if (csvRows && csvColMapping && csvColMapping.some((idx) => idx >= 0)) {
			const matchedHTMLRows = new Set<ParsedDatabaseRow>();
			const htmlRowsBySignature = makeRowQueueMap(htmlRows, 'signature');
			const htmlRowsByTitle = makeRowQueueMap(htmlRows, 'titleKey');

			mergedRows = csvRows.map((csvRow) => {
				const rowValues = cols.map((col, colIndex) => {
					const csvIdx = csvColMapping![colIndex];
					const rawValue = csvIdx >= 0 ? (csvRow[csvIdx] || '') : '';
					return parseCSVValue(rawValue, col.type, col.selectValues);
				});

				const candidateRow = finalizeParsedDatabaseRow({
					rowid: '',
					hasRelBlock: false,
					values: rowValues,
					displayValues: cols.map((_, colIndex) => {
						const csvIdx = csvColMapping![colIndex];
						return csvIdx >= 0 ? stripNotionCSVLinkSuffix(csvRow[csvIdx] || '') : '';
					}),
					signature: '',
					titleKey: '',
				}, priKeyIndex, signatureColIndices);

				let matchedRow = shiftQueuedRow(htmlRowsBySignature, candidateRow.signature);
				if (!matchedRow) {
					matchedRow = shiftQueuedRow(htmlRowsByTitle, candidateRow.titleKey);
				}
				if (matchedRow) {
					matchedHTMLRows.add(matchedRow);
				}

				const titleCsvIdx = csvColMapping[priKeyIndex];
				const rowNotionID =
					matchedRow?.notionRowID ||
					(titleCsvIdx >= 0 ? extractRowNotionIDFromCSVTitle(csvRow[titleCsvIdx] || '') : undefined);
				const linkedBlockID = rowNotionID ? info.idsToFileInfo[rowNotionID]?.blockID : '';

				return {
					notionRowID: rowNotionID,
					rowid: matchedRow?.rowid || linkedBlockID || generateSiYuanID(),
					hasRelBlock: matchedRow?.hasRelBlock ?? Boolean(linkedBlockID),
					values: rowValues,
					displayValues: matchedRow?.displayValues || candidateRow.displayValues,
					signature: candidateRow.signature,
					titleKey: candidateRow.titleKey,
				};
			});

			const csvNotionRowIDs = new Set<string>();
			for (const row of mergedRows) {
				if (row.notionRowID) {
					csvNotionRowIDs.add(row.notionRowID);
				}
			}
			for (const row of htmlRows) {
				if (matchedHTMLRows.has(row)) continue;
				if (!row.notionRowID) {
					addImportWarning(`Dropping unmatched HTML row without Notion ID in database "${tableInfo.title}" (title: "${row.titleKey || 'unknown'}")`);
					continue;
				}
				if (!info.idsToFileInfo[row.notionRowID]) continue;
				if (csvNotionRowIDs.has(row.notionRowID)) continue;
				mergedRows.push(row);
				csvNotionRowIDs.add(row.notionRowID);
			}
		}

		for (const col of cols) {
			col.values = [];
		}
		for (const row of mergedRows) {
			for (let colIndex = 0; colIndex < cols.length; colIndex++) {
				cols[colIndex].values.push({
					rowid: row.rowid,
					hasRelBlock: row.hasRelBlock,
					value: row.values[colIndex] ?? '',
				});
			}
		}
		const numericDisplayByColumn = inferNumberDisplaySpecs(cols, mergedRows);
		const rowCollectionPaths = getRowCollectionPathsForRows(info, mergedRows);
		const notionRowIDs = mergedRows
			.map((row) => row.notionRowID)
			.filter((rowID): rowID is string => Boolean(rowID));
		const pageCollectionPath = tableInfo.pagePath
			? normalizeNotionLookup(
				[
					parseFilePath(tableInfo.pagePath).parent,
					tableInfo.title,
				]
					.filter(Boolean)
					.join('/'),
			)
			: '';

		return {
			title: tableInfo.title,
			viewName: tableInfo.viewSpec.name || tableInfo.viewName || tableInfo.title,
			viewSpec: {
				...tableInfo.viewSpec,
				numericDisplayByColumn: {
					...tableInfo.viewSpec.numericDisplayByColumn,
					...numericDisplayByColumn,
				},
				rowOrder: tableInfo.viewSpec.rowOrder.length > 0
					? tableInfo.viewSpec.rowOrder
					: mergedRows.map((row) => getDatabaseRowKey(row)),
			},
			cols: cols,
			rows: mergedRows,
			databaseIdentity,
			csvCollectionPath: csvInfo?.normalizedCollectionPath ?? '',
			pageCollectionPath,
			rowCollectionPaths,
			notionRowIDs,
		} satisfies BuiltDatabaseTable;
	}))
	normalizeBuiltDatabaseIdentities(tables);
	tables.forEach((table) => harmonizeBuiltDatabaseIdentity(info, table));
	const renderedViews = tables.map((table) => {
		const sharedState = getOrCreateSharedDatabaseState(info, table);
		const view = mergeBuiltTableIntoSharedState(info, sharedState, table);
		materializeSharedDatabaseState(info, sharedState);
		return {
			avID: sharedState.avID,
			viewID: view.id,
			avData: sharedState.avData,
		};
	});
	const avs = Array.from(new Map(renderedViews.map((view) => [view.avID, view.avData])).values());
	// Replace database DOM elements with [:av:ID:] placeholders for later processing
	let collectionContentSelector = 'table[class="collection-content"]';
	if (isEmbedTable) {
		collectionContentSelector = 'div[class="collection-content"]'
	}
	body.querySelectorAll(collectionContentSelector).forEach((table, i) => {
		var newDiv = document.createElement('div');
		newDiv.textContent = `[:av:${renderedViews[i].avID}:${renderedViews[i].viewID}:]`;
		table.parentNode.replaceChild(newDiv, table);
	});
	return avs;
}
