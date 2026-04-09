import type { ZipEntryFile } from '../../zip.js';

export type NotionPropertyType =
	| 'text'
	| 'number'
	| 'select'
	| 'multi_select'
	| 'status'
	| 'date'
	| 'person'
	| 'file'
	| 'checkbox'
	| 'url'
	| 'email'
	| 'phone_number'
	| 'formula'
	| 'relation'
	| 'rollup'
	| 'created_time'
	| 'created_by'
	| 'last_edited_time'
	| 'last_edited_by'
	| 'auto_increment_id';

export type NotionProperty = {
	type: 'text' | 'date' | 'number' | 'list' | 'checkbox';
	title: string;
	notionType: NotionPropertyType;
	links: NotionLink[];
	body: HTMLTableCellElement;
};

export type MarkdownInfo = {
	content: string;
	attrs: { [key: string]: string };
	attributeViews: any[];
	attributeViewBlocks: Array<{
		avID: string;
		viewID?: string;
	}>;
	inlineStyleMarkers?: Record<string, InlineStyleMarker>;
	coverImage?: string;
	pageIcon?: string;
	warnings?: string[];
}

export type InlineStyleMarker = {
	color?: string;
	backgroundColor?: string;
};

export type NotionDatabaseViewFilter = {
	columnName: string;
	operator: string;
	value?: string | string[] | boolean | null;
};

export type NotionDatabaseViewSort = {
	columnName: string;
	direction: 'asc' | 'desc';
};

export type NotionDatabaseViewGroupBy = {
	columnName: string;
	folded?: boolean;
	itemIDs?: string[] | null;
	hidden?: number;
	sort?: number;
	created?: number;
};

export type NotionImageDisplay = {
	width?: string;
	align?: 'left' | 'center' | 'right' | 'stretch';
};

export type NotionNumberDisplaySpec = {
	roundedUpToUnit: boolean;
	numberFormat: string;
	sampleDisplay?: string;
};

export type NotionDatabaseViewSpec = {
	name: string;
	filters: NotionDatabaseViewFilter[];
	sorts: NotionDatabaseViewSort[];
	groupBy: NotionDatabaseViewGroupBy | null;
	visibleColumnNames: string[];
	rowOrder: string[];
	numericDisplayByColumn: Record<string, NotionNumberDisplaySpec>;
};

export type ImportLogLevel = 'info' | 'warn' | 'error';

export interface ImportStats {
	docs: number;
	attachments: number;
	databases: number;
	errors: number;
}

export interface NotionImportReporter {
	setPhase(phase: string): void;
	log(level: ImportLogLevel, message: string): void;
	updateProgress(current: number, total: number): void;
	setCurrentItem(name: string): void;
	updateStats(stats: ImportStats): void;
}

export type NotionLink =
	{
		type: 'relation';
		id: string;
		a: HTMLAnchorElement;
	}
	|
	{
		type: 'attachment';
		path: string;
		a: HTMLAnchorElement;
	}
	|
	{
		type: 'image';
		path: string;
		a: HTMLAnchorElement;
	};


export interface NotionFileInfo {
	title: string;
	displayTitle?: string;
	parentIds: string[];
	blockID: string;
	path: string;
	ctime: Date | null;
	mtime: Date | null;
	hasContent: boolean;
}

export interface NotionAttachmentInfo {
	path: string;
	parentIds: string[];
	nameWithExtension: string;
	targetParentFolder: string;
	pathInSiYuanFs: string;
	pathInSiYuanMd: string;
}

export interface NotionCSVFileInfo {
	id: string;
	entry: ZipEntryFile;
	title: string;
	parent: string;
	collectionPath: string;
	normalizedTitle: string;
	normalizedCollectionPath: string;
}

export type WorkspaceManifestNodeKind =
	| 'workspace'
	| 'page'
	| 'inline_database'
	| 'csv';

export interface WorkspaceManifestNode {
	kind: WorkspaceManifestNodeKind;
	rawID: string;
	notionID: string;
	title: string;
	href: string;
	parentID: string | null;
	parentIDs: string[];
	childIDs: string[];
	depth: number;
	normalizedTitle: string;
	normalizedHref: string;
}

export interface WorkspaceManifest {
	workspaceID: string;
	rootIDs: string[];
	orderedIDs: string[];
	nodesByID: Record<string, WorkspaceManifestNode>;
}

export interface NotionExportRegistry {
	entries: ZipEntryFile[];
	indexEntry?: ZipEntryFile;
	manifest?: WorkspaceManifest;
	resolverInfo: NotionResolverInfo;
	htmlEntriesByID: Record<string, ZipEntryFile>;
	assetEntriesByPath: Record<string, ZipEntryFile>;
}

export interface NotionWritePlanDocument {
	notionID: string;
	depth: number;
	entry: ZipEntryFile;
	fileInfo: NotionFileInfo;
}

export interface NotionWritePlanAttachment {
	entry: ZipEntryFile;
	attachmentInfo: NotionAttachmentInfo;
}

export interface SiYuanWritePlan {
	notebookName: string;
	registry: NotionExportRegistry;
	documents: NotionWritePlanDocument[];
	attachments: NotionWritePlanAttachment[];
	existingTitles?: Set<string>;
}

export class NotionResolverInfo {
	idsToFileInfo: Record<string, NotionFileInfo> = {};
	pathsToAttachmentInfo: Record<string, NotionAttachmentInfo> = {};
	csvFiles: Record<string, ZipEntryFile> = {}; // notionId -> ZipEntryFile for CSV data
	csvFileInfos: Record<string, NotionCSVFileInfo> = {};
	csvFilesByCollectionPath: Record<string, NotionCSVFileInfo[]> = {};
	csvFilesByTitle: Record<string, NotionCSVFileInfo[]> = {};
	attributeViewsByDatabaseIdentity: Record<string, any> = {};
	attributeViewsByCorrelationKey: Record<string, any> = {};
	attributeViewsByNormalizedTitle: Record<string, any[]> = {};
	databaseIdentityAliases: Record<string, string> = {};
	databaseCorrelationGroupsByTitle: Record<string, any[]> = {};
	attachmentPath: string;
	singleLineBreaks: boolean;

	constructor(attachmentPath: string, singleLineBreaks: boolean) {
		this.attachmentPath = attachmentPath;
		this.singleLineBreaks = singleLineBreaks;
	}

	getPathForFile(fileInfo: NotionFileInfo | NotionAttachmentInfo) {
		let { idsToFileInfo } = this;
		const pathNames = fileInfo.path.split('/');
		const parts = fileInfo.parentIds
			.map((parentId) =>
				idsToFileInfo[parentId]?.title ??
				pathNames.find((pathSegment) => pathSegment.includes(parentId))?.replace(` ${parentId}`, '')
			)
			// Notion inline databases have no .html file and aren't a note, so we just filter them out of the folder structure.
			.filter((parentId) => parentId)
			// Folder names can't end in a dot or a space
			.map((folder) => folder.replace(/[\. ]+$/, ''));
		// Always return an absolute path starting with /
		if (parts.length === 0) return '/';
		return '/' + parts.join('/') + '/';
	}
}
