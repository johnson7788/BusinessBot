import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { X } from 'lucide-react'
import IconButton from './IconButton.tsx'

type ClearableTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  value: string
  onValueChange: (value: string) => void
  clearLabel?: string
}

const ClearableTextarea = forwardRef<HTMLTextAreaElement, ClearableTextareaProps>(function ClearableTextarea(
  { value, onValueChange, clearLabel = '清空', disabled, className = '', onChange, ...props },
  ref,
) {
  return (
    <div className="relative">
      <textarea
        {...props}
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={event => {
          onValueChange(event.target.value)
          onChange?.(event)
        }}
        className={`w-full bg-transparent outline-none ${value && !disabled ? 'pr-10' : ''} ${className}`}
      />
      {value && !disabled && (
        <div className="absolute right-1 top-1">
          <IconButton
            label={clearLabel}
            size="sm"
            onMouseDown={event => event.preventDefault()}
            onClick={() => onValueChange('')}
          >
            <X size={13} />
          </IconButton>
        </div>
      )}
    </div>
  )
})

export default ClearableTextarea
