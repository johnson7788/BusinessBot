import { type ReactElement, cloneElement, useCallback, useLayoutEffect, useRef, useState } from 'react'

type TooltipProps = {
  content: string
  children: ReactElement<Record<string, any>>
  placement?: 'top' | 'bottom'
}

export default function Tooltip({ content, children, placement = 'top' }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, placement })
  const triggerRef = useRef<HTMLSpanElement>(null)

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 8
    const tooltipWidth = 224
    const tooltipHeight = 30
    const preferredTop = placement === 'bottom'
      ? rect.bottom + margin
      : rect.top - tooltipHeight - margin
    const hasTopSpace = rect.top >= tooltipHeight + margin
    const hasBottomSpace = window.innerHeight - rect.bottom >= tooltipHeight + margin
    const nextPlacement = placement === 'bottom'
      ? (hasBottomSpace ? 'bottom' : 'top')
      : (hasTopSpace ? 'top' : 'bottom')
    const nextTop = nextPlacement === 'bottom'
      ? Math.min(rect.bottom + margin, window.innerHeight - tooltipHeight - margin)
      : Math.max(margin, preferredTop)
    const center = rect.left + rect.width / 2
    const halfWidth = tooltipWidth / 2
    const nextLeft = Math.min(
      Math.max(center, margin + halfWidth),
      window.innerWidth - margin - halfWidth,
    )
    setPosition({ top: nextTop, left: nextLeft, placement: nextPlacement })
  }, [placement])

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
    <span
      ref={triggerRef}
      className="inline-flex"
      onMouseEnter={() => {
        setOpen(true)
        requestAnimationFrame(updatePosition)
      }}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => {
        setOpen(true)
        requestAnimationFrame(updatePosition)
      }}
      onBlur={() => setOpen(false)}
    >
      {cloneElement(children, {
        'aria-label': children.props['aria-label'] || content,
      })}
      {open && (
        <span
          role="tooltip"
          style={{ top: position.top, left: position.left }}
          className="pointer-events-none fixed z-[80] max-w-56 -translate-x-1/2 whitespace-nowrap rounded-lg border border-light-border bg-white px-2 py-1 text-xs text-light-text shadow-lg shadow-slate-200/80"
        >
          {content}
        </span>
      )}
    </span>
  )
}
