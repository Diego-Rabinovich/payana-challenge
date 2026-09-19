/**
 * Status as a chip.
 *
 * `AMBIGUOUS` is deliberately styled like a warning and never like a success:
 * presenting an ambiguous match as resolved would be the worst thing this
 * interface could do, so the visual language has to say "look at me".
 */
const LABELS: Readonly<Record<string, string>> = {
  CONFIRMED: 'Confirmado',
  PROBABLE: 'Probable',
  AMBIGUOUS: 'Ambiguo',
  UNMATCHED: 'Sin conciliar',
  UNRESOLVED_COMBINATORIAL: 'Sin resolver',
  MATCHED: 'Coincide',
  INCOMPLETE_ENTRY: 'Asiento incompleto',
  AMOUNT_MISMATCH: 'Monto distinto',
  DATE_SHIFT: 'Fecha corrida',
  MISSING_IN_ERP: 'Falta en el ERP',
  MISSING_IN_LEDGER: 'Falta en el ledger',
  DUPLICATE_IN_ERP: 'Duplicado en el ERP',
};

const TONES: Readonly<Record<string, 'good' | 'warn' | 'bad'>> = {
  CONFIRMED: 'good',
  MATCHED: 'good',
  PROBABLE: 'warn',
  AMBIGUOUS: 'warn',
  DATE_SHIFT: 'warn',
  UNMATCHED: 'bad',
  UNRESOLVED_COMBINATORIAL: 'bad',
  INCOMPLETE_ENTRY: 'bad',
  AMOUNT_MISMATCH: 'bad',
  MISSING_IN_ERP: 'bad',
  MISSING_IN_LEDGER: 'bad',
  DUPLICATE_IN_ERP: 'bad',
};

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`chip chip--${TONES[status] ?? 'warn'}`}>{LABELS[status] ?? status}</span>
  );
}
