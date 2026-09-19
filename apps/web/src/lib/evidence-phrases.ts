import { EVIDENCE_CODES, type EvidenceCode, type EvidenceDto } from '@aa/contracts';

/**
 * Evidence codes rendered as sentences.
 *
 * The backend emits codes and never prose; this table turns them into Spanish.
 * One source of truth — the closed vocabulary — and two renderings, this and
 * the printed report, so the screen and the PDF can never disagree about what
 * a conclusion says. The vocabulary itself comes from `@aa/contracts`, the
 * frontend's only backend dependency. See ADR-0007 and ADR-0010.
 */
type Phrase = (evidence: EvidenceDto) => string;

const PHRASES: Readonly<Record<EvidenceCode, Phrase>> = {
  // —— Channel to bank
  AMOUNT_EXACT: () => 'El monto acreditado coincide exactamente con el neto esperado.',
  AMOUNT_WITHIN_ROUNDING: (e) =>
    `El monto difiere en ${e.detail ?? 'una cifra menor'}, dentro de la tolerancia de redondeo.`,
  IMPLIED_FEE_IN_BAND: (e) =>
    `Las deducciones no vienen detalladas; ${e.detail ?? 'la diferencia implica una tasa dentro del rango esperado'}.`,
  AMOUNT_MISMATCH: (e) => `El monto acreditado difiere del neto esperado en ${e.detail ?? 'una cifra significativa'}.`,
  DATE_T1_EXACT: (e) => `Se acreditó ${e.observed ?? ''}, el día hábil siguiente a la venta.`,
  DATE_IN_WINDOW: (e) => `Se acreditó ${e.observed ?? ''}, dentro de la ventana esperada.`,
  DATE_OUT_OF_WINDOW: (e) => `La acreditación (${e.observed ?? '—'}) cae fuera de la ventana esperada.`,
  DESCRIPTOR_MATCH: (e) => `El descriptor del extracto identifica a ${e.observed ?? 'el canal'} como originante.`,
  DESCRIPTOR_FOREIGN: (e) => `El descriptor corresponde a ${e.observed ?? 'otro originante'}, no al canal esperado.`,
  UNIQUE_CANDIDATE: () => 'No hay otro depósito que pueda corresponder a esta liquidación.',
  COMPETING_CANDIDATE: (e) => `Existe otro depósito igualmente compatible (${e.detail ?? 'puntaje similar'}).`,
  IDENTITY_HOLDS: () => 'El desglose cierra: el bruto menos las deducciones iguala al neto.',
  IDENTITY_BROKEN: (e) => `El desglose no cierra${e.detail ? `: ${e.detail}` : ''}.`,
  SETTLEMENT_SINGLE_CREDIT: (e) =>
    `Llegó en una sola acreditación${e.observed ? `: ${e.observed}` : ''}.`,
  SETTLEMENT_SPLIT: (e) =>
    `El lote no llegó en una sola acreditación: ${e.observed ?? 'varias'}${e.detail ? ` (${e.detail})` : ''}.`,
  SUBSET_SUM_UNIQUE: () => 'Se encontró una única combinación de pagos que suma el depósito.',
  SUBSET_SUM_MULTIPLE: (e) => `Hay varias combinaciones posibles${e.detail ? ` (${e.detail})` : ''}; ninguna es concluyente.`,
  UNRESOLVED_COMBINATORIAL: () => 'La búsqueda superó el límite configurado sin un resultado concluyente.',

  // —— Ledger to ERP
  MATCHED_BY_REF: (e) => `El asiento ${e.observed ?? ''} referencia explícitamente a esta transacción.`,
  MATCHED_EXACT: () => 'Coinciden en fecha, cuenta y monto.',
  MATCHED_AGGREGATED: (e) => `Forma parte de un asiento agregado${e.expected ? ` (${e.expected})` : ''}.`,
  INCOMPLETE_ENTRY: (e) => `El asiento registra la venta pero no incluye ${conceptsOf(e)}.`,
  DATE_SHIFT: (e) => `Mismo monto, registrado el ${e.observed ?? '—'} en lugar del ${e.expected ?? '—'}.`,
  AMOUNT_MISMATCH_ERP: (e) => `El monto registrado difiere del real${e.detail ? `: ${e.detail}` : ''}.`,
  MISSING_IN_ERP: (e) => `Esta transacción no tiene asiento${e.detail ? ` en el ${e.detail}` : ''}.`,
  MISSING_IN_LEDGER: (e) => `El asiento ${e.observed ?? ''} no corresponde a ningún movimiento ingestado.`,
  DUPLICATE_IN_ERP: (e) => `Hay ${e.observed ?? 'varios'} asientos que representan el mismo movimiento.`,
  NO_ACCOUNT_MAPPING: (e) => `${e.observed ?? 'Este concepto'} no tiene cuenta asignada en el plan del challenge.`,

  // —— Ingestion
  BALANCE_CHAIN_OK: () => 'El extracto es íntegro: la cadena de saldos cierra contra el saldo final.',
  BALANCE_CHAIN_BROKEN: (e) => `La cadena de saldos se rompe${e.locator ? ` en ${e.locator}` : ''}.`,
  SUMMARY_TOTALS_OK: () => 'Los totales del resumen coinciden con la suma de los movimientos.',
  SUMMARY_TOTALS_MISMATCH: () => 'Los totales del resumen no coinciden con la suma de las filas.',
  TRANSACTION_EXCLUDED_NOT_APPROVED: (e) => `Excluida del ledger: no movió dinero (${e.observed ?? 'no aprobada'}).`,
  DESCRIPTOR_UNCLASSIFIED: (e) => `Descriptor no reconocido (${e.observed ?? '—'}); queda sin clasificar y visible.`,
  SOURCE_STALE: (e) => `Los datos de ${e.observed ?? 'la fuente'} no están actualizados: la fuente no respondió.`,
  DEDUCTIONS_DERIVED: (e) =>
    `Las deducciones no las informa la fuente: se derivaron de la diferencia contra el depósito${e.detail ? ` (${e.detail})` : ''}.`,
};

/**
 * Typing PHRASES by `EvidenceCode` means a code added to the contract fails
 * this file to compile until it has a sentence — the coverage guarantee is the
 * type system's, not a test's. The fallback only covers a payload that lies
 * about its own schema.
 */
export function phraseFor(evidence: EvidenceDto): string {
  const phrase = PHRASES[evidence.code];
  if (phrase) return phrase(evidence);
  return `Verificación ${evidence.code}${evidence.detail ? `: ${evidence.detail}` : ''}.`;
}

export function hasPhrase(code: string): code is EvidenceCode {
  return (EVIDENCE_CODES as readonly string[]).includes(code);
}

function conceptsOf(evidence: EvidenceDto): string {
  const raw = evidence.detail?.replace(/^faltan:\s*/, '') ?? '';
  const names: Record<string, string> = {
    FEE: 'la comisión',
    TAX: 'el IVA de la comisión',
    WITHHOLDING: 'la retención en la fuente',
    CHARGE: 'la venta',
  };
  const translated = raw
    .split(',')
    .map((part) => names[part.trim()] ?? part.trim())
    .filter(Boolean);

  if (translated.length === 0) return 'todos los conceptos esperados';
  if (translated.length === 1) return translated[0]!;
  return `${translated.slice(0, -1).join(', ')} ni ${translated.at(-1)}`;
}
