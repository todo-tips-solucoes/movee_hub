import { describe, expect, it } from 'vitest';
import { diaDoRepasse, diasAteRepasse } from './adiantamento-repasse';

// 0=domingo … 6=sábado. Janela de SEGUNDA (1) termina no DOMINGO (0).
describe('diasAteRepasse (dia escolhido -> o número que o banco guarda)', () => {
  it('janela seg–dom, repasse na quarta = 3 (o caso do operador, 2026-09-22)', () => {
    expect(diasAteRepasse(1, 3)).toBe(3);
  });

  it('conta a partir do domingo, que ENTRA na janela: segunda = 1', () => {
    expect(diasAteRepasse(1, 1)).toBe(1);
  });

  it('repasse no mesmo dia da semana em que a janela fecha = semana seguinte (7), nunca 0', () => {
    expect(diasAteRepasse(1, 0)).toBe(7);
  });

  it('sempre entre 1 e 7, para qualquer início e dia', () => {
    for (let inicio = 0; inicio < 7; inicio++) {
      for (let dia = 0; dia < 7; dia++) {
        const n = diasAteRepasse(inicio, dia);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(7);
      }
    }
  });
});

describe('diaDoRepasse (número salvo -> dia que a tela mostra)', () => {
  it('é o inverso exato de diasAteRepasse', () => {
    for (let inicio = 0; inicio < 7; inicio++) {
      for (let dia = 0; dia < 7; dia++) {
        expect(diaDoRepasse(inicio, diasAteRepasse(inicio, dia))).toBe(dia);
      }
    }
  });

  it('fora de 1..7 não vira dia da semana (senão salvar mudaria o prazo em silêncio)', () => {
    expect(diaDoRepasse(1, 0)).toBeNull();
    expect(diaDoRepasse(1, 10)).toBeNull();
    expect(diaDoRepasse(1, 2.5)).toBeNull();
  });
});
