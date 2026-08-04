import {
	detectDateOrderPreference,
	escapeHashtags,
	getNotionId,
	parseEuropeanNumber,
	parseNotionDate,
	stripNotionId,
} from '../src/libs/formats/notion/notion-utils.js';
import { parseFilePath, splitext } from '../src/libs/path-utils.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed += 1;
	} else {
		failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
	}
}

function localMidnight(year: number, month: number, day: number, hours = 0, minutes = 0) {
	return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

// --- stripNotionId: must not eat legitimate hyphens -------------------------------
check('stripNotionId keeps hyphens',
	stripNotionId('Well-Being Q1-2025 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'),
	'Well-Being Q1-2025');
check('stripNotionId keeps extension',
	stripNotionId('Page 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.html'),
	'Page.html');
check('stripNotionId leaves plain titles alone',
	stripNotionId('Just A Title'),
	'Just A Title');

// --- getNotionId: must recognise the "_all.csv" variant ---------------------------
check('getNotionId plain csv',
	getNotionId('Tasks 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.csv'),
	'1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d');
check('getNotionId _all.csv',
	getNotionId('Tasks 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d_all.csv'),
	'1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d');

// --- dates: hasTime drives isNotTime ---------------------------------------------
check('date-only is local midnight, no time',
	parseNotionDate('June 1, 2025'),
	{ timestamp: localMidnight(2025, 6, 1), hasTime: false });
check('English 12-hour pm',
	parseNotionDate('July 22, 2024 3:00 PM'),
	{ timestamp: localMidnight(2024, 7, 22, 15, 0), hasTime: true });
check('English 12-hour am midnight',
	parseNotionDate('July 22, 2024 12:30 AM'),
	{ timestamp: localMidnight(2024, 7, 22, 0, 30), hasTime: true });
check('French month with time',
	parseNotionDate('22 juillet 2024 15:04'),
	{ timestamp: localMidnight(2024, 7, 22, 15, 4), hasTime: true });
check('German month',
	parseNotionDate('22. Marz 2024'),
	{ timestamp: localMidnight(2024, 3, 22), hasTime: false });
check('Spanish month',
	parseNotionDate('22 de enero de 2024'),
	{ timestamp: localMidnight(2024, 1, 22), hasTime: false });
check('CJK date',
	parseNotionDate('2024年7月22日'),
	{ timestamp: localMidnight(2024, 7, 22), hasTime: false });
check('ISO with T',
	parseNotionDate('2024-07-22T15:04'),
	{ timestamp: localMidnight(2024, 7, 22, 15, 4), hasTime: true });
check('year only',
	parseNotionDate('2024'),
	{ timestamp: localMidnight(2024, 1, 1), hasTime: false });
check('plain number is not a date',
	parseNotionDate('42'),
	null);
check('overflow rejected',
	parseNotionDate('February 30, 2024'),
	null);
check('unambiguous DMY',
	parseNotionDate('22/07/2024'),
	{ timestamp: localMidnight(2024, 7, 22), hasTime: false });
check('ambiguous honours mdy preference',
	parseNotionDate('01/02/2024', 'mdy'),
	{ timestamp: localMidnight(2024, 1, 2), hasTime: false });
check('ambiguous defaults to dmy',
	parseNotionDate('01/02/2024'),
	{ timestamp: localMidnight(2024, 2, 1), hasTime: false });

check('order vote detects mdy', detectDateOrderPreference(['01/02/2024', '03/25/2024']), 'mdy');
check('order vote detects dmy', detectDateOrderPreference(['25/03/2024', '01/02/2024']), 'dmy');
check('order vote stays auto when ambiguous', detectDateOrderPreference(['01/02/2024']), 'auto');

// --- numbers ----------------------------------------------------------------------
check('european decimal', parseEuropeanNumber('60,00 €')?.value, 60);
check('us thousands', parseEuropeanNumber('3,388.00')?.value, 3388);
check('european thousands', parseEuropeanNumber('3.388,00')?.value, 3388);
check('rouble symbol', parseEuropeanNumber('1 000₽')?.value, 1000);
check('percent', parseEuropeanNumber('50%')?.value, 0.5);
check('Infinity rejected', parseEuropeanNumber('Infinity'), null);
check('text rejected', parseEuropeanNumber('not a number'), null);

// --- hashtags ---------------------------------------------------------------------
check('repeated hashtag escaped once each',
	escapeHashtags('#todo and #todo'),
	'\\#todo and \\#todo');

// --- paths ------------------------------------------------------------------------
check('parseFilePath', parseFilePath('a/b/c.HTML'),
	{ parent: 'a/b', name: 'c.HTML', basename: 'c', extension: 'html' });
check('splitext dotfile', splitext('.gitignore'), ['.gitignore', '']);

// ----------------------------------------------------------------------------------
if (failures.length) {
	console.error(`FAILED ${failures.length} of ${passed + failures.length}`);
	for (const failure of failures) {
		console.error(`  ✗ ${failure}`);
	}
	process.exit(1);
}
console.log(`ok - ${passed} assertions passed`);
