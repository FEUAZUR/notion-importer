import { parseFilePath } from '../../path-utils.js';

const NOTION_ID_RE = /[ -]?[a-f0-9]{32}(?=\.|$)/;

/**
 * Strips the trailing 32-hex Notion id. The previous version ran `replace(/-/g, '')`
 * first, which also destroyed every legitimate hyphen in the title
 * ("Well-Being Q1-2025" became "WellBeing Q12025").
 */
export const stripNotionId = (id: string) => {
	const compact = id.replace(/-/g, '');
	if (!NOTION_ID_RE.test(compact)) {
		return id;
	}
	// Remove the id from the original string, tolerating the dashed UUID form.
	return id
		.replace(/[ -]?[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}(?=\.|$)/, '')
		.replace(/[ -]?[a-f0-9]{32}(?=\.|$)/, '');
};

// Notion UUIDs come at the end of filenames/URL paths and are always 32 characters long.
// The trailing group must also allow `_` so that "<name> <id>_all.csv" is recognised.
export const getNotionId = (id: string) => {
	return id.replace(/-/g, '').match(/([a-f0-9]{32})(\?|\.|_|$)/)?.[1];
};

export function normalizeNotionLookup(value: string) {
	let normalized = value ?? '';
	try {
		normalized = decodeURI(normalized);
	} catch {
		// Keep the raw value if the export already contains decoded characters.
	}
	return normalized
		.normalize('NFC')
		.replace(/\\/g, '/')
		.replace(/^\.?\//, '')
		.replace(/\/+/g, '/')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

export const parseParentIds = (filename: string) => {
	const { parent } = parseFilePath(filename);
	return parent
		.split('/')
		.map((parentNote) => getNotionId(parentNote))
		.filter((id) => id) as string[];
};

export function stripParentDirectories(relativeURI: string) {
	return relativeURI.replace(/^(\.\.\/)+/, '');
}

export function escapeHashtags(body: string) {
	const tagExp = /#[a-z0-9\-]+/gi;
	if (!tagExp.test(body)) return body;

	const lines = body.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const hashtags = lines[i].match(tagExp);
		if (!hashtags) continue;
		let newLine = lines[i];
		// Deduplicate: `replace` only hits the first occurrence, so a repeated tag used to be
		// escaped twice ("\\#todo") while the later occurrence stayed bare.
		for (const hashtag of Array.from(new Set(hashtags))) {
			const hashtagInLink = new RegExp(
				`\\[\\[[^\\]]*${hashtag}[^\\]]*\\]\\]|\\[[^\\]]*${hashtag}[^\\]]*\\]\\([^\\)]*\\)|\\[[^\\]]*\\]\\([^\\)]*${hashtag}[^\\)]*\\)|\\\\${hashtag}`
			);
			if (hashtagInLink.test(newLine)) continue;
			newLine = newLine.split(hashtag).join('\\' + hashtag);
		}
		lines[i] = newLine;
	}
	return lines.join('\n');
}

/**
 * Hoists all child nodes of this node to where this node used to be,
 * removing this node altogether from the DOM.
 */
export function hoistChildren(el: ChildNode) {
	el.replaceWith(...Array.from(el.childNodes));
}

const notionMonthLookup: Record<string, number> = {};

function registerMonths(names: string[][]) {
	names.forEach((aliases, index) => {
		for (const alias of aliases) {
			notionMonthLookup[alias] = index;
		}
	});
}

// Notion exports in the workspace UI language, so month names arrive localised.
registerMonths([
	['jan', 'january', 'janvier', 'januar', 'enero', 'ene', 'gennaio', 'gen', 'janeiro', 'januari'],
	['feb', 'february', 'fev', 'fevr', 'fevrier', 'februar', 'febrero', 'febbraio', 'fevereiro', 'februari'],
	['mar', 'march', 'mars', 'marz', 'maerz', 'marzo', 'marco', 'maart'],
	['apr', 'april', 'avr', 'avril', 'abril', 'aprile'],
	['may', 'mai', 'mayo', 'maggio', 'maio', 'mei'],
	['jun', 'june', 'juin', 'juni', 'junio', 'giugno', 'junho'],
	['jul', 'july', 'juil', 'juillet', 'juli', 'julio', 'luglio', 'julho'],
	['aug', 'august', 'aou', 'aout', 'agosto', 'augustus', 'ago'],
	['sep', 'sept', 'september', 'septembre', 'septiembre', 'settembre', 'setembro'],
	['oct', 'october', 'octobre', 'oktober', 'octubre', 'ottobre', 'outubro', 'okt'],
	['nov', 'november', 'novembre', 'noviembre', 'novembro'],
	['dec', 'december', 'decembre', 'dezember', 'diciembre', 'dicembre', 'dezembro', 'dic', 'dez'],
]);

export type NotionDateOrder = 'auto' | 'dmy' | 'mdy';

export interface ParsedNotionDate {
	timestamp: number;
	/** False for a plain calendar date; drives SiYuan's `isNotTime` flag. */
	hasTime: boolean;
}

function sanitizeNotionDateInput(value: string) {
	return value
		.trim()
		.replace(/^@/, '')
		.replace(/[\u00A0\u202F]/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/,/g, ' ')
		.trim();
}

function foldAccents(value: string) {
	return value.normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase();
}

function lookupMonth(token: string): number | undefined {
	return notionMonthLookup[token.replace(/\./g, '')];
}

/**
 * A calendar date is stored at LOCAL midnight: the kernel renders with
 * `time.UnixMilli(content).Format("2006-01-02")`, which uses the local zone, so UTC
 * midnight would show the previous day for every negative UTC offset.
 */
function buildDate(
	year: number,
	month: number,
	day: number,
	time?: { hours: number; minutes: number },
): ParsedNotionDate | null {
	if (day < 1 || day > 31 || month < 0 || month > 11 || !Number.isFinite(year)) return null;
	const date = new Date(year, month, day, time?.hours ?? 0, time?.minutes ?? 0, 0, 0);
	if (Number.isNaN(date.getTime())) return null;
	// Reject overflow such as Feb 30 rolling into March.
	if (date.getMonth() !== month || date.getDate() !== day) return null;
	return { timestamp: date.getTime(), hasTime: Boolean(time) };
}

const TIME_RE = /(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i;

/** Splits a trailing clock time off the value, honouring 12-hour suffixes. */
function extractTime(value: string): { rest: string; time?: { hours: number; minutes: number } } {
	const match = value.match(new RegExp(`\\s+${TIME_RE.source}`, 'i'));
	if (!match) {
		return { rest: value };
	}
	const meridiem = match[4]?.replace(/\./g, '').toLowerCase();
	// A bare 1-2 digit number with no colon and no am/pm is a day or year fragment, not a time.
	if (!match[2] && !meridiem) {
		return { rest: value };
	}

	let hours = Number(match[1]);
	const minutes = match[2] ? Number(match[2]) : 0;
	if (meridiem === 'pm' && hours < 12) hours += 12;
	if (meridiem === 'am' && hours === 12) hours = 0;
	if (hours > 23 || minutes > 59) {
		return { rest: value };
	}
	return { rest: value.slice(0, match.index).trim(), time: { hours, minutes } };
}

export function detectDateOrderPreference(values: string[]): NotionDateOrder {
	let dmyScore = 0;
	let mdyScore = 0;

	for (const rawValue of values) {
		const cleaned = foldAccents(sanitizeNotionDateInput(rawValue ?? ''));
		const { rest } = extractTime(cleaned);
		const match = rest.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
		if (!match) continue;
		const first = Number(match[1]);
		const second = Number(match[2]);
		if (first > 12 && second <= 12) dmyScore++;
		if (second > 12 && first <= 12) mdyScore++;
	}

	if (dmyScore > mdyScore) return 'dmy';
	if (mdyScore > dmyScore) return 'mdy';
	return 'auto';
}

export function parseNotionDate(rawValue: string, preferredOrder: NotionDateOrder = 'auto'): ParsedNotionDate | null {
	const cleaned = sanitizeNotionDateInput(rawValue ?? '');
	if (!cleaned) return null;

	const normalized = foldAccents(cleaned);
	// A bare number is a numeric cell, except a plausible 4-digit year.
	if (/^[+-]?\d+(?:[.,]\d+)?$/.test(normalized)) {
		const year = Number(normalized);
		if (/^\d{4}$/.test(normalized) && year >= 1000 && year <= 9999) {
			return buildDate(year, 0, 1);
		}
		return null;
	}

	// ISO 8601, the only form where a `T` separator appears.
	let match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2})/);
	if (match) {
		return buildDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]), {
			hours: Number(match[4]),
			minutes: Number(match[5]),
		});
	}

	// CJK: 2024年7月22日
	match = normalized.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(?:(\d{1,2})\s*日)?/);
	if (match) {
		const { time } = extractTime(normalized);
		return buildDate(Number(match[1]), Number(match[2]) - 1, match[3] ? Number(match[3]) : 1, time);
	}

	const { rest, time } = extractTime(normalized);

	// Month + year only
	match = rest.match(/^([a-z.]+)\s+(\d{4})$/);
	if (match) {
		const month = lookupMonth(match[1]);
		if (month !== undefined) return buildDate(Number(match[2]), month, 1, time);
	}
	match = rest.match(/^(\d{4})\s+([a-z.]+)$/);
	if (match) {
		const month = lookupMonth(match[2]);
		if (month !== undefined) return buildDate(Number(match[1]), month, 1, time);
	}
	match = rest.match(/^(\d{1,2})[/.-](\d{4})$/);
	if (match) {
		const month = Number(match[1]);
		if (month >= 1 && month <= 12) return buildDate(Number(match[2]), month - 1, 1, time);
	}
	match = rest.match(/^(\d{4})[/.-](\d{1,2})$/);
	if (match) {
		const month = Number(match[2]);
		if (month >= 1 && month <= 12) return buildDate(Number(match[1]), month - 1, 1, time);
	}

	// Year-first numeric
	match = rest.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
	if (match) {
		return buildDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]), time);
	}

	// Ambiguous numeric: disambiguate per value, then fall back to the column-wide vote.
	match = rest.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
	if (match) {
		const first = Number(match[1]);
		const second = Number(match[2]);
		let year = Number(match[3]);
		if (match[3].length === 2) {
			year += year < 70 ? 2000 : 1900;
		}
		if (first > 12 && second <= 12) return buildDate(year, second - 1, first, time);
		if (second > 12 && first <= 12) return buildDate(year, first - 1, second, time);
		return preferredOrder === 'mdy'
			? buildDate(year, first - 1, second, time)
			: buildDate(year, second - 1, first, time);
	}

	// Textual month forms
	// The trailing dot covers the German/Dutch ordinal form ("22. Marz 2024").
	match = rest.match(/^(\d{1,2})(?:st|nd|rd|th|\.)?\s+(?:de\s+)?([a-z.]+)\s+(?:de\s+)?(\d{4})$/);
	if (match) {
		const month = lookupMonth(match[2]);
		if (month !== undefined) return buildDate(Number(match[3]), month, Number(match[1]), time);
	}
	match = rest.match(/^([a-z.]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/);
	if (match) {
		const month = lookupMonth(match[1]);
		if (month !== undefined) return buildDate(Number(match[3]), month, Number(match[2]), time);
	}

	return null;
}

export function parseNotionDateValue(rawValue: string, preferredOrder: NotionDateOrder = 'auto'): Date | null {
	const parsed = parseNotionDate(rawValue, preferredOrder);
	return parsed ? new Date(parsed.timestamp) : null;
}

export function toTimestamp(dateString: string, preferredOrder: NotionDateOrder = 'auto'): number {
	return parseNotionDate(dateString, preferredOrder)?.timestamp ?? 0;
}

const CURRENCY_SYMBOLS = /[€$£¥₹₽₩₺₪₫₴₦฿]/g;
const CURRENCY_CODES = /\b(EUR|USD|GBP|CHF|JPY|CAD|AUD|CNY|RUB|INR|KRW|TRY|BRL|MXN|SEK|NOK|DKK|PLN|CZK|ZAR|HKD|SGD|NZD|THB|TWD|ILS)\b/gi;

// Parse numbers in either European or US notation ("60,00 €", "3 388,00", "192.00", "1 000₽")
export function parseEuropeanNumber(raw: string): { value: number; formatted: string } | null {
	if (!raw || !raw.trim()) return null;

	let s = raw.trim();
	s = s.replace(CURRENCY_SYMBOLS, '').trim();
	s = s.replace(CURRENCY_CODES, '').trim();
	s = s.replace(/[\s\u00A0\u202F]/g, '');

	const isPercent = s.includes('%');
	s = s.replace(/%/g, '').trim();
	if (!s) return null;

	const lastComma = s.lastIndexOf(',');
	const lastDot = s.lastIndexOf('.');

	if (lastComma > lastDot) {
		s = s.replace(/\./g, '').replace(',', '.');
	} else if (lastDot > lastComma) {
		s = s.replace(/,/g, '');
	} else if (lastComma >= 0 && lastDot < 0) {
		const afterComma = s.split(',')[1];
		s = afterComma && afterComma.length <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
	}

	// Number('') is 0 and Number('Infinity') passes isNaN; both used to produce bogus cells.
	if (!/^[+-]?\d+(?:\.\d+)?$/.test(s)) return null;
	const num = Number(s);
	if (!Number.isFinite(num)) return null;

	return {
		value: isPercent ? num / 100 : num,
		formatted: raw.trim(),
	};
}
