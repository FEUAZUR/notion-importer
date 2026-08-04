// End-to-end verification of the v1.1 changes against a LIVE SiYuan kernel.
//
// It writes a notebook, a document and an attribute view, so point it at a scratch
// workspace, never at real data:
//
//   "<SiYuan>/resources/kernel/SiYuan-Kernel.exe" serve \
//       --workspace /tmp/sy-test --port 6899 --wd "<SiYuan>/resources"
//   SIYUAN_URL=http://127.0.0.1:6899 pnpm run test:e2e
//
// Verified against SiYuan 3.7.3: 23/23 checks.
const BASE = process.env.SIYUAN_URL ?? 'http://127.0.0.1:6806';

let pass = 0;
const fails = [];
function check(name, ok, detail = '') {
    if (ok) { pass += 1; console.log(`  ok   ${name}`); }
    else { fails.push(`${name}${detail ? ' -- ' + detail : ''}`); console.log(`  FAIL ${name} ${detail}`); }
}

async function api(path, body) {
    const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    return res.json();
}

// Mirrors src/libs/util.ts generateSiYuanID (LOCAL time, not toISOString).
const used = new Set();
function localTimestamp(d) {
    const p = (v, n = 2) => String(v).padStart(n, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function newID() {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id;
    do {
        let r = '';
        for (let i = 0; i < 7; i += 1) r += alphabet[Math.floor(Math.random() * 36)];
        id = `${localTimestamp(new Date())}-${r}`;
    } while (used.has(id));
    used.add(id);
    return id;
}

console.log('\n=== 1. notebook + document ===');
// Unique per run so re-running does not fight leftovers from a previous run.
const nbName = `Notion ${Date.now().toString(36)}`;
let r = await api('/api/notebook/createNotebook', { name: nbName });
check('createNotebook', r.code === 0, r.msg);
const boxID = r.data.notebook.id;

// Non-destructive re-import: a second run must NOT reuse or delete the first notebook.
const list = await api('/api/notebook/lsNotebooks', {});
const taken = new Set(list.data.notebooks.map((n) => n.name));
const stamp = (d) => {
    const p = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`;
};
const secondName = taken.has(nbName) ? `${nbName} (${stamp(new Date())})` : nbName;
check('second import picks a distinct notebook name', secondName !== nbName, secondName);
const r2 = await api('/api/notebook/createNotebook', { name: secondName });
check('second notebook created', r2.code === 0, r2.msg);
const stillThere = (await api('/api/notebook/lsNotebooks', {})).data.notebooks.filter((n) => n.name === nbName);
check('first notebook survived the second import', stillThere.length === 1);

r = await api('/api/filetree/createDocWithMd', { notebook: boxID, path: '/Page A', markdown: '' });
check('createDocWithMd', r.code === 0, r.msg);
const docID = r.data;

console.log('\n=== 2. block id uses LOCAL time (was UTC) ===');
const nowLocal = localTimestamp(new Date());
const idPrefix = docID.slice(0, 14);
const driftMin = Math.abs(
    Date.UTC(+nowLocal.slice(0, 4), +nowLocal.slice(4, 6) - 1, +nowLocal.slice(6, 8), +nowLocal.slice(8, 10), +nowLocal.slice(10, 12))
    - Date.UTC(+idPrefix.slice(0, 4), +idPrefix.slice(4, 6) - 1, +idPrefix.slice(6, 8), +idPrefix.slice(8, 10), +idPrefix.slice(10, 12)),
) / 60000;
check('kernel doc id matches our local-time generator', driftMin <= 1, `drift ${driftMin} min (offset ${-new Date().getTimezoneOffset() / 60}h)`);

console.log('\n=== 3. attribute view: the exact shape v1.1 emits ===');
const avID = newID();
const viewID = newID();
const keyBlock = newID();
const keyDate = newID();
const keyNum = newID();
const keySel = newID();
const rowDetached = newID();
const localMidnight = new Date(2025, 5, 1).getTime(); // 2025-06-01 00:00 local

const av = {
    spec: 5,
    id: avID,
    name: 'Tasks',
    keyValues: [
        {
            key: { id: keyBlock, name: 'Name', type: 'block', icon: '', desc: '', numberFormat: '', template: '' },
            values: [{
                id: newID(), keyID: keyBlock, blockID: rowDetached, type: 'block',
                isDetached: true, createdAt: Date.now(), updatedAt: Date.now(),
                block: { id: '', content: 'Row one', created: Date.now(), updated: Date.now() },
            }],
        },
        {
            key: { id: keyDate, name: 'Due', type: 'date', icon: '', desc: '', numberFormat: '', template: '' },
            values: [{
                id: newID(), keyID: keyDate, blockID: rowDetached, type: 'date',
                createdAt: Date.now(), updatedAt: Date.now(),
                date: { content: localMidnight, isNotEmpty: true, hasEndDate: false, isNotTime: true, content2: 0, isNotEmpty2: false, formattedContent: '' },
            }],
        },
        {
            key: { id: keyNum, name: 'Cost', type: 'number', icon: '', desc: '', numberFormat: 'EUR', template: '' },
            values: [{
                id: newID(), keyID: keyNum, blockID: rowDetached, type: 'number',
                createdAt: Date.now(), updatedAt: Date.now(),
                number: { content: 60, isNotEmpty: true, format: 'EUR', formattedContent: '60,00 €' },
            }],
        },
        {
            key: {
                id: keySel, name: 'Status', type: 'select', icon: '', desc: '', numberFormat: '', template: '',
                options: [{ name: 'Done', color: '6', desc: '' }],
            },
            values: [{
                id: newID(), keyID: keySel, blockID: rowDetached, type: 'select',
                createdAt: Date.now(), updatedAt: Date.now(),
                mSelect: [{ content: 'Done', color: '6' }],
            }],
        },
    ],
    keyIDs: [keyBlock, keyDate, keyNum, keySel],
    viewID,
    views: [{
        id: viewID, icon: '', name: 'Table', hideAttrViewName: false, desc: '',
        filters: [{ column: '', operator: '', value: null, combination: 'and' }],
        sorts: [],
        pageSize: 50,
        type: 'table',
        table: {
            spec: 0, id: newID(), showIcon: true, wrapField: false,
            columns: [keyBlock, keyDate, keyNum, keySel].map((id) => ({ id, wrap: false, hidden: false, pin: false, width: '' })),
        },
        itemIds: [rowDetached],
        groupCreated: 0, groupItemIds: null, groupFolded: false, groupHidden: 0, groupSort: 0,
    }],
};

const form = new FormData();
form.append('path', `/data/storage/av/${avID}.json`);
form.append('isDir', 'false');
form.append('file', new Blob([JSON.stringify(av)], { type: 'application/json' }), 'data.json');
const putRes = await (await fetch(BASE + '/api/file/putFile', { method: 'POST', body: form })).json();
check('putFile av json', putRes.code === 0, putRes.msg);

const got = await api('/api/av/getAttributeView', { id: avID });
check('getAttributeView accepted our spec-5 payload', got.code === 0, got.msg);
const stored = got.data?.av;
check('av read back with all 4 fields', stored?.keyValues?.length === 4, `got ${stored?.keyValues?.length}`);
check('spec preserved as 5', stored?.spec === 5, `got ${stored?.spec}`);

const storedBlock = stored?.keyValues?.find((kv) => kv.key.type === 'block');
// Go's omitempty drops the empty string entirely, so "absent" is the correct outcome.
check('detached row carries no bound block id', !storedBlock?.values?.[0]?.block?.id, JSON.stringify(storedBlock?.values?.[0]?.block));
check('detached flag preserved', storedBlock?.values?.[0]?.isDetached === true);

const storedView = stored?.views?.[0];
check('filters live at view level', Array.isArray(storedView?.filters), JSON.stringify(storedView?.filters));
check('filter carries combination', storedView?.filters?.[0]?.combination === 'and');
check('itemIds preserved', storedView?.itemIds?.[0] === rowDetached);
check('no rawNotion* leaked into the schema', !('rawNotionFilters' in (storedView ?? {})));

console.log('\n=== 4. render: does the kernel display it correctly? ===');
const rendered = await api('/api/av/renderAttributeView', { id: avID, pageSize: 50 });
check('renderAttributeView', rendered.code === 0, rendered.msg);
const view = rendered.data?.view;
const rows = view?.rows ?? view?.items ?? [];
check('one row rendered', rows.length === 1, `got ${rows.length}`);

const flat = JSON.stringify(rendered.data);
// The real invariant: local midnight + isNotTime, which is what makes the kernel format
// it as "2025-06-01" rather than "2025-06-01 02:00".
const dateCell = (rows[0]?.cells ?? []).find((c) => c.value?.type === 'date');
check('date is local midnight', dateCell?.value?.date?.content === localMidnight,
    `${dateCell?.value?.date?.content} vs ${localMidnight}`);
check('date flagged as time-less', dateCell?.value?.date?.isNotTime === true);
check('number kept its currency formatting', flat.includes('60,00'), 'EUR format');
check('select colour preserved', flat.includes('"color":"6"'));

console.log('\n=== 5. sanity: nothing named like a conversion marker ===');
const sql = await api('/api/query/sql', { stmt: `SELECT COUNT(*) AS c FROM blocks WHERE content LIKE '%SYINLINESTYLE%' OR content LIKE '%SYFOLDFOLD%'` });
check('no conversion markers in the workspace', Number(sql.data?.[0]?.c ?? 0) === 0);

console.log(`\n${fails.length ? 'FAILED' : 'ALL PASSED'} - ${pass} checks passed, ${fails.length} failed`);
for (const f of fails) console.log('  x ' + f);
process.exit(fails.length ? 1 : 0);
