import { createConfig } from './rspack.config'

/**
 * 便携版构建配置：只在官方配置基础上固定 API 地址。
 * 前端仍直连官方 API（已确认该服务对任意 Origin 返回 access-control-allow-origin，
 * 因此 app://chat 也能正常跨域，无需本地代理）。
 */
export default createConfig({ apiOrigin: 'https://api.deepseek.com' })