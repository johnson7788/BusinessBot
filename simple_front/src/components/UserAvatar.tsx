import { User } from 'lucide-react'
import type { AuthUser } from '../lib/api.ts'

function getInitial(user: AuthUser | null): string {
  const source = user?.username || user?.email || ''
  return source ? source.slice(0, 1).toUpperCase() : ''
}

export default function UserAvatar({
  user,
  size = 'md',
  className = '',
}: {
  user: AuthUser | null
  size?: 'sm' | 'md'
  className?: string
}) {
  const sizeClass = size === 'sm' ? 'h-7 w-7 text-[11px]' : 'h-8 w-8 text-xs'
  const initial = getInitial(user)

  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-accent-blue text-white ${sizeClass} ${className}`}
      title={user?.username || user?.email || '当前用户'}
    >
      {initial || <User size={size === 'sm' ? 14 : 16} />}
    </div>
  )
}
