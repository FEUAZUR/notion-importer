// Column-type inference, checked against markup taken verbatim from a real Notion
// "Export as HTML" archive (726 pages, 17 collection tables).
import { parseHTML } from 'linkedom';
import { detectColumnTypeFromCells } from '../src/libs/formats/notion/convert-to-md.js';

const { document, HTMLElement } = parseHTML('<html><body></body></html>');
// convert-to-md reaches for the ambient DOM through util.ts helpers.
(globalThis as any).document = document;
(globalThis as any).HTMLElement = HTMLElement;

let passed = 0;
const failures: string[] = [];

function cellsOf(...html: string[]): any[] {
    return html.map((markup) => {
        const td = document.createElement('td');
        td.innerHTML = markup;
        return td;
    });
}

function check(name: string, actual: unknown, expected: unknown) {
    if (actual === expected) {
        passed += 1;
    } else {
        failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
    }
}

// Every sample below is real markup from the export, with the header icon that Notion
// actually shipped for it noted alongside.

// icon: arrow-circle-down
check('single select',
    detectColumnTypeFromCells(cellsOf(
        '<span class="selected-value select-value-color-green">2024</span>',
        '<span class="selected-value select-value-color-blue">2025</span>',
    )),
    'typesSelect');

// icon: list
check('multi select',
    detectColumnTypeFromCells(cellsOf(
        '<span class="selected-value select-value-color-green">Business</span><span class="selected-value select-value-color-red">Perso</span>',
        '<span class="selected-value select-value-color-green">Business</span>',
    )),
    'typesMultipleSelect');

// icon: burst
check('status',
    detectColumnTypeFromCells(cellsOf('<span class="status-value"><div class="status-dot"></div>Not started</span>')),
    'typesStatus');

// icon: barcode -- proves the header icon is not a usable signal
check('checkbox behind a barcode icon',
    detectColumnTypeFromCells(cellsOf('<div class="checkbox checkbox-on"></div>', '<div class="checkbox checkbox-off"></div>')),
    'typesCheckbox');

// icon: database / arrow-northeast
check('relation',
    detectColumnTypeFromCells(cellsOf(
        '<a href="Gestion%20Serveur/gnwy9032%206cc9fbe3a733405da56ac8dba2d3ea38.html">gnwy9032</a>',
        '<a href="Type/Court%20Terme%2013e1fb002e4381c4a08deb2cde099107.html">Court Terme</a>',
    )),
    'typesRelation');

// icon: cash / currency / hashtag
check('currency number',
    detectColumnTypeFromCells(cellsOf('60,00 €', '3 388,00 €')),
    'typesNumber');

// icon: calendar
check('date',
    detectColumnTypeFromCells(cellsOf('<time>@1 juin 2025</time>', '<time>@2 juin 2025</time>')),
    'typesDate');

// icon: description / server -- free text must stay text
check('free text stays unclassified',
    detectColumnTypeFromCells(cellsOf('1h', 'About the thing')),
    null);

check('multi-line text is not a relation',
    detectColumnTypeFromCells(cellsOf('yiff-party.com <br/>yiff-hub.com')),
    null);

check('empty column yields no opinion',
    detectColumnTypeFromCells(cellsOf('', '')),
    null);

// A mixed column must not be forced into a type.
check('mixed select and text stays unclassified',
    detectColumnTypeFromCells(cellsOf('<span class="selected-value">A</span>', 'plain text')),
    null);

if (failures.length) {
    console.error(`FAILED ${failures.length} of ${passed + failures.length}`);
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
}
console.log(`ok - ${passed} column-type assertions passed`);
