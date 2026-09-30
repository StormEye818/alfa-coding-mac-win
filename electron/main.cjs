/**
 * AlfaProxi 桌面版主进程（单进程即装即用）——CommonJS
 * （Electron 33 的 ESM 主进程 import 'electron' 有互操作 bug，故用 CJS）
 *
 *   1) 内嵌串口/TCP 桥（bridge/server.js，ws://127.0.0.1:8850）
 *   2) 内嵌静态文件服务（127.0.0.1:8848，提供 app/ 与 src/）
 *   3) 打开界面窗口（http://127.0.0.1:8848/app/）
 *
 * 与开发模式（python3 -m http.server + node bridge/server.js）共用同一套前端
 * 与协议层，界面代码零分叉。
 */
const { app, BrowserWindow, shell, dialog } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : path.join(__dirname, '..');
const HTTP_PORT = Number(process.env.ALFAPROXI_HTTP_PORT || 8848);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** 静态服务：只允许访问 app/ 与 src/ 下的文件。
 *  端口被占（如开发时的 http.server）自动向后试 8848-8858，不让应用死在端口冲突上。 */
function startHttpServer() {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      let rel = urlPath.replace(/^\/+/, '');
      if (rel === '' || rel === 'app' || rel === 'app/') rel = 'app/index.html';
      const full = path.normalize(path.join(ROOT, rel));
      if (!full.startsWith(ROOT)) {
        res.writeHead(403); return res.end('forbidden');
      }
      if (!rel.startsWith('app/') && !rel.startsWith('src/')) {
        res.writeHead(404); return res.end('not found');
      }
      const data = fs.readFileSync(full);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404); return res.end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    let port = HTTP_PORT;
    const tryPort = () => server.listen(port, '127.0.0.1');
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && port < HTTP_PORT + 10) {
        port += 1;
        console.log(`[alfaproxi] 端口 ${port - 1} 被占，改用 ${port}`);
        tryPort();                       // 重试必须继续走 'listening' 解析（勿直接挂回调）
      } else reject(e);
    });
    server.once('listening', () => resolve({ server, port }));
    tryPort();
  });
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'AlfaProxi',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${port}/app/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  app.whenReady().then(async () => {
    // 1) 串口桥（内嵌，ESM 动态加载）：失败不阻塞界面，连接时会再报错
    //    注意：绝不能用 showErrorBox（同步阻塞，会卡死启动）——用异步 showMessageBox
    try {
      await import(pathToFileURL(path.join(ROOT, 'bridge', 'server.js')).href);
      console.log('[alfaproxi] 串口桥已内嵌启动');
    } catch (e) {
      console.error('[alfaproxi] 串口桥启动失败：', e);
      dialog.showMessageBox({
        type: 'warning',
        title: '串口桥未启动',
        message: '串口桥启动失败：' + String((e && e.message) || e) +
          '\n\n将无法连接适配器（可能是端口 8850 被占用）。界面可继续使用模拟模式。',
      }).catch(() => {});
    }
    // 2) 静态服务（端口被占自动顺延）
    let port;
    try {
      ({ port } = await startHttpServer());
    } catch (e) {
      dialog.showMessageBox({
        type: 'error',
        title: '启动失败',
        message: '本地服务启动失败：' + String((e && e.message) || e) +
          '\n\n8848-8858 端口均不可用。',
      }).catch(() => {});
      return app.quit();
    }
    // 3) 界面
    createWindow(port);
  });

  app.on('window-all-closed', () => app.quit());
}
