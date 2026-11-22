import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { exportHistory, importHistory } from '../../services/chat/backup.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { IconDownloadOutline16, IconUploadOutline14 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import styles from './Sider.module.css'

/**
 * 侧边栏底部的导入 / 导出入口。
 * 直接复用设置页那套 backup 服务（importHistory / exportHistory），
 * 不另写实现，保证导出格式与覆盖式导入的行为跟设置页完全一致。
 */
export const HistoryTransfer = () => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  const runImport = async (file: File) => {
    setPending(null)
    setBusy(true)
    try {
      const count = await importHistory(file)
      showToast({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      showToast({ key: 'historyImportFailed', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const runExport = async () => {
    setBusy(true)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      showToast({
        key: 'historyExportFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
        type: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <IconButton
        size="m"
        tooltip={t('historyImport')}
        tooltipPlacement="top"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        icon={
          <span className={styles.transferIcon}>
            <IconUploadOutline14 />
          </span>
        }
      />
      <IconButton
        size="m"
        tooltip={t('exportAllLabel')}
        tooltipPlacement="top"
        disabled={busy}
        onClick={() => void runExport()}
        icon={
          <span className={styles.transferIcon}>
            <IconDownloadOutline16 />
          </span>
        }
      />
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) {
            setPending(file)
          }
        }}
      />
      {pending ? (
        <Modal
          title={t('historyImportConfirmTitle')}
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="outlined" size="m" autoFocus onClick={() => setPending(null)}>
                {t('cancel')}
              </Button>
              <Button variant="dangerOutlined" size="m" onClick={() => void runImport(pending)}>
                {t('historyImportConfirm')}
              </Button>
            </>
          }
        >
          <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
        </Modal>
      ) : null}
    </>
  )
}