import { cn } from '@/lib/utils';

/** Placeholder de carregamento com shimmer (classe .skeleton em globals.css). */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton rounded-lg', className)} {...props} />;
}
