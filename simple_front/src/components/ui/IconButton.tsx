import { type ButtonHTMLAttributes, type ReactNode } from 'react'
import Tooltip from './Tooltip.tsx'

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  children: ReactNode
  size?: 'sm' | 'md'
  tone?: 'neutral' | 'primary' | 'danger'
  surface?: 'subtle' | 'plain'
  tooltipPlacement?: 'top' | 'bottom'
}

export default function IconButton({
  label,
  children,
  size = 'md',
  tone = 'neutral',
  surface = 'subtle',
  tooltipPlacement,
  className = '',
  type = 'button',
  ...props
}: IconButtonProps) {
  const sizeClass = size === 'sm' ? 'h-6 w-6 rounded-lg' : 'h-8 w-8 rounded-lg'
  const hoverSurface =
    surface === 'plain'
      ? 'hover:bg-transparent'
      : tone === 'danger'
        ? 'hover:bg-accent-red/10'
        : 'hover:bg-light-card-hover'
  const toneClass =
    tone === 'danger'
      ? `text-light-text-secondary ${hoverSurface} hover:text-accent-red`
      : tone === 'primary'
        ? `text-light-text-secondary ${hoverSurface} hover:text-accent-blue`
        : `text-light-text-secondary ${hoverSurface} hover:text-light-text`

  const button = (
    <button
      {...props}
      type={type}
      aria-label={label}
      className={`inline-flex shrink-0 cursor-pointer items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass} ${toneClass} ${className}`}
    >
      {children}
    </button>
  )

  return (
    <Tooltip content={label} placement={tooltipPlacement}>
      {button}
    </Tooltip>
  )
}
