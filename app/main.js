'use strict'
/**
 * DeepSeek Chat 便携版 —— Electron 主进程
 * 基于 deepseek-ai/chat-demo (MIT) 的前端，外壳由本地构建。
 *
 * 设计要点：
 * 1. 用自定义特权协议 app://chat 托管前端，origin 永久固定 —— IndexedDB / localStorage 不会因为
 *    换入口、换版本而丢失。这是“对话记录不丢”的根本保证。
 * 2. 数据目录固定为 exe 同级的 data\，整个文件夹拷走即可带走全部对话（真正的便携）。
 * 3. API Key 用 Windows DPAPI(safeStorage) 加密存一份，启动时注入 localStorage，用户只需填一次。
 */
const {
  app,
  BrowserWindow,
  protocol,
  ipcMain,
  Menu,
  shell,
  dialog,
  safeStorage,
  session,
  nativeTheme,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')

const APP_SCHEME = 'app'
const APP_HOST = 'chat'
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
const LS_API_KEY = 'chat-demo:api-key'
const SELFTEST = process.argv.includes('--selftest')
// 仅用于本地验证导出链路：确认页面只触发了一次下载、且不再弹自定义对话框
const TEST_DOWNLOAD = process.argv.includes('--testdownload')
// 验证侧边栏导入 / 导出按钮是否真的接到原有功能
const TEST_TRANSFER = process.argv.includes('--transfertest')
// 验证“更多”菜单在触发按钮被隐藏后不会跳到左上角
const TEST_MENU = process.argv.includes('--menutest')
let downloadSeq = 0
// 仅用于本地验证 DPAPI 写入链路：--setkey=xxx
const SETKEY_ARG = process.argv.find((arg) => arg.startsWith('--setkey='))
// 预览用：--setpref=light|dark|system 写入主题偏好后退出
const SETPREF_ARG = process.argv.find((arg) => arg.startsWith('--setpref='))
// 诊断用：启动后自动打开设置弹窗
const OPEN_SETTINGS = process.argv.includes('--opensettings')

// ---------------------------------------------------------------- 数据目录
const exeDir = path.dirname(app.getPath('exe'))
const DATA_DIR = app.isPackaged ? path.join(exeDir, 'data') : path.join(__dirname, 'devdata')

const ensureDir = (dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

// data 目录写不进去时（例如被放到只读位置）退回用户目录，保证应用仍能启动
let dataDir = DATA_DIR
if (!ensureDir(dataDir)) {
  dataDir = path.join(app.getPath('appData'), 'DeepSeek Chat', 'data')
  ensureDir(dataDir)
}
app.setPath('userData', dataDir)
app.setPath('sessionData', dataDir)

const WEB_DIR = path.join(__dirname, 'web')
const SECRET_FILE = path.join(dataDir, 'secret.dat')
const WIN_STATE_FILE = path.join(dataDir, 'window-state.json')
const LOG_FILE = path.join(dataDir, 'main.log')

const log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`
  if (SELFTEST) console.log(line)
  try {
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {
    /* 日志失败不影响使用 */
  }
}

// ---------------------------------------------------------------- 单实例
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// ---------------------------------------------------------------- 协议（必须在 ready 之前）
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true, // 关键：有真正的 origin，IndexedDB 才可用
      secure: true, // 视为安全上下文（localStorage / crypto / clipboard 等）
      supportFetchAPI: true, // 前端 fetch 可用
      stream: true,
      corsEnabled: true, // 允许跨域请求 api.deepseek.com
      allowServiceWorkers: false,
      bypassCSP: false,
    },
  },
])

// ---------------------------------------------------------------- 静态资源
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'

const readWebFile = async (rel) => {
  const rootWithSep = WEB_DIR.endsWith(path.sep) ? WEB_DIR : WEB_DIR + path.sep
  const target = path.normalize(path.join(WEB_DIR, rel))
  if (!target.startsWith(rootWithSep)) return null
  try {
    return { data: await fsp.readFile(target), type: mimeOf(target) }
  } catch {
    return null
  }
}

const handleAppScheme = async (request) => {
  const url = new URL(request.url)
  if (url.hostname !== APP_HOST) return new Response('Not Found', { status: 404 })

  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  rel = rel.replace(/^[/\\]+/, '')

  const hit = await readWebFile(rel)
  if (hit) {
    return new Response(hit.data, {
      status: 200,
      headers: { 'content-type': hit.type, 'cache-control': 'no-cache' },
    })
  }

  // 其余路径回落到 index.html（单页应用）
  const index = await readWebFile('index.html')
  if (index) {
    return new Response(index.data, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  }
  return new Response('Not Found', { status: 404 })
}

// ---------------------------------------------------------------- API Key（DPAPI）
// Electron 45 起 safeStorage 的同步接口已弃用，这里优先用异步接口，
// 并在创建窗口之前把 Key 读进缓存，供 preload 的同步 IPC 直接取用。
let cachedKey = null

const encryptionAvailable = async () => {
  try {
    if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
      return Boolean(await safeStorage.isAsyncEncryptionAvailable())
    }
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

const encryptSecret = async (value) =>
  typeof safeStorage.encryptStringAsync === 'function'
    ? safeStorage.encryptStringAsync(value)
    : safeStorage.encryptString(value)

/**
 * Electron 45 的 decryptStringAsync 解析出来是 { result: string } 包装对象
 * （同步的 decryptString 才是裸字符串），这里统一拆包。
 */
const decryptSecret = async (buffer) => {
  if (typeof safeStorage.decryptStringAsync !== 'function') {
    return safeStorage.decryptString(buffer)
  }
  const value = await safeStorage.decryptStringAsync(buffer)
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.result === 'string') return value.result
  if (value && typeof value.byteLength === 'number') return Buffer.from(value).toString('utf8')
  throw new Error('unexpected decrypt result: ' + JSON.stringify(value))
}

const loadStoredKey = async () => {
  if (cachedKey !== null) return cachedKey
  try {
    const available = await encryptionAvailable()
    log('loadStoredKey: available=' + available + ' file=' + fs.existsSync(SECRET_FILE))
    if (!available) return null
    const buffer = fs.readFileSync(SECRET_FILE)
    const value = await decryptSecret(buffer)
    log('loadStoredKey: decrypted type=' + typeof value + ' len=' + (typeof value === 'string' ? value.length : -1))
    cachedKey = typeof value === 'string' ? value : null
    return cachedKey
  } catch (error) {
    log('loadStoredKey failed: ' + String(error))
    return null
  }
}

const storeKey = async (key) => {
  try {
    if (!(await encryptionAvailable())) return
    const buffer = await encryptSecret(key)
    fs.writeFileSync(SECRET_FILE, buffer)
    cachedKey = key
    log('api key saved (encrypted)')
  } catch (error) {
    log('storeKey failed', String(error))
  }
}

ipcMain.on('ds-key:diag', (_event, payload) => {
  log('preload diag', payload)
})

// preload 在页面脚本之前同步取 Key，此时缓存已经由启动流程填好
ipcMain.on('ds-key:get', (event) => {
  event.returnValue = typeof cachedKey === 'string' ? cachedKey : ''
})

// ---------------------------------------------------------------- 窗口状态
const readWindowState = () => {
  try {
    const s = JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf8'))
    if (typeof s.width === 'number' && typeof s.height === 'number') return s
  } catch {
    /* 首次启动 */
  }
  return { width: 1180, height: 820 }
}

const saveWindowState = (win) => {
  try {
    const b = win.getNormalBounds()
    fs.writeFileSync(WIN_STATE_FILE, JSON.stringify(b))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 菜单
const buildMenu = (win) => {
  const template = [
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '数据',
      submenu: [
        {
          label: '打开数据目录',
          click: () => shell.openPath(dataDir),
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () =>
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 DeepSeek Chat',
              message: `DeepSeek Chat ${app.getVersion()}（便携版）`,
              detail:
                '前端基于开源项目 deepseek-ai/chat-demo（MIT License），本地封装。\n' +
                `数据目录：${dataDir}\n` +
                '删除整个程序文件夹即可完全卸载（对话记录一并删除）。',
            }),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------- 原生标题栏着色
// 保留 Windows 原生标题栏（拖动、双击最大化和 Win11 贴靠布局都是系统行为），
// 通过 DWM 的 DWMWA_CAPTION_COLOR / DWMWA_TEXT_COLOR 给它指定颜色，
// 这样标题栏和右上三个按钮天然是一体的，不存在“两套颜色”。
// 只有 Win11 (build 22000+) 生效；不生效时静默回退到系统配色，不影响使用。

const DWMWA_USE_IMMERSIVE_DARK_MODE = 20
const DWMWA_CAPTION_COLOR = 35
const DWMWA_TEXT_COLOR = 36

let dwmSetAttribute = null
try {
  // eslint-disable-next-line global-require
  const koffi = require('koffi')
  const dwmapi = koffi.load('dwmapi.dll')
  dwmSetAttribute = dwmapi.func(
    'int __stdcall DwmSetWindowAttribute(uint64 hwnd, uint32 attr, const void *data, uint32 size)'
  )
  log('dwmapi ready')
} catch (error) {
  log('dwmapi unavailable (标题栏将使用系统配色): ' + String(error))
}

/** "rgb(r, g, b)" / "rgba(...)" -> {r,g,b} */
const parseCssColor = (value) => {
  const match = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(String(value || ''))
  if (!match) return null
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
}

// COLORREF 是 0x00BBGGRR，内存里按 B,G,R,0 排列
const colorRef = ({ r, g, b }) => Buffer.from([b, g, r, 0])

const isDarkColor = ({ r, g, b }) => 0.299 * r + 0.587 * g + 0.114 * b < 140

/**
 * 浅色主题下把标题栏压暗一档。
 * 原因：人眼对亮部不敏感，浅色下表面色和内容色只差 4 个色阶时等于没有分层；
 * 而菜单栏是系统画的纯白、改不了，只能把标题栏往下压，才分得出
 * 「标题栏（灰） / 菜单栏（白） / 内容（白）」三段。
 */
const CAPTION_SHIFT_LIGHT = 20
const adjustCaptionColor = (rgb) => {
  if (isDarkColor(rgb)) return rgb
  const shift = (v) => Math.max(0, v - CAPTION_SHIFT_LIGHT)
  return { r: shift(rgb.r), g: shift(rgb.g), b: shift(rgb.b) }
}

// 记住最近一次的颜色，最大化/还原时重新应用
const lastCaption = { bg: null, fg: null }
let lastCaptionLog = ''

/**
 * 菜单栏的底色由 Electron 的“原生主题”决定，而原生主题默认跟随系统。
 * 应用自己的深浅色开关只改页面 CSS，不会改它 —— 于是系统是深色时，
 * 切到浅色界面就会出现一条黑色菜单栏。
 *
 * 注意：必须按“用户的偏好”而不是“当前生效的深浅色”来设置。
 * 应用判断系统深浅色靠的正是 prefers-color-scheme，如果按当前颜色强制设成
 * dark/light，等于把系统信号掐死，「跟随系统」就再也不跟随了。
 */
const syncNativeTheme = (preference) => {
  const source = preference === 'dark' || preference === 'light' ? preference : 'system'
  if (nativeTheme.themeSource !== source) {
    nativeTheme.themeSource = source
    log(`nativeTheme -> ${source} (system says dark=${nativeTheme.shouldUseDarkColors})`)
  }
}

const applyCaptionColors = (win, background, foreground) => {
  if (!win || win.isDestroyed()) return
  if (!dwmSetAttribute) return
  const bg = parseCssColor(background)
  if (!bg) return
  const captionBg = adjustCaptionColor(bg)
  const fg = parseCssColor(foreground) || (isDarkColor(bg) ? { r: 217, g: 217, b: 217 } : { r: 51, g: 51, b: 51 })
  lastCaption.bg = background
  lastCaption.fg = foreground
  try {
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0)
    const dark = Buffer.alloc(4)
    dark.writeInt32LE(isDarkColor(bg) ? 1 : 0)
    const results = [
      dwmSetAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, dark, 4),
      dwmSetAttribute(hwnd, DWMWA_CAPTION_COLOR, colorRef(captionBg), 4),
      dwmSetAttribute(hwnd, DWMWA_TEXT_COLOR, colorRef(fg), 4),
    ]
    // 焦点变化会频繁重写同一组颜色，只在颜色或返回值变化时记一笔
    const stamp = `${background}|${foreground}|${results.join(',')}`
    if (stamp !== lastCaptionLog) {
      lastCaptionLog = stamp
      log(
        `caption colors: surface=${background} caption=rgb(${captionBg.r}, ${captionBg.g}, ${captionBg.b}) ` +
          `fg=${foreground} results=${results.join(',')}`
      )
    }
  } catch (error) {
    log('applyCaptionColors failed: ' + String(error))
  }
}

// 用户在设置里改了 API Key：立刻加密另存，不再依赖定时轮询
ipcMain.on('ds-key:changed', (event, value) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  log('api key event: ' + (trimmed ? `len=${trimmed.length}` : 'empty'))
  if (!trimmed) return
  if (trimmed === cachedKey) {
    log('api key unchanged, skipped')
    return
  }
  storeKey(trimmed).then(() => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) log('api key updated from settings (' + win.getTitle() + ')')
  })
})

// 页面主题一变（含深浅色切换）就立刻上报，标题栏与菜单栏随之更新
ipcMain.on('ds-chrome:colors', (event, payload) => {
  if (payload && payload.preference) syncNativeTheme(payload.preference)
  applyCaptionColors(
    BrowserWindow.fromWebContents(event.sender),
    payload && payload.background,
    payload && payload.foreground
  )
})

/**
 * 重新应用标题栏颜色。
 * Windows 在窗口失去/重新获得焦点、还原、显示这些时刻会重绘标题栏，
 * 有时会把 DWM 设过的底色丢掉（表现为“切出去再回来变成系统色”），
 * 所以这些时机都要重新写一次；激活后稍晚还可能再重绘，补一次。
 */
const reapplyCaption = (win) => {
  if (!win || win.isDestroyed() || !lastCaption.bg) return
  applyCaptionColors(win, lastCaption.bg, lastCaption.fg)
}

/** 兜底：页面没上报时主动读一次（启动、重载、定时） */
const syncCaptionColors = async (win) => {
  if (!win || win.isDestroyed()) return
  try {
    const colors = await win.webContents.executeJavaScript(
      `(() => {
        const probe = document.createElement('div')
        probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;background:var(--dsw-specific-sidebar-fill)'
        document.body.appendChild(probe)
        const bg = getComputedStyle(probe).backgroundColor
        probe.remove()
        return {
          bg,
          fg: getComputedStyle(document.body).color,
          dark: document.body.classList.contains('dark'),
          preference: (() => {
            const saved = localStorage.getItem('chat-demo:theme-preference')
            return saved === 'light' || saved === 'dark' ? saved : 'system'
          })(),
        }
      })()`,
      true
    )
    if (colors && colors.preference) syncNativeTheme(colors.preference)
    applyCaptionColors(win, colors && colors.bg, colors && colors.fg)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 窗口
let mainWindow = null

const createWindow = () => {
  const state = readWindowState()
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 760,
    minHeight: 560,
    title: 'DeepSeek Chat',
    backgroundColor: '#151517',
    show: false,
    autoHideMenuBar: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('resize', () => saveWindowState(mainWindow))
  mainWindow.on('move', () => saveWindowState(mainWindow))
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 外链一律交给系统浏览器，避免把应用变成浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`)

  // 标题栏是原生的，这里只负责给它上色（preload 会主动上报，这里是兜底）
  mainWindow.webContents.on('did-finish-load', () => {
    syncCaptionColors(mainWindow)
  })
  mainWindow.on('maximize', () => reapplyCaption(mainWindow))
  mainWindow.on('unmaximize', () => reapplyCaption(mainWindow))

  // 焦点变化、还原、显示时 Windows 会重绘标题栏，重新写一遍颜色。
  // 激活瞬间可能被系统/Chromium 冲掉 1~2 帧，所以前 128ms 内密集补几次，
  // 之后再用 400ms / 1200ms 兜住较晚的重绘。每次都是本机 DWM 调用，开销可忽略。
  const CAPTION_REAPPLY_DELAYS = [0, 8, 16, 32, 64, 128, 400, 1200]
  for (const eventName of ['focus', 'blur', 'show', 'restore']) {
    mainWindow.on(eventName, () => {
      for (const delay of CAPTION_REAPPLY_DELAYS) {
        if (delay === 0) reapplyCaption(mainWindow)
        else setTimeout(() => reapplyCaption(mainWindow), delay)
      }
    })
  }

  buildMenu(mainWindow)

  if (SELFTEST) runSelfTest(mainWindow)
  if (OPEN_SETTINGS) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          await mainWindow.webContents.executeJavaScript(
            `(() => {
              const buttons = Array.from(document.querySelectorAll('button'))
              const target = buttons.find((b) => b.textContent.trim() === '设置')
              if (target) target.click()
              return !!target
            })()`,
            true
          )
          log('settings opened (diagnostic)')
        } catch (error) {
          log('open settings failed: ' + String(error))
        }
      }, 1800)
    })
  }
  if (SETPREF_ARG) runSetPref(mainWindow, SETPREF_ARG.slice('--setpref='.length))
  if (TEST_DOWNLOAD) runDownloadTest(mainWindow)
  if (TEST_TRANSFER) runTransferTest(mainWindow)
  if (TEST_MENU) runMenuTest(mainWindow)

  return mainWindow
}

// ---------------------------------------------------------------- 弹出菜单位置自检
const runMenuTest = (win) => {
  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const result = await win.webContents.executeJavaScript(
        `(async () => {
          const out = {}
          const buttons = Array.from(document.querySelectorAll('button[aria-label="更多"]'))
          out.buttons = buttons.length
          if (!buttons.length) return out
          const button = buttons[0]
          const anchorSpan = button.parentElement
          const action = anchorSpan.parentElement

          // 模拟“鼠标停在会话行上”：.action 此时按 CSS 显示出来
          action.style.display = 'flex'
          await new Promise((r) => setTimeout(r, 60))
          button.click()
          await new Promise((r) => setTimeout(r, 250))

          const menu = document.querySelector('[role="menu"]')
          out.menuOpened = !!menu
          if (!menu) return out
          const first = menu.getBoundingClientRect()
          out.menuBefore = { x: Math.round(first.x), y: Math.round(first.y) }
          const anchorBefore = action.getBoundingClientRect()
          out.anchorBefore = { w: Math.round(anchorBefore.width), h: Math.round(anchorBefore.height) }

          // 模拟“鼠标移进菜单”：会话行失去悬停，触发元素被隐藏
          action.style.display = 'none'
          await new Promise((r) => setTimeout(r, 300))

          const anchorAfter = action.getBoundingClientRect()
          out.anchorAfter = { w: Math.round(anchorAfter.width), h: Math.round(anchorAfter.height) }
          const second = menu.getBoundingClientRect()
          out.menuAfter = { x: Math.round(second.x), y: Math.round(second.y) }
          out.stable = Math.abs(second.x - first.x) < 2 && Math.abs(second.y - first.y) < 2

          action.style.display = ''
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
          return out
        })()`,
        true
      )
      console.log('MENU_TEST ' + JSON.stringify(result))
    } catch (error) {
      console.log('MENU_TEST_FAILED ' + String(error))
    }
    app.exit(0)
  })
}

// ---------------------------------------------------------------- 导入导出按钮自检
const runTransferTest = (win) => {
  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const result = await win.webContents.executeJavaScript(
        `(async () => {
          const out = {}
          const buttons = Array.from(document.querySelectorAll('button[aria-label]'))
          const exportButton = buttons.find((b) => b.getAttribute('aria-label') === '导出所有历史对话')
          out.exportButton = !!exportButton
          if (exportButton) exportButton.click()
          await new Promise((r) => setTimeout(r, 800))

          const input = document.querySelector('input[type=file]')
          out.fileInput = !!input
          if (input) {
            const dt = new DataTransfer()
            dt.items.add(new File(['probe'], 'probe.zip', { type: 'application/zip' }))
            input.files = dt.files
            input.dispatchEvent(new Event('change', { bubbles: true }))
          }
          await new Promise((r) => setTimeout(r, 400))
          out.confirmShown = document.body.innerText.includes('确认导入历史对话')
          const cancel = Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent.trim() === '取消'
          )
          if (cancel) cancel.click()
          await new Promise((r) => setTimeout(r, 300))
          out.confirmClosed = !document.body.innerText.includes('确认导入历史对话')
          return out
        })()`,
        true
      )
      console.log('TRANSFER_TEST ' + JSON.stringify(result))
    } catch (error) {
      console.log('TRANSFER_TEST_FAILED ' + String(error))
    }
    setTimeout(() => {
      console.log('DOWNLOAD_COUNT ' + downloadSeq)
      app.exit(0)
    }, 600)
  })
}

// ---------------------------------------------------------------- 主题预览
const runSetPref = (win, value) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      await win.webContents.executeJavaScript(
        value === 'system'
          ? `localStorage.removeItem('chat-demo:theme-preference')`
          : `localStorage.setItem('chat-demo:theme-preference', ${JSON.stringify(value)})`,
        true
      )
      console.log('SETPREF ' + value)
    } catch (error) {
      console.log('SETPREF_FAILED ' + String(error))
    }
    app.exit(0)
  })
}

// ---------------------------------------------------------------- 下载链路自检
const runDownloadTest = (win) => {
  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1500))
    try {
      await win.webContents.executeJavaScript(
        `(() => {
          const b = new Blob(['probe'], { type: 'application/zip' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(b)
          a.download = 'probe.zip'
          document.body.appendChild(a)
          a.click()
          a.remove()
          return true
        })()`,
        true
      )
      console.log('DOWNLOAD_TRIGGERED')
      setTimeout(() => {
        console.log('DOWNLOAD_COUNT ' + downloadSeq)
        app.exit(0)
      }, 900)
    } catch (error) {
      console.log('DOWNLOAD_TRIGGER_FAILED ' + String(error))
      app.exit(1)
    }
  })
}

// ---------------------------------------------------------------- 自检
const runSelfTest = (win) => {
  const done = (payload, code) => {
    console.log('SELFTEST ' + JSON.stringify(payload))
    app.exit(code ?? 0)
  }

  win.webContents.once('did-finish-load', async () => {
    // 给应用一点启动时间（打开 IndexedDB、渲染首屏）
    await new Promise((r) => setTimeout(r, 2500))
    try {
      const result = await win.webContents.executeJavaScript(
        `(async () => {
          const out = {}
          out.origin = location.origin
          out.title = document.title
          const root = document.querySelector('#root')
          out.rendered = !!(root && root.childElementCount > 0)
          try { localStorage.setItem('__probe', '1'); localStorage.removeItem('__probe'); out.localStorage = true } catch (e) { out.localStorage = String(e) }
          try { out.databases = (await indexedDB.databases()).map(d => (d.name || '?') + '@' + d.version) } catch (e) { out.databases = String(e) }
          out.previousRun = localStorage.getItem('__selftest_ts')
          out.apiKeyInjected = !!localStorage.getItem('chat-demo:api-key')
          try { out.idbStores = await new Promise((res) => { const r = indexedDB.open('chat-demo'); r.onsuccess = () => { const db = r.result; const s = Array.from(db.objectStoreNames); db.close(); res(s) }; r.onerror = () => res(String(r.error)) ; setTimeout(()=>res('timeout'), 3000) }) } catch (e) { out.idbStores = String(e) }
          // 跨启动验证：用独立的数据库，不碰应用自己的会话表（避免在列表里留下测试记录）
          try {
            const cleanup = indexedDB.open('chat-demo')
            cleanup.onsuccess = () => {
              const db = cleanup.result
              try {
                const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
                tx.objectStore('sessions').delete('__persist_probe')
                tx.objectStore('sessionSummaries').delete('__persist_probe')
                tx.oncomplete = () => db.close()
                tx.onerror = () => db.close()
              } catch {
                db.close()
              }
            }
          } catch (e) { /* ignore */ }
          out.sessionProbe = await new Promise((res) => {
            const r = indexedDB.open('__ds_probe', 1)
            r.onupgradeneeded = () => { r.result.createObjectStore('probe', { keyPath: 'id' }) }
            r.onerror = () => res('open-error: ' + (r.error && r.error.message))
            r.onsuccess = () => {
              const db = r.result
              const tx = db.transaction('probe', 'readwrite')
              const store = tx.objectStore('probe')
              const get = store.get('run')
              get.onsuccess = () => {
                const prev = get.result ? get.result.at : null
                store.put({ id: 'run', at: new Date().toISOString() })
                tx.oncomplete = () => { db.close(); res(prev) }
                tx.onerror = () => { db.close(); res('tx-error') }
              }
              get.onerror = () => res('get-error')
            }
            setTimeout(() => res('timeout'), 4000)
          })
          // 主题一致性：跟随系统时，页面实际深浅色应与系统信号一致
          out.theme = (() => {
            const saved = localStorage.getItem('chat-demo:theme-preference')
            const preference = saved === 'light' || saved === 'dark' ? saved : 'system'
            const mediaDark = window.matchMedia('(prefers-color-scheme: dark)').matches
            const bodyDark = document.body.classList.contains('dark')
            return { preference, mediaDark, bodyDark, consistent: preference === 'system' ? bodyDark === mediaDark : true }
          })()
          // 偏好切换的端到端延迟：模拟应用的真实行为（写 localStorage + 派发事件）→ 系统主题信号翻转
          out.preferenceLatencyMs = await new Promise((res) => {
            const key = 'chat-demo:theme-preference'
            const original = localStorage.getItem(key)
            const target = original === 'light' ? 'dark' : 'light'
            const mq = window.matchMedia('(prefers-color-scheme: dark)')
            const apply = (value) => {
              if (value === null) localStorage.removeItem(key)
              else localStorage.setItem(key, value)
              window.dispatchEvent(new CustomEvent('ds:settings', { detail: { kind: 'theme', value } }))
            }
            let settled = false
            const finish = (value) => {
              if (settled) return
              settled = true
              mq.removeEventListener('change', onChange)
              apply(original)
              setTimeout(() => res(value), 500)
            }
            const onChange = () => finish(Math.round(performance.now() - t0))
            const t0 = performance.now()
            mq.addEventListener('change', onChange)
            apply(target)
            setTimeout(() => finish(-1), 3000)
          })
          // API Key 事件链路：用当前 Key 原样重放一次，主进程应把它重新加密存一次
          out.apiKeyEventProbe = await new Promise((res) => {
            const current = localStorage.getItem('chat-demo:api-key') || ''
            if (!current) return res('no-key')
            window.dispatchEvent(new CustomEvent('ds:settings', { detail: { kind: 'apiKey', value: current } }))
            setTimeout(() => res(current.length), 300)
          })
          // 浅色下的分层分隔线是否注入（伪元素颜色）
          out.layerDivider = (() => {
            try {
              document.body.classList.add('light')
              const color = getComputedStyle(document.body, '::before').backgroundColor
              document.body.classList.remove('light')
              return color
            } catch (e) {
              return String(e)
            }
          })()
          out.sessionProbeAt = new Date().toISOString()
          localStorage.setItem('__selftest_ts', new Date().toISOString())
          return out
        })()`,
        true
      )
      // 先截图再退出（app.exit 会立刻结束进程）
      try {
        const image = await win.webContents.capturePage()
        const shot = path.join(dataDir, 'selftest.png')
        fs.writeFileSync(shot, image.toPNG())
        console.log('SELFTEST screenshot: ' + shot)
      } catch (error) {
        console.log('SELFTEST screenshot failed: ' + String(error))
      }
      done({ ok: true, dataDir, ...result })
    } catch (error) {
      done({ ok: false, error: String(error) }, 1)
    }
  })
}

// ---------------------------------------------------------------- 生命周期
app.whenReady().then(async () => {
  // 先把加密保存的 Key 读进缓存，preload 的同步 IPC 才有值可取
  await loadStoredKey()

  if (SETKEY_ARG) {
    await storeKey(SETKEY_ARG.slice('--setkey='.length))
    console.log('SETKEY stored, encryption available=' + (await encryptionAvailable()))
    app.exit(0)
    return
  }

  // 不做任何自动备份：对话数据只保存一份，就是 data\ 目录本身

  protocol.handle(APP_SCHEME, handleAppScheme)

  // 允许麦克风（语音输入），其余权限一律拒绝
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-read')
  })

  // 导出对话记录：只调整“系统内置保存框”的默认值，不再自己弹第二个对话框。
  // 之前是自己 showSaveDialog + pause/resume，Electron 在未同步 setSavePath 时
  // 还会弹一次内置对话框，于是会出现两个。
  downloadSeq = 0
  session.defaultSession.on('will-download', (_event, item) => {
    downloadSeq += 1
    log(`will-download #${downloadSeq} file=${item.getFilename()}`)

    if (TEST_DOWNLOAD || TEST_TRANSFER) {
      // 自检：不弹需要人手点的对话框，直接取消；退出由各自的测试驱动，别在这里抢
      item.cancel()
      log('download cancelled (test mode)')
      return
    }

    const suggested = item.getFilename() || 'DeepSeek 对话导出.zip'
    try {
      item.setSaveDialogOptions({
        title: '导出对话记录',
        defaultPath: path.join(app.getPath('downloads'), suggested),
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      })
    } catch (error) {
      log('setSaveDialogOptions failed: ' + String(error))
    }
  })

  const win = createWindow()
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    saveWindowState(mainWindow)
    // 尽力而为：把页面里的 Key 再同步一次
    try {
      const key = mainWindow.webContents.executeJavaScript(
        `(()=>{try{return localStorage.getItem(${JSON.stringify(LS_API_KEY)})}catch(e){return null}})()`,
        true
      )
      key.then((k) => {
        if (typeof k === 'string' && k.trim() && k !== cachedKey) storeKey(k.trim())
      })
    } catch {
      /* ignore */
    }
  }
})

process.on('uncaughtException', (error) => log('uncaughtException', String(error)))
process.on('unhandledRejection', (error) => log('unhandledRejection', String(error)))