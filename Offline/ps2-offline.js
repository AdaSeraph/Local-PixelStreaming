// PixelStreaming2 离线(内网)启动器 —— VirtualCity
//
// 由 Samples/PixelStreaming2 目录下的 .bat 用便携 Offline/node/node.exe 调用:
//   start      启动信令服务器, 并按 PixelStreaming.ini 顺带启动打包好的 UE 程序
//   server     只启动信令服务器
//   stop       停止本机由这些脚本启动的信令服务器 / TURN / UE 程序
//   check      自检: 运行时文件、网卡地址、端口占用、UE 程序位置
//   firewall   添加 Windows 防火墙入站放行规则(需要管理员)
//
// 整个启动过程不访问外网: 不查询公网 IP、不下载、不编译、不连公网 STUN/TURN。
// Epic 自带的 platform_scripts/cmd/start.bat 恰恰依赖这些, 所以在内网起不来:
//   - 首次运行要下载 Node / coturn, 还要 npm install
//   - 用 curl api.ipify.org 取公网 IP; 取不到时 TURN 地址被拼成 "turn::19303",
//     浏览器直接拒绝创建 RTCPeerConnection, 画面出不来
//   - 默认下发 Google STUN
// 同一内网里浏览器和 UE 可以直接互通, ICE 服务器列表留空就能连上
// (UE 编辑器内置信令服务器下发的也是空列表)。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const OFFLINE_DIR = __dirname;
const ROOT = path.dirname(OFFLINE_DIR); // Samples/PixelStreaming2
const SWS_DIR = path.join(ROOT, 'WebServers', 'SignallingWebServer');
const WILBUR_JS = path.join(SWS_DIR, 'dist', 'index.js');
const WWW_DIR = path.join(SWS_DIR, 'www');
const INI_FILE = path.join(ROOT, 'PixelStreaming.ini');
const LOG_DIR = path.join(ROOT, 'Logs');
const STATE_FILE = path.join(OFFLINE_DIR, '.state', 'running.json');
// Stop 脚本写这个文件请求正常退出, 启动器自己收尾后窗口直接关掉
const STOP_FILE = path.join(OFFLINE_DIR, '.state', 'stop.request');
const TURN_EXE = path.join(OFFLINE_DIR, 'coturn', 'turnserver.exe');
// 网页首页: 带上悬停鼠标等默认参数跳到 player.html, 否则浏览器里点不中 UE 的 UI 按钮
const HOME_TEMPLATE = path.join(OFFLINE_DIR, 'web', 'index.html');
const HOME_PAGE = path.join(WWW_DIR, 'index.html');
const RUNTIME_INFO = path.join(OFFLINE_DIR, 'runtime-info.json');
// 打包后的布局: <包>/<项目>.exe 与 <包>/<项目>/Samples/PixelStreaming2
const PROJECT_DIR = path.resolve(ROOT, '..', '..');
const PACKAGE_DIR = path.dirname(PROJECT_DIR);
const PROJECT_NAME = path.basename(PROJECT_DIR);

// Windows 上被 Ctrl+C 结束的进程退出码 (STATUS_CONTROL_C_EXIT)
const EXIT_CTRL_C = 0xc000013a;

class UserError extends Error {}

const paint = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = paint('91');
const green = paint('92');
const yellow = paint('93');
const cyan = paint('96');

const log = (text) => console.log(`[像素流] ${text}`);
const warn = (text) => console.log(yellow(`[像素流] ${text}`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

// 记事本可能存成 UTF-8(带或不带 BOM)、UTF-16 或 GBK。
function readTextAuto(file) {
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    const utf8 = buf.toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8;
    try {
        return new TextDecoder('gbk').decode(buf);
    } catch {
        return utf8;
    }
}

function parseIni(text) {
    const values = {};
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) continue;
        const header = /^\[(.+)\]$/.exec(line);
        if (header) {
            section = header[1].trim().toLowerCase();
            continue;
        }
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        values[`${section}.${line.slice(0, eq).trim().toLowerCase()}`] = value;
    }
    return values;
}

function loadConfig() {
    const ini = fs.existsSync(INI_FILE) ? parseIni(readTextAuto(INI_FILE)) : {};
    const get = (section, key, fallback) => {
        const value = ini[`${section}.${key}`.toLowerCase()];
        return value === undefined || value === '' ? fallback : value;
    };
    const int = (section, key, fallback, min, max) => {
        const text = String(get(section, key, fallback));
        const value = Number(text);
        if (!/^\d+$/.test(text) || value < min || value > max) {
            throw new UserError(`PixelStreaming.ini 的 [${section}] ${key}=${text} 不对, 应为 ${min}-${max} 的整数。`);
        }
        return value;
    };
    const bool = (section, key, fallback) => {
        const text = String(get(section, key, fallback)).toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(text)) return true;
        if (['0', 'false', 'no', 'off'].includes(text)) return false;
        throw new UserError(`PixelStreaming.ini 的 [${section}] ${key}=${text} 不对, 应为 1 或 0。`);
    };
    const oneOf = (section, key, fallback, choices) => {
        const text = String(get(section, key, fallback)).toLowerCase();
        if (!choices.includes(text)) {
            throw new UserError(`PixelStreaming.ini 的 [${section}] ${key}=${text} 不对, 可选: ${choices.join(' / ')}。`);
        }
        return text;
    };

    const cfg = {
        signallingEnabled: bool('Signalling', 'Enabled', '1'),
        playerPort: int('Signalling', 'PlayerPort', '80', 1, 65535),
        streamerPort: int('Signalling', 'StreamerPort', '8888', 1, 65535),
        hostAddress: get('Signalling', 'HostAddress', ''),
        consoleMessages: oneOf('Signalling', 'ConsoleMessages', 'basic', ['none', 'basic', 'verbose', 'formatted']),
        maxPlayers: int('Signalling', 'MaxPlayers', '0', 0, 1000),
        launchGame: bool('Game', 'LaunchGame', '1'),
        gameExe: get('Game', 'GameExe', ''),
        signallingAddress: get('Game', 'SignallingAddress', '127.0.0.1'),
        windowMode: oneOf('Game', 'WindowMode', 'normal', ['normal', 'offscreen', 'windowed', 'fullscreen']),
        resX: int('Game', 'ResX', '1920', 0, 16384),
        resY: int('Game', 'ResY', '1080', 0, 16384),
        webrtcMinPort: int('Game', 'WebRTCMinPort', '0', 0, 65535),
        webrtcMaxPort: int('Game', 'WebRTCMaxPort', '0', 0, 65535),
        extraArgs: get('Game', 'ExtraArgs', ''),
        stopGameOnExit: bool('Game', 'StopGameOnExit', '1'),
        turnMode: oneOf('Turn', 'Mode', 'off', ['off', 'local', 'external']),
        turnServer: get('Turn', 'Server', ''),
        turnPort: int('Turn', 'Port', '3478', 1, 65535),
        turnUser: get('Turn', 'User', ''),
        turnPassword: get('Turn', 'Password', ''),
        forceRelay: bool('Turn', 'ForceRelay', '0'),
    };

    if (cfg.playerPort === cfg.streamerPort) {
        throw new UserError('PlayerPort 和 StreamerPort 不能相同。');
    }
    if (cfg.turnMode === 'local' && [cfg.playerPort, cfg.streamerPort].includes(cfg.turnPort)) {
        throw new UserError('[Turn] Port 不能和信令服务器的端口相同。');
    }
    if (Boolean(cfg.webrtcMinPort) !== Boolean(cfg.webrtcMaxPort) || cfg.webrtcMinPort > cfg.webrtcMaxPort) {
        throw new UserError('[Game] WebRTCMinPort / WebRTCMaxPort 要么都留空, 要么都填且 Min <= Max。');
    }
    if (cfg.hostAddress && !net.isIPv4(cfg.hostAddress)) {
        throw new UserError(`[Signalling] HostAddress=${cfg.hostAddress} 不是 IPv4 地址。`);
    }
    if (!/^[A-Za-z0-9.\-]+$/.test(cfg.signallingAddress)) {
        throw new UserError(`[Game] SignallingAddress=${cfg.signallingAddress} 不对, 填信令电脑的 IP, 例如 192.168.1.40。`);
    }
    return cfg;
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

const VIRTUAL_NIC =
    /vEthernet|Hyper-V|VMware|VirtualBox|VBox|Loopback|Pseudo|TAP|TUN|Wintun|WireGuard|ZeroTier|Tailscale|Docker|WSL|Npcap|Bluetooth|Clash|mihomo|Meta|VPN|Teredo|isatap|Radmin|Hamachi|Sangfor|EasyConnect/i;

function ipToInt(ip) {
    return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function inCidr(ip, base, bits) {
    const size = 2 ** (32 - bits);
    return Math.floor(ipToInt(ip) / size) === Math.floor(ipToInt(base) / size);
}

// 按"最像客户端能访问到的内网地址"排序: 普通网卡上的私有地址优先,
// 虚拟机交换机 / VPN / 代理软件 TUN(常见 198.18.0.0/15)/ 169.254 自动地址靠后。
function listIPv4() {
    const found = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const addr of ifaces[name] || []) {
            if ((addr.family !== 'IPv4' && addr.family !== 4) || addr.internal) continue;
            const ip = addr.address;
            let kind = 'lan';
            if (inCidr(ip, '169.254.0.0', 16)) kind = 'linklocal';
            else if (inCidr(ip, '198.18.0.0', 15) || inCidr(ip, '100.64.0.0', 10) || VIRTUAL_NIC.test(name)) kind = 'virtual';
            else if (!inCidr(ip, '10.0.0.0', 8) && !inCidr(ip, '172.16.0.0', 12) && !inCidr(ip, '192.168.0.0', 16)) kind = 'other';
            found.push({ name, address: ip, kind });
        }
    }
    const rank = { lan: 0, other: 1, virtual: 2, linklocal: 3 };
    return found.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

function pickHost(cfg, addresses) {
    if (cfg.hostAddress) return cfg.hostAddress;
    return addresses.length ? addresses[0].address : '127.0.0.1';
}

function httpUrl(host, port) {
    return port === 80 ? `http://${host}/` : `http://${host}:${port}/`;
}

// 与信令服务器相同的监听方式(所有网卡), 结果和它真正启动时一致。
function probePort(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => resolve(err.code || 'ERROR'));
        server.listen(port, () => server.close(() => resolve(null)));
    });
}

function tcpReachable(port, host = '127.0.0.1', timeoutMs = 800) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host });
        const done = (ok) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

function run(cmd, args, extra = {}) {
    return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...extra });
}

function imageNameOf(pid) {
    const r = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = r.stdout && /^"([^"]+)","(\d+)"/m.exec(r.stdout);
    return m && Number(m[2]) === pid ? m[1] : null;
}

function portOwner(port) {
    const r = run('netstat', ['-ano']);
    if (!r.stdout) return null;
    for (const line of r.stdout.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        // TCP  0.0.0.0:80  0.0.0.0:0  LISTENING  4   (状态列在中文系统上也是英文, 这里只看地址)
        if (cols.length < 5 || !/^TCP$/i.test(cols[0])) continue;
        if (!cols[1].endsWith(`:${port}`) || !/:0$/.test(cols[2])) continue;
        const pid = Number(cols[cols.length - 1]);
        if (pid >= 0) return { pid, image: pid === 0 ? '?' : imageNameOf(pid) || '?' };
    }
    return null;
}

function describePortProblem(port, code, label) {
    if (code === 'EADDRINUSE') {
        const owner = portOwner(port);
        let who = owner ? `, 占用者: ${owner.image} (PID ${owner.pid})` : '';
        if (owner && owner.pid === 4) who += ' —— 通常是 IIS / Web 部署 / SQL Server Reporting 等系统 HTTP 服务';
        return `${label} 端口 ${port} 已被占用${who}。`;
    }
    if (code === 'EACCES') {
        return (
            `${label} 端口 ${port} 被 Windows 保留(Hyper-V / WinNAT 动态排除端口)。` +
            '查看保留范围: netsh int ipv4 show excludedportrange protocol=tcp'
        );
    }
    return `${label} 端口 ${port} 无法监听: ${code}`;
}

// ---------------------------------------------------------------------------
// 进程 / 状态
// ---------------------------------------------------------------------------

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function writeState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        warn(`写不了状态文件(不影响运行, 只是 Stop 脚本找不到进程): ${err.message}`);
    }
}

function removeFile(file) {
    try {
        fs.unlinkSync(file);
    } catch {
        // 已经没有了
    }
}

function clearState() {
    removeFile(STATE_FILE);
}

function isRunningAs(pid, image) {
    if (!pid) return false;
    const name = imageNameOf(pid);
    return Boolean(name) && name.toLowerCase() === image.toLowerCase();
}

function killTree(pid) {
    if (pid) run('taskkill', ['/PID', String(pid), '/T', '/F']);
}

function killImage(image) {
    return run('taskkill', ['/IM', image, '/T', '/F']).status === 0;
}

function isImageRunning(image) {
    const r = run('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
    return Boolean(r.stdout) && r.stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
}

// 同一台电脑上同时跑两个 UE 会用同一个推流 ID 抢同一个信令, 已经在跑就不再启动
function runningGameImage() {
    return gameImageNames().find(isImageRunning) || null;
}

// 启动打包好的 UE(引导程序 <项目>.exe 会带着参数启动 Binaries 里真正的程序)
function launchGame(cfg, exe, state) {
    const args = buildGameArgs(cfg);
    log(`启动 UE: ${exe} ${args.join(' ')}`);
    const game = spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
    game.on('error', (err) => warn(`UE 程序启动失败: ${err.message}`));
    game.unref();
    state.gamePid = game.pid;
    state.gameImage = path.basename(exe);
    state.gameImages = [...new Set([path.basename(exe), ...gameImageNames()])];
    return game;
}

function gameBinaries() {
    const dir = path.join(PROJECT_DIR, 'Binaries', 'Win64');
    try {
        return fs
            .readdirSync(dir)
            .filter((f) => /\.exe$/i.test(f))
            .map((f) => path.join(dir, f));
    } catch {
        return [];
    }
}

// UE 的进程名: 包根目录的引导程序(<项目>.exe)和 Binaries/Win64 里真正干活的程序。
// 不显示窗口时, 停止只能靠按进程名结束。
function gameImageNames() {
    const names = gameBinaries().map((f) => path.basename(f));
    if (names.length && fs.existsSync(path.join(PACKAGE_DIR, `${PROJECT_NAME}.exe`))) names.push(`${PROJECT_NAME}.exe`);
    return [...new Set(names)];
}

function resolveGameExe(cfg) {
    if (cfg.gameExe) {
        const exe = path.isAbsolute(cfg.gameExe) ? cfg.gameExe : path.resolve(ROOT, cfg.gameExe);
        if (!fs.existsSync(exe)) throw new UserError(`[Game] GameExe 指向的文件不存在: ${exe}`);
        return exe;
    }
    const bootstrap = path.join(PACKAGE_DIR, `${PROJECT_NAME}.exe`);
    return fs.existsSync(bootstrap) && gameBinaries().length ? bootstrap : null;
}

// 按 Windows 命令行规则(CommandLineToArgvW)拆分, 效果和直接写在命令行里一样:
// 双引号包住带空格的部分, \" 表示引号本身
function splitArgs(text) {
    const out = [];
    let current = '';
    let inQuotes = false;
    let hasToken = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\\' && text[i + 1] === '"') {
            current += '"';
            i++;
            hasToken = true;
        } else if (c === '"') {
            inQuotes = !inQuotes;
            hasToken = true;
        } else if (/\s/.test(c) && !inQuotes) {
            if (hasToken) out.push(current);
            current = '';
            hasToken = false;
        } else {
            current += c;
            hasToken = true;
        }
    }
    if (hasToken) out.push(current);
    return out;
}

function signallingUrlForGame(cfg) {
    return `ws://${cfg.signallingEnabled ? '127.0.0.1' : cfg.signallingAddress}:${cfg.streamerPort}`;
}

function buildGameArgs(cfg) {
    const args = [`-PixelStreamingURL=${signallingUrlForGame(cfg)}`];
    const res = cfg.resX && cfg.resY ? [`-ResX=${cfg.resX}`, `-ResY=${cfg.resY}`] : [];
    // normal: 不加任何窗口 / 分辨率参数, 程序和平时双击运行时完全一样, 推流画面就是本机屏幕上的画面
    if (cfg.windowMode === 'offscreen') args.push('-RenderOffscreen', ...res, ...(res.length ? ['-ForceRes'] : []));
    else if (cfg.windowMode === 'windowed') args.push('-Windowed', ...res);
    else if (cfg.windowMode === 'fullscreen') args.push('-FullScreen', ...res);
    if (cfg.webrtcMinPort) {
        args.push(`-PixelStreamingWebRTCMinPort=${cfg.webrtcMinPort}`, `-PixelStreamingWebRTCMaxPort=${cfg.webrtcMaxPort}`);
    }
    // ExtraArgs 里写 -httpproxy="" 拆分后引号没了, 同样要补回去
    const extra = splitArgs(cfg.extraArgs).map((a) => (/^-httpproxy=$/i.test(a) ? '-httpproxy=""' : a));
    // UE 启动时读取 Windows 系统代理(Internet 选项里的代理), 它的 WebSocket 会把所有连接
    // 都发给这个代理, 不看"例外"列表。开着 VPN/代理软件(系统代理模式), 或单位用组策略
    // 下发了代理的电脑上, UE 因此连不上本机 ws://127.0.0.1 的信令服务器, 也不报具体原因。
    // 空的代理地址让 UE 直连。整个参数带引号交给 UE: 它按 CommandLineToArgvW 重建命令行,
    // -httpproxy= 后面没有引号时会把下一个参数当成代理地址。
    // 确实需要代理时在 ExtraArgs 里写 -httpproxy=地址:端口。
    if (!extra.some((a) => /^-httpproxy=/i.test(a))) args.push('-httpproxy=""');
    return args.concat(extra);
}

// ---------------------------------------------------------------------------
// ICE / TURN
// ---------------------------------------------------------------------------

function buildTurn(cfg, host) {
    if (cfg.turnMode === 'off') return null;
    if (cfg.turnMode === 'local') {
        if (!fs.existsSync(TURN_EXE)) {
            throw new UserError(
                '[Turn] Mode=local 需要 Offline\\coturn\\turnserver.exe, 但这个运行时里没有。\n' +
                    '在有网的开发机重新运行 Offline\\Prepare-OfflineRuntime.bat(不要加 -NoTurn), 或把 Mode 改回 off。'
            );
        }
        return {
            local: true,
            host,
            port: cfg.turnPort,
            user: cfg.turnUser || 'ps2',
            // 没配置密码就每次启动随机生成一个, 通过信令下发给浏览器和 UE, 不需要写死在文件里
            password: cfg.turnPassword || crypto.randomBytes(12).toString('hex'),
            urls: [`turn:${host}:${cfg.turnPort}?transport=udp`, `turn:${host}:${cfg.turnPort}?transport=tcp`],
        };
    }
    if (!cfg.turnServer || !cfg.turnUser || !cfg.turnPassword) {
        throw new UserError('[Turn] Mode=external 需要同时填写 Server、User、Password(找网管要内网 TURN 服务器的地址和账号)。');
    }
    const urls = cfg.turnServer
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .flatMap((s) => (/^turns?:/i.test(s) ? [s] : [`turn:${s}?transport=udp`, `turn:${s}?transport=tcp`]));
    return { local: false, user: cfg.turnUser, password: cfg.turnPassword, urls };
}

function buildPeerOptions(cfg, turn) {
    const options = { iceServers: [] };
    if (turn) options.iceServers.push({ urls: turn.urls, username: turn.user, credential: turn.password });
    if (turn && cfg.forceRelay) options.iceTransportPolicy = 'relay';
    return options;
}

// coturn 是 Cygwin 编译的, 路径里有中文时它打不开用参数指定的日志/pid 文件,
// 但能写当前目录。所以把工作目录设成 Logs, 让它把 turn.log / turnserver.pid
// 写在当前目录(它找不到 /var/log 时的默认行为)。
function startTurnServer(turn) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    removeFile(path.join(LOG_DIR, 'turn.log'));
    const args = [
        '-n', // 不读配置文件
        '--listening-ip', turn.host,
        '--relay-ip', turn.host,
        '--listening-port', String(turn.port),
        '--realm', 'PixelStreaming',
        '--lt-cred-mech',
        '--fingerprint',
        '--user', `${turn.user}:${turn.password}`,
        `--allowed-peer-ip=${turn.host}`,
        '--no-cli', '--no-tls', '--no-dtls',
        '--simple-log',
        '--no-stdout-log',
    ];
    return spawn(TURN_EXE, args, { cwd: LOG_DIR, stdio: 'ignore', windowsHide: true });
}

// ---------------------------------------------------------------------------
// 信令服务器(Epic 的 Wilbur), 意外退出时自动重启
// ---------------------------------------------------------------------------

class SignallingServer {
    constructor(cfg, peerOptions) {
        this.args = [
            WILBUR_JS,
            '--no_config', // 不读 config.json: Epic 自带的那份把网页目录写死成 D:\PixelStreamingInfrastructure\...
            '--serve',
            '--http_root', WWW_DIR,
            '--homepage', 'player.html',
            '--player_port', String(cfg.playerPort),
            '--streamer_port', String(cfg.streamerPort),
            '--sfu_port', '', // 空 = 不开 SFU 端口
            '--max_players', String(cfg.maxPlayers),
            '--log_folder', path.join(LOG_DIR, 'signalling'),
            '--log_level_console', 'info',
            '--log_level_file', 'info',
            '--peer_options', JSON.stringify(peerOptions),
        ];
        if (cfg.consoleMessages !== 'none') this.args.push('--console_messages', cfg.consoleMessages);
        this.child = null;
        this.stopping = false;
        this.crashes = [];
        this.onFatal = null;
    }

    start() {
        this.child = spawn(process.execPath, this.args, { cwd: SWS_DIR, stdio: 'inherit' });
        const child = this.child;
        child.on('exit', (code) => {
            if (this.child !== child) return;
            this.child = null;
            // Ctrl+C / 关窗口时子进程会和我们一起收到信号, 给主进程的处理留点时间
            setTimeout(() => this.handleExit(code), 500);
        });
        child.on('error', (err) => warn(`信令服务器进程出错: ${err.message}`));
        return this;
    }

    handleExit(code) {
        if (this.stopping || code === EXIT_CTRL_C) return;
        const now = Date.now();
        this.crashes = this.crashes.filter((t) => now - t < 60000).concat(now);
        if (this.crashes.length > 5) {
            if (this.onFatal) this.onFatal('信令服务器 1 分钟内反复退出, 已停止重启。请查看上面的错误信息和 Logs\\signalling。');
            return;
        }
        warn(`信令服务器意外退出(退出码 ${code}), 3 秒后自动重启...`);
        setTimeout(() => {
            if (!this.stopping) this.start();
        }, 3000);
    }

    get pid() {
        return this.child ? this.child.pid : null;
    }

    stop() {
        this.stopping = true;
        if (this.child) killTree(this.child.pid);
    }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

function checkRuntime() {
    const missing = [WILBUR_JS, path.join(SWS_DIR, 'node_modules', 'express', 'package.json'), path.join(WWW_DIR, 'player.html')].filter(
        (f) => !fs.existsSync(f)
    );
    if (missing.length) {
        throw new UserError(
            `离线运行时不完整, 缺少:\n  ${missing.join('\n  ')}\n` +
                '在能上网的开发机运行一次 Offline\\Prepare-OfflineRuntime.bat, 然后把整个 PixelStreaming2 目录重新拷过来。'
        );
    }
}

// www 属于 Epic 的服务器文件, 重新下载服务器会被整个换掉, 所以每次启动都从模板同步一次首页
function ensureHomepage() {
    try {
        const want = fs.readFileSync(HOME_TEMPLATE);
        if (!fs.existsSync(HOME_PAGE) || !fs.readFileSync(HOME_PAGE).equals(want)) {
            fs.writeFileSync(HOME_PAGE, want);
            log('已更新网页首页 www\\index.html(默认悬停鼠标、触摸当鼠标)');
        }
        return true;
    } catch (err) {
        warn(`没能写入网页首页 ${HOME_PAGE}: ${err.message}`);
        warn('浏览器里需要手动打开设置(齿轮), 把 Control Scheme 切成 Hovering Mouse, 否则点不中 UE 的按钮。');
        return false;
    }
}

function runtimeSummary() {
    try {
        const info = JSON.parse(fs.readFileSync(RUNTIME_INFO, 'utf8'));
        return `Node ${process.version}, 信令服务器 ${info.wilburVersion}, PS 基础设施 ${info.psInfraVersion}, 准备于 ${info.preparedAt}`;
    } catch {
        return `Node ${process.version}`;
    }
}

// 端口被占用时, 先看是不是自己已经在跑(状态文件里的启动器还活着), 给出更直白的提示
function runningLauncherPid() {
    const state = readState();
    return state && isRunningAs(state.launcherPid, path.basename(process.execPath)) ? state.launcherPid : null;
}

async function ensurePortsFree(cfg, turn) {
    const checks = [
        [cfg.playerPort, '网页/播放器(PlayerPort)'],
        [cfg.streamerPort, 'UE 连接(StreamerPort)'],
    ];
    if (turn && turn.local) checks.push([turn.port, 'TURN(Port)']);
    const problems = [];
    for (const [port, label] of checks) {
        const code = await probePort(port);
        if (code) problems.push(describePortProblem(port, code, label));
    }
    if (problems.length) {
        const pid = runningLauncherPid();
        if (pid) throw new UserError(`像素流已经在运行(启动器 PID ${pid})。要重启请先运行 Stop-PixelStreaming.bat。`);
        throw new UserError(`${problems.join('\n')}\n请在 PixelStreaming.ini 里换一个端口(UE 的连接地址会自动跟着改)。`);
    }
}

async function waitUntilListening(ports, timeoutMs, isDead) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isDead()) return false;
        const results = await Promise.all(ports.map((p) => tcpReachable(p)));
        if (results.every(Boolean)) return true;
        await sleep(300);
    }
    return false;
}

function gameModeText(cfg) {
    switch (cfg.windowMode) {
        case 'offscreen':
            return '不显示窗口, 只推流';
        case 'windowed':
            return '窗口模式, 本机屏幕与网页画面同步';
        case 'fullscreen':
            return '全屏, 本机屏幕与网页画面同步';
        default:
            return '和平时一样正常显示, 本机屏幕与网页画面同步 (不要最小化 UE 窗口, 否则网页画面会停住)';
    }
}

function printBanner(cfg, host, addresses, gameInfo, turn) {
    const line = '='.repeat(66);
    const lanOthers = addresses.filter((a) => a.address !== host && a.kind === 'lan');
    const virtuals = addresses.filter((a) => a.address !== host && a.kind !== 'lan');
    console.log('');
    console.log(green(line));
    console.log(green('  像素流 PixelStreaming2 已启动 —— 内网离线模式'));
    console.log(green(line));
    console.log(`  其他电脑 / Pad 浏览器打开 : ${cyan(httpUrl(host, cfg.playerPort))}`);
    for (const a of lanOthers) console.log(`                      或者 : ${httpUrl(a.address, cfg.playerPort)}  (${a.name})`);
    console.log(`  本机测试                 : ${httpUrl('127.0.0.1', cfg.playerPort)}`);
    console.log(`  UE 连接信令              : ws://127.0.0.1:${cfg.streamerPort}   (UE 在别的电脑时: ws://${host}:${cfg.streamerPort})`);
    if (!turn) console.log('  媒体连接                 : 内网直连, 不用外网 / VPN / 公网 IP / STUN');
    else if (turn.local) console.log(`  媒体连接                 : 本机 TURN 中继 ${host}:${turn.port}${cfg.forceRelay ? ' (强制中继)' : ''}`);
    else console.log(`  媒体连接                 : 内网 TURN ${turn.urls.join(', ')}${cfg.forceRelay ? ' (强制中继)' : ''}`);
    if (gameInfo) console.log(`  UE 程序                  : ${gameInfo}`);
    console.log('  网页里操作               : 鼠标直接点 UE 里的按钮; Pad 上单指点按 = 鼠标点击');
    if (virtuals.length) {
        console.log(`  其他网卡(一般用不上)     : ${virtuals.map((a) => `${a.address} ${a.name}`).join(';  ')}`);
    }
    console.log(green('-'.repeat(66)));
    console.log(`  关闭本窗口 = 停止像素流${gameInfo && cfg.stopGameOnExit ? '(连同 UE 程序)' : ''}`);
    console.log('  其他电脑打不开网页 -> 在本机右键 Open-Firewall.bat 以管理员身份运行一次');
    console.log('  网页打开了但没画面 -> 看 README-Intranet.txt 的排查步骤');
    console.log(`  日志: ${LOG_DIR}`);
    console.log(green(line));
    console.log('');
}

// [Signalling] Enabled=0: 信令服务器在另一台电脑上, 本机只启动 UE 并连过去
async function startGameOnly(cfg, withGame) {
    if (!withGame || !cfg.launchGame) {
        throw new UserError('PixelStreaming.ini 里 [Signalling] Enabled=0, 又不启动 UE, 没有可启动的东西。');
    }
    const exe = resolveGameExe(cfg);
    if (!exe) throw new UserError('没找到打包好的 UE 程序, 请在 PixelStreaming.ini 的 [Game] GameExe 里填路径。');
    const already = runningGameImage();
    if (already) throw new UserError(`UE 程序已经在运行(${already})。要重启请先运行 Stop-PixelStreaming.bat。`);
    const url = signallingUrlForGame(cfg);
    if (!(await tcpReachable(cfg.streamerPort, cfg.signallingAddress, 3000))) {
        warn(`现在连不上信令服务器 ${cfg.signallingAddress}:${cfg.streamerPort}(没启动 / 地址不对 / 防火墙拦了)。`);
        warn('UE 会自动重试, 信令服务器启动后就能连上。');
    }
    const state = { launcherPid: null, startedAt: new Date().toISOString() };
    launchGame(cfg, exe, state);
    writeState(state);
    await sleep(1500); // 让启动失败的报错有机会先打印出来
    console.log('');
    console.log(green(`UE 已启动, 连接信令服务器 ${url}`));
    console.log(`浏览器打开信令电脑窗口里显示的地址即可。停止 UE: Stop-PixelStreaming.bat`);
}

async function cmdStart(withGame) {
    console.log(cyan(`PixelStreaming2 离线启动器 | ${runtimeSummary()}`));
    const cfg = loadConfig();
    if (!cfg.signallingEnabled) return startGameOnly(cfg, withGame);
    checkRuntime();
    const addresses = listIPv4();
    const host = pickHost(cfg, addresses);
    const turn = buildTurn(cfg, host);
    // 能出错的检查都放在启动任何进程之前, 免得报错退出时留下没人管的子进程
    const gameExe = withGame && cfg.launchGame ? resolveGameExe(cfg) : null;
    await ensurePortsFree(cfg, turn);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    removeFile(STOP_FILE);
    ensureHomepage();

    const state = { launcherPid: process.pid, startedAt: new Date().toISOString() };
    let turnProc = null;
    let gamePid = null;
    let gameImages = [];
    let shuttingDown = false;
    const server = new SignallingServer(cfg, buildPeerOptions(cfg, turn));

    const shutdown = (code, reason) => {
        if (shuttingDown) return;
        shuttingDown = true;
        if (reason) log(reason);
        if (gamePid && cfg.stopGameOnExit) {
            killTree(gamePid);
            gameImages.forEach(killImage);
        }
        server.stop();
        if (turnProc) killTree(turnProc.pid);
        clearState();
        process.exit(code);
    };
    process.on('SIGINT', () => shutdown(0, '收到 Ctrl+C, 正在停止...'));
    process.on('SIGBREAK', () => shutdown(0, '正在停止...'));
    process.on('SIGHUP', () => shutdown(0, '窗口关闭, 正在停止...'));
    process.on('uncaughtException', (err) => shutdown(1, red(`启动器出错: ${err && err.stack ? err.stack : err}`)));
    server.onFatal = (message) => shutdown(1, red(message));

    if (turn && turn.local) {
        turnProc = startTurnServer(turn);
        turnProc.on('exit', (code) => {
            if (!shuttingDown) warn(`TURN 服务器退出了(退出码 ${code}), 详见 Logs\\turn.log`);
        });
        state.turnPid = turnProc.pid;
    }

    log(`启动信令服务器: 网页端口 ${cfg.playerPort}, UE 端口 ${cfg.streamerPort}`);
    server.start();
    state.serverPid = server.pid;
    writeState(state);
    const up = await waitUntilListening([cfg.playerPort, cfg.streamerPort], 20000, () => !server.child);
    if (!up) {
        shutdown(1, red('信令服务器没能启动, 看上面的错误信息。'));
        return;
    }

    let gameInfo = null;
    if (withGame && cfg.launchGame) {
        const already = gameExe && runningGameImage();
        if (!gameExe) {
            gameInfo = yellow('没找到打包好的 UE 程序, 本次只启动了信令服务器');
        } else if (already) {
            gameInfo = yellow(`${already} 已经在运行, 没有再启动一个(它连的若是本机 ${cfg.streamerPort} 端口, 会自动连上)`);
        } else {
            gamePid = launchGame(cfg, gameExe, state).pid;
            gameImages = state.gameImages;
            gameInfo = `已启动 ${path.basename(gameExe)}, ${gameModeText(cfg)}, 加载完成后自动连上信令`;
        }
    } else if (withGame) {
        gameInfo = '按设置不自动启动 (LaunchGame=0)';
    }

    writeState(state);
    process.title = `像素流 PixelStreaming2 - ${httpUrl(host, cfg.playerPort)} - 关闭窗口即停止`;
    printBanner(cfg, host, addresses, gameInfo, turn);

    setInterval(() => {
        if (shuttingDown) return;
        if (fs.existsSync(STOP_FILE)) {
            removeFile(STOP_FILE);
            shutdown(0, '收到 Stop-PixelStreaming.bat 的停止请求, 正在停止...');
            return;
        }
        // 状态文件记录的是当前的信令进程, 自动重启后要更新
        if (server.pid && server.pid !== state.serverPid) {
            state.serverPid = server.pid;
            writeState(state);
        }
    }, 1000);
}

async function cmdStop() {
    const state = readState();
    const stopped = [];
    const node = path.basename(process.execPath);
    // 先请启动器自己收尾(它会按设置结束 UE、TURN、信令服务器, 窗口随之关闭), 等不到再强制结束
    if (state && isRunningAs(state.launcherPid, node)) {
        try {
            fs.writeFileSync(STOP_FILE, String(Date.now()));
            for (let i = 0; i < 30 && isRunningAs(state.launcherPid, node); i++) await sleep(300);
        } catch {
            // 写不了请求文件就直接走强制结束
        }
        if (!isRunningAs(state.launcherPid, node)) stopped.push('像素流启动器(已正常退出)');
    }
    removeFile(STOP_FILE);
    if (state) {
        if (isRunningAs(state.gamePid, state.gameImage || '')) {
            killTree(state.gamePid);
            stopped.push(`UE 程序 (PID ${state.gamePid})`);
        }
        if (isRunningAs(state.turnPid, 'turnserver.exe')) {
            killTree(state.turnPid);
            stopped.push('TURN 服务器');
        }
        if (isRunningAs(state.serverPid, node)) {
            killTree(state.serverPid);
            stopped.push('信令服务器');
        }
        if (isRunningAs(state.launcherPid, node)) {
            killTree(state.launcherPid);
            stopped.push('启动器');
        }
    }
    // UE 不显示窗口时只能靠这里停, 所以状态文件丢了也按程序名再找一遍
    const images = new Set([...((state && state.gameImages) || []), ...gameImageNames()]);
    for (const image of images) {
        if (killImage(image)) stopped.push(image);
    }
    clearState();
    log(stopped.length ? `已停止: ${stopped.join(', ')}` : '没有发现在运行的像素流进程。');
}

async function cmdCheck() {
    let ok = true;
    const bad = (text) => {
        ok = false;
        console.log(red(`  [X] ${text}`));
    };
    const good = (text) => console.log(green(`  [OK] ${text}`));
    const note = (text) => console.log(`       ${text}`);

    console.log(cyan('PixelStreaming2 离线运行时自检'));
    console.log(`  目录: ${ROOT}`);
    console.log(`  ${runtimeSummary()}`);
    try {
        checkRuntime();
        good('信令服务器、依赖、网页文件齐全');
        let homeOk = false;
        try {
            homeOk = fs.readFileSync(HOME_PAGE).equals(fs.readFileSync(HOME_TEMPLATE));
        } catch {
            homeOk = false;
        }
        if (homeOk) good('网页首页 index.html 已就位(默认悬停鼠标, UE 按钮可以点)');
        else note('网页首页 index.html 缺失或不是最新, 下次启动时会自动补上');
    } catch (err) {
        bad(err.message);
    }

    let cfg = null;
    try {
        cfg = loadConfig();
        good(`PixelStreaming.ini 可以读取 (网页端口 ${cfg.playerPort}, UE 端口 ${cfg.streamerPort}, TURN ${cfg.turnMode})`);
    } catch (err) {
        bad(err.message);
    }

    const addresses = listIPv4();
    if (!addresses.length) bad('没有找到任何 IPv4 网卡地址');
    for (const a of addresses) {
        note(`网卡 ${a.name}: ${a.address}${a.kind === 'lan' ? '' : `  (${{ virtual: '虚拟/VPN', linklocal: '未获取到地址', other: '非私有地址' }[a.kind]})`}`);
    }

    if (cfg) {
        const state = readState();
        const running = state && isRunningAs(state.launcherPid, path.basename(process.execPath));
        if (running) {
            good(`像素流正在运行 (启动器 PID ${state.launcherPid}), 跳过端口检查`);
            for (const port of [cfg.playerPort, cfg.streamerPort]) {
                if (await tcpReachable(port)) good(`端口 ${port} 正在监听`);
                else bad(`端口 ${port} 没有在监听`);
            }
        } else {
            for (const [port, label] of [
                [cfg.playerPort, '网页/播放器(PlayerPort)'],
                [cfg.streamerPort, 'UE 连接(StreamerPort)'],
            ]) {
                const code = await probePort(port);
                if (code) bad(describePortProblem(port, code, label));
                else good(`${label} 端口 ${port} 可用`);
            }
        }
        try {
            const exe = resolveGameExe(cfg);
            if (exe) good(`UE 程序: ${exe}`);
            else note('没找到打包好的 UE 程序(在工程目录里运行时是正常的)');
        } catch (err) {
            bad(err.message);
        }
        if (cfg.turnMode === 'local' && !fs.existsSync(TURN_EXE)) bad('[Turn] Mode=local 但没有 Offline\\coturn\\turnserver.exe');
    }
    console.log('');
    console.log(ok ? green('自检通过。') : red('自检发现问题, 见上面标 [X] 的项。'));
    process.exitCode = ok ? 0 : 1;
}

function isElevated() {
    const r = run('whoami', ['/groups']);
    return r.status === 0 && /S-1-16-12288|S-1-16-16384/.test(r.stdout || '');
}

function cmdFirewall() {
    if (!isElevated()) {
        throw new UserError('需要管理员权限: 右键 Open-Firewall.bat, 选"以管理员身份运行"。');
    }
    const cfg = loadConfig();
    const tag = 'VirtualCity PixelStreaming2';
    const range = cfg.webrtcMinPort ? `${cfg.webrtcMinPort}-${cfg.webrtcMaxPort}` : '';
    const rules = [{ name: `${tag} - Signalling`, program: process.execPath, protocol: 'TCP', ports: `${cfg.playerPort},${cfg.streamerPort}` }];
    for (const exe of gameBinaries()) {
        rules.push({ name: `${tag} - ${path.basename(exe)} UDP`, program: exe, protocol: 'UDP', ports: range });
        rules.push({ name: `${tag} - ${path.basename(exe)} TCP`, program: exe, protocol: 'TCP', ports: range });
    }
    if (fs.existsSync(TURN_EXE)) {
        rules.push({ name: `${tag} - TURN UDP`, program: TURN_EXE, protocol: 'UDP', ports: String(cfg.turnPort) });
        rules.push({ name: `${tag} - TURN TCP`, program: TURN_EXE, protocol: 'TCP', ports: String(cfg.turnPort) });
    }
    // 参数自己加引号, 按原样交给 netsh (路径里可能有空格)
    const netsh = (args) => run('netsh', args, { windowsVerbatimArguments: true });
    let failed = 0;
    for (const r of rules) {
        netsh(['advfirewall', 'firewall', 'delete', 'rule', `name="${r.name}"`]);
        const args = ['advfirewall', 'firewall', 'add', 'rule', `name="${r.name}"`, 'dir=in', 'action=allow',
            `program="${r.program}"`, `protocol=${r.protocol}`, 'profile=any', 'enable=yes'];
        if (r.ports) args.push(`localport=${r.ports}`);
        const res = netsh(args);
        if (res.status === 0) {
            console.log(green(`  [OK] ${r.name}${r.ports ? ` (${r.protocol} ${r.ports})` : ` (${r.protocol})`}`));
        } else {
            failed++;
            console.log(red(`  [X] ${r.name}: ${(res.stdout || res.stderr || '').trim()}`));
        }
    }
    if (!gameBinaries().length) warn('这里不是打包目录, 没有为 UE 程序加规则。在打包目录里的同名脚本上再运行一次。');
    console.log('');
    console.log('如果单位用组策略统一管理防火墙, 本机规则可能不生效, 需要网管放行上述程序和端口。');
    process.exitCode = failed ? 1 : 0;
}

function usage() {
    console.log('用法: node ps2-offline.js <start|server|stop|check|firewall>');
    console.log('  start     启动信令服务器 + UE 程序 (Start-PixelStreaming.bat)');
    console.log('  server    只启动信令服务器 (Start-SignallingServer.bat)');
    console.log('  stop      停止 (Stop-PixelStreaming.bat)');
    console.log('  check     自检 (Check-PixelStreaming.bat)');
    console.log('  firewall  添加防火墙放行规则, 需要管理员 (Open-Firewall.bat)');
    console.log(`设置文件: ${INI_FILE}`);
}

async function main() {
    const command = (process.argv[2] || 'start').toLowerCase();
    switch (command) {
        case 'start':
            return cmdStart(true);
        case 'server':
            return cmdStart(false);
        case 'stop':
            return cmdStop();
        case 'check':
            return cmdCheck();
        case 'firewall':
            return cmdFirewall();
        default:
            usage();
            process.exitCode = command === 'help' || command === '--help' ? 0 : 2;
    }
}

main().catch((err) => {
    if (err instanceof UserError) {
        console.log(red(`[像素流] ${err.message}`));
    } else {
        console.log(red(`[像素流] 出错了: ${err && err.stack ? err.stack : err}`));
    }
    process.exit(1);
});
