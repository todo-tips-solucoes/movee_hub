import { cn } from '@/lib/utils';

/**
 * Fundo "aurora" — orbes desfocados que flutuam suavemente, dando profundidade
 * e vida às telas. Puramente decorativo (aria-hidden) e cai para estático sob
 * prefers-reduced-motion (regra global em globals.css). Posicione dentro de um
 * contêiner `relative overflow-hidden`.
 */
export function Aurora({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      <span
        className="aurora-orb animate-float"
        style={{
          width: '18rem',
          height: '18rem',
          top: '-5rem',
          left: '-4rem',
          background: 'radial-gradient(circle, #ffc020, #ff7a18)',
          animationDelay: '0s',
        }}
      />
      <span
        className="aurora-orb animate-float"
        style={{
          width: '15rem',
          height: '15rem',
          top: '20%',
          right: '-5rem',
          background: 'radial-gradient(circle, #f23a20, #ff7a18)',
          opacity: 0.7,
          animationDelay: '-3.5s',
          animationDuration: '11s',
        }}
      />
      <span
        className="aurora-orb animate-float"
        style={{
          width: '13rem',
          height: '13rem',
          bottom: '-3rem',
          left: '25%',
          background: 'radial-gradient(circle, #4f8bff, #1f63eb)',
          opacity: 0.55,
          animationDelay: '-6s',
          animationDuration: '13s',
        }}
      />
    </div>
  );
}
