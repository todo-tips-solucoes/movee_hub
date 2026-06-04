'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Anima um número de 0 até `value` ao montar, formatando cada quadro.
 * Usado no valor do movimento para dar a sensação de "contagem". Respeita
 * prefers-reduced-motion exibindo direto o valor final.
 */
export function CountUp({
  value,
  format,
  durationMs = 1100,
  className,
}: {
  value: number;
  format: (n: number) => string;
  durationMs?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !isFinite(value)) {
      setDisplay(value);
      return;
    }

    let start: number | null = null;
    const from = 0;
    // easeOutExpo — desacelera no fim, dando peso ao número
    const ease = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

    const tick = (now: number) => {
      if (start === null) start = now;
      const p = Math.min((now - start) / durationMs, 1);
      setDisplay(from + (value - from) * ease(p));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value, durationMs]);

  return (
    <span className={className} suppressHydrationWarning>
      {format(display)}
    </span>
  );
}
