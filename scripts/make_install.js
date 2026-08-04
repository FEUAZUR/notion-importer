import fs from 'fs';
import path from 'path';
import http from 'node:http';
import readline  from 'node:readline';


//************************************ Write you dir here ************************************

let targetDir = ''; // the target directory of the plugin, '*/data/plugin'
//********************************************************************************************

const log = (info) => console.log(`\x1B[36m%s\x1B[0m`, info);
const error = (info) => console.log(`\x1B[31m%s\x1B[0m`, info);

let POST_HEADER = {
    // "Authorization": `Token ${token}`,
    "Content-Type": "application/json",
}

async function myfetch(url, options) {
    //使用 http 模块，从而兼容那些不支持 fetch 的 nodejs 版本
    return new Promise((resolve, reject) => {
        let req = http.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                resolve({
                    ok: true,
                    status: res.statusCode,
                    json: () => JSON.parse(data)
                });
            });
        });
        req.on('error', (e) => {
            reject(e);
        });
        req.end();
    });
}

async function getSiYuanDir() {
    let url = 'http://127.0.0.1:6806/api/system/getWorkspaces';
    let conf = {};
    try {
        let response = await myfetch(url, {
            method: 'POST',
            headers: POST_HEADER
        });
        if (response.ok) {
            conf = await response.json();
        } else {
            error(`\tHTTP-Error: ${response.status}`);
            return null;
        }
    } catch (e) {
        error(`\tError: ${e}`);
        error("\tPlease make sure SiYuan is running!!!");
        return null;
    }
    return conf.data;
}

async function chooseTarget(workspaces) {
    let count = workspaces.length;
    log(`>>> Got ${count} SiYuan ${count > 1 ? 'workspaces' : 'workspace'}`)
    for (let i = 0; i < workspaces.length; i++) {
        log(`\t[${i}] ${workspaces[i].path}`);
    }

    if (count == 1) {
        return `${workspaces[0].path}/data/plugins`;
    } else {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        let index = await new Promise((resolve, reject) => {
            rl.question(`\tPlease select a workspace[0-${count-1}]: `, (answer) => {
                resolve(answer);
            });
        });
        rl.close();
        return `${workspaces[index].path}/data/plugins`;
    }
}

log('>>> Try to visit constant "targetDir" in make_install.js...')

if (targetDir === '') {
    log('>>> Constant "targetDir" is empty, try to get SiYuan directory automatically....')
    let res = await getSiYuanDir();
    
    if (res === null || res === undefined || res.length === 0) {
        error('>>> Can not get SiYuan directory automatically');

        process.exit(1);
    } else {
        targetDir = await chooseTarget(res);
    }

    log(`>>> Successfully got target directory: ${targetDir}`);
}

//Check
if (!fs.existsSync(targetDir)) {
    error(`Failed! plugin directory not exists: "${targetDir}"`);
    error(`Please set the plugin directory in scripts/make_install.js`);
    process.exit(1);
}


//check if plugin.json exists
if (!fs.existsSync('./plugin.json')) {
    //change dir to parent
    process.chdir('../');
    if (!fs.existsSync('./plugin.json')) {
        error('Failed! plugin.json not found');
        process.exit(1);
    }
}

//load plugin.json
const plugin = JSON.parse(fs.readFileSync('./plugin.json', 'utf8'));
const name = plugin?.name;
if (!name || name === '') {
    error('Failed! Please set plugin name in plugin.json');
    process.exit(1);
}

const distDir = `${process.cwd()}/dist`;
//mkdir if not exists
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir);
}

function cmpPath(path1, path2) {
    path1 = path1.replace(/\\/g, '/');
    path2 = path2.replace(/\\/g, '/');
    // sepertor at tail
    if (path1[path1.length - 1] !== '/') {
        path1 += '/';
    }
    if (path2[path2.length - 1] !== '/') {
        path2 += '/';
    }
    return path1 === path2;
}

const targetPath = `${targetDir}/${name}`;


// Synchronous on purpose: the callback version logged success immediately and the process
// could exit mid-copy, leaving a truncated index.js in the plugins directory.
function copyDirectory(srcDir, dstDir) {
    if (!fs.existsSync(dstDir)) {
        fs.mkdirSync(dstDir, { recursive: true });
        log(`Created directory ${dstDir}`);
    }

    for (const file of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const src = path.join(srcDir, file.name);
        const dst = path.join(dstDir, file.name);
        if (file.isDirectory()) {
            copyDirectory(src, dst);
        } else {
            fs.copyFileSync(src, dst);
        }
    }
}

if (!fs.existsSync(distDir)) {
    error(`Nothing to install: ${distDir} does not exist. Run "pnpm run build" first.`);
    process.exit(1);
}
// Remove first, otherwise files deleted from dist linger in the installed plugin.
if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
}
copyDirectory(distDir, targetPath);
log(`Copied ${distDir} to ${targetPath}`);


