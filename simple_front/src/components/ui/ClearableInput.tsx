import { forwardRef, type InputHTMLAttributes } from 'react'
import { X } from 'lucide-react'
import IconButton from './IconButton.tsx'

type ClearableInputProps = InputHTMLAttributes<HTMLInputElement> & {
  value: string
  onValueChange: (value: string) => void
  clearLabel?: string
}

const ClearableInput = forwardRef<HTMLInputElement, ClearableInputProps>(function ClearableInput(
  { value, onValueChange, clearLabel = '清空', disabled, className = '', onChange, ...props },
  ref,
) {
  return (
    <div className="flex min-w-0 flex-1 items-center">
      <input
        {...props}
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={event => {
          onValueChange(event.target.value)
          onChange?.(event)
        }}
        className={`min-w-0 flex-1 bg-transparent outline-none ${className}`}
      />
      {value && !disabled && (
        <IconButton
          label={clearLabel}
          size="sm"
          onMouseDown={event => event.preventDefault()}
          onClick={() => onValueChange('')}
          className="-mr-1"
        >
          <X size={13} />
        </IconButton>
      )}
    </div>
  )
})

export default ClearableInput
