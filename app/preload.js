'use strict'
/**
 * preload
 * 1) 在页面脚本之前，把 DPAPI 里保存的 API Key 写回 localStorage（用户只需填一次）。
 * 2) 把界面的表面色/文字色上报给主进程，用于给 Windows 原生标题栏上色。
 */
const { ipcRenderer } = require('electron')

const LS_API_KEY = 'chat-demo:api-key'

// ---------------------------------------------------------------- API Key 注入
try {
  if (process.isMainFrame) {
    const stored = ipcRenderer.sendSync('ds-key:get')
    if (typeof stored === 'string' && stored.trim()) {
      const existing = window.localStorage.getItem(LS_API_KEY)
      if (!existing || !existing.trim()) {
        window.localStorage.setItem(LS_API_KEY, stored.trim())
      }
    }
  }
} catch {
  // 存储不可用时静默降级：用户仍可在设置里手动填写
}

// ---------------------------------------------------------------- 标题栏取色
// 取侧边栏那一档“表面色”而不是主区背景色，标题栏才会自成一档、和内容区分开。
// 应用的主题偏好：light / dark / system（未设置过即跟随系统）
const readThemePreference = () => {
  try {
    const saved = window.localStorage.getItem('chat-demo:theme-preference')
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  } catch {
    return 'system'
  }
}

const readChromeColors = () => {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;width:0;height:0;background:var(--dsw-specific-sidebar-fill)'
  document.body.appendChild(probe)
  const background = getComputedStyle(probe).backgroundColor
  probe.remove()
  const foreground = getComputedStyle(document.body).color
  return { background, foreground }
}

const reportChromeColors = () => {
  try {
    if (!document.body || !document.body.firstChild) return
    const colors = readChromeColors()
    if (colors.background && colors.background !== 'rgba(0, 0, 0, 0)') {
      colors.dark = document.body.classList.contains('dark')
      colors.preference = readThemePreference()
      ipcRenderer.send('ds-chrome:colors', colors)
    }
  } catch {
    /* ignore */
  }
}

const watchTheme = () => {
  // 浅色下菜单栏和页面内容都是纯白，靠一条 1px 线分出层次
  if (document.head && !document.getElementById('ds-layer-divider')) {
    const style = document.createElement('style')
    style.id = 'ds-layer-divider'
    style.textContent = `
      body.light::before {
        content: '';
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 1px;
        background: #e2e3e6;
        z-index: 2147483000;
        pointer-events: none;
      }
    `
    document.head.appendChild(style)
  }

  reportChromeColors()
  // 主题初始化可能分几步完成，补两次
  setTimeout(reportChromeColors, 120)
  setTimeout(reportChromeColors, 600)

  // body 上的 class / data-ds-dark-theme 一变就立刻重新上报
  try {
    new MutationObserver(reportChromeColors).observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-ds-dark-theme', 'style'],
    })
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', reportChromeColors)
  } catch {
    /* ignore */
  }

  /**
   * 应用侧的设置变化由 settings.ts 主动派发事件（ds:settings）。
   * 这样「手动浅色/深色 → 跟随系统」这类“颜色没变、语义变了”的切换也能立刻感知，
   * 不需要定时轮询。
   */
  window.addEventListener('ds:settings', (event) => {
    const detail = event && event.detail
    if (!detail) return
    if (detail.kind === 'theme') {
      // 等应用真正把主题应用完再取色，否则取到的是切换前的旧颜色
      setTimeout(reportChromeColors, 0)
    } else if (detail.kind === 'apiKey') {
      ipcRenderer.send('ds-key:changed', typeof detail.value === 'string' ? detail.value : '')
    }
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchTheme, { once: true })
} else {
  watchTheme()
}