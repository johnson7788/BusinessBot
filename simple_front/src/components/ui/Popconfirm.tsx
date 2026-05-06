import { type MouseEvent as ReactMouseEvent, type ReactElement, cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

type PopconfirmProps = {
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
  children: ReactElement<Record<string, any>>
}

export default function Popconfirm({
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  onConfirm,
  children,
}: PopconfirmProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const ref = useRef<HTMLSpanElement>(null)
  const panelWidth = 256
  const estimatedPanelHeight = description ? 164 : 126

  const updatePosition = useCallback(() => {
    const trigger = ref.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 8
    const gap = 8
    const preferredLeft = rect.right - panelWidth
    const nextLeft = Math.min(
      Math.max(preferredLeft, margin),
      window.innerWidth - panelWidth - margin,
    )
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const spaceAbove = rect.top - margin
    const openBelow = spaceBelow >= estimatedPanelHeight || spaceBelow >= spaceAbove
    const nextTop = openBelow
      ? Math.min(rect.bottom + gap, window.innerHeight - estimatedPanelHeight - margin)
      : Math.max(margin, rect.top - estimatedPanelHeight - gap)
    setPosition({ top: nextTop, left: nextLeft })
  }, [description])

  useEffect(() => {
    if (!open) return
    const close = (event: globalThis.MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, updatePosition])

  return (
    <span ref={ref} className="relative inline-flex">
      {cloneElement(children, {
        onClick: (event: ReactMouseEvent) => {
          event.stopPropagation()
          children.props.onClick?.(event)
          setOpen(true)
          requestAnimationFrame(updatePosition)
        },
      })}
      {open && (
        <span
          style={{ top: position.top, left: position.left }}
          className="fixed z-[90] flex max-h-[min(320px,calc(100vh-16px))] w-64 flex-col rounded-xl border border-light-border bg-white p-3 text-left shadow-xl shadow-slate-200/80"
        >
          <span className="block shrink-0 text-sm font-medium text-light-text">{title}</span>
          {description && (
            <span className="mt-1 block min-h-0 overflow-y-auto break-words text-xs leading-5 text-light-text-secondary">
              {description}
            </span>
          )}
          <span className="mt-3 flex shrink-0 justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="cursor-pointer rounded-lg border border-light-border px-3 py-1.5 text-xs text-light-text-secondary transition-colors hover:bg-light-card-hover hover:text-light-text"
            >
              {cancelText}
            </button>
            <button
              type="button"
              onClick={async () => {
                await onConfirm()
                setOpen(false)
              }}
              className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors ${
                danger ? 'bg-accent-red hover:bg-red-600' : 'bg-accent-blue hover:bg-cyan-700'
              }`}
            >
              {confirmText}
            </button>
          </span>
        </span>
      )}
    </span>
  )
}
