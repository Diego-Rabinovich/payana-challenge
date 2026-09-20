import type { ChannelDto } from '@aa/contracts';
import { api } from '../api/client.js';
import { Resolved } from '../components/States.js';
import { useResource } from '../lib/useResource.js';

/**
 * The sources this system is connected to, and what the last run observed
 * about each one's commission.
 *
 * There is no button. Calibration is a reading, not an action: the run already
 * derived an implied rate for every settlement, so what belongs on screen is
 * that distribution next to the band the config declares. Fitting a band on
 * demand and then judging those same settlements with it would be the model
 * validating itself against the data it came from.
 *
 * What the screen does instead is hand over the number: median ± one
 * deviation, formatted the way `config/ruleset.v1.json` wants it, for a person
 * to paste with its provenance beside it. Editing it here would mean the
 * ruleset version no longer described the ruleset, and every past result would
 * stop being reproducible.
 */
export function Sources() {
  const channels = useResource(() => api.channels(), []);

  return (
    <Resolved resource={channels} what="las fuentes">
      {(data) => (
        <>
          <div className="card">
            <h2 className="card__title">Fuentes conectadas</h2>
            <p className="card__hint">
              Cada canal declara cómo liquida y cuánto cobra. Nada de esto es código: sale de{' '}
              <code>config/ruleset.v1.json</code>, y un canal que no declara algo cae en el valor
              por defecto, nunca en el de otro canal.
            </p>
          </div>
          {data.channels.map((channel) => (
            <Channel key={channel.key} channel={channel} />
          ))}
        </>
      )}
    </Resolved>
  );
}

function Channel({ channel }: { channel: ChannelDto }) {
  const { calibration: cal } = channel;

  return (
    <div className="card">
      <h2 className="card__title">{channel.key}</h2>
      <p className="card__hint">
        Se reconoce en el extracto por{' '}
        {channel.counterpartyPatterns.map((pattern, index) => (
          <span key={pattern}>
            {index > 0 && ', '}
            <code>{pattern}</code>
          </span>
        ))}
      </p>

      <div className="section-title" style={{ marginTop: 8 }}>
        Cómo liquida
      </div>
      <div className="table-wrap">
        <table>
          <tbody>
            <Setting name="Cadencia" value={channel.cadence} source="channels.*.settlement.cadence" />
            <Setting
              name="Corte del día"
              value={channel.cutoff ?? 'medianoche (por defecto)'}
              source="channels.*.settlement.cutoff"
            />
            <Setting
              name="Ventana de acreditación"
              value={`T+${channel.window.fromBusinessDays} a T+${channel.window.toBusinessDays} días hábiles`}
              source="channels.*.settlement.window"
            />
          </tbody>
        </table>
      </div>

      <div className="section-title">Cuánto cobra</div>
      {!channel.declaresOwnBand && (
        <p className="banner banner--warn">
          Este canal no declara sus propias bandas, así que usa el default global, que es ancho a
          propósito: no se sabe nada de él todavía. Con una corrida encima, la sugerencia de abajo
          es lo que habría que escribirle.
        </p>
      )}
      <div className="table-wrap">
        <table>
          <tbody>
            <Setting
              name="Banda admisible"
              value={`${pct(channel.admissibleBand[0])} – ${pct(channel.admissibleBand[1])}`}
              source="channels.*.deductions.plausibleTotalBand"
              note="Afuera, la diferencia no puede ser comisión: descalifica el candidato."
            />
            <Setting
              name="Banda habitual"
              value={`${pct(channel.typicalBand[0])} – ${pct(channel.typicalBand[1])}`}
              source="channels.*.deductions.typicalTotalBand"
              note="Adentro vale 40 puntos; afuera pero admisible, 25. No descarta nada."
            />
          </tbody>
        </table>
      </div>

      <div className="section-title">Lo que observó la última corrida</div>
      <Calibration channel={channel} />
      {cal.settlements === 0 && (
        <p className="muted">Todavía no hay liquidaciones de este canal en la última corrida.</p>
      )}
    </div>
  );
}

function Calibration({ channel }: { channel: ChannelDto }) {
  const cal = channel.calibration;

  if (cal.deductionsAreReported) {
    return (
      <p className="banner banner--info">
        Esta fuente informa sus propias deducciones, así que no hay nada que calibrar: el neto
        esperado se calcula sin mirar el depósito, y la coincidencia exacta vale{' '}
        <code>AMOUNT_EXACT</code>. Las bandas de arriba quedan sin usar.
      </p>
    );
  }

  if (cal.observedRates.length === 0) return null;

  const [low, high] = channel.typicalBand;
  const min = cal.observedRates[0]!;
  const max = cal.observedRates[cal.observedRates.length - 1]!;

  return (
    <>
      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile">
          <div className="tile__label">Liquidaciones observadas</div>
          <div className="tile__value">{cal.settlements}</div>
        </div>
        <div className="tile">
          <div className="tile__label">Tasa mediana</div>
          <div className="tile__value">{cal.median !== undefined ? pct(cal.median) : '—'}</div>
          <div className="tile__note">
            desvío {cal.deviation !== undefined ? (cal.deviation * 100).toFixed(3) : '—'} puntos
          </div>
        </div>
        <div className="tile">
          <div className="tile__label">Dentro de la habitual</div>
          <div className="tile__value">
            {cal.insideTypical}
            <span className="muted" style={{ fontSize: 15 }}>
              /{cal.observedRates.length}
            </span>
          </div>
        </div>
        <div className="tile">
          <div className="tile__label">Dentro de la admisible</div>
          <div className="tile__value">
            {cal.insideAdmissible}
            <span className="muted" style={{ fontSize: 15 }}>
              /{cal.observedRates.length}
            </span>
          </div>
          {cal.insideAdmissible < cal.observedRates.length && (
            <div className="tile__note">hay tasas fuera de lo admisible</div>
          )}
        </div>
      </div>

      <Histogram rates={cal.observedRates} band={[low, high]} />

      <p className="faint" style={{ marginTop: 10 }}>
        Observado de {pct(min)} a {pct(max)}.
      </p>

      {cal.suggestedTypicalBand && (
        <div className="banner banner--info" style={{ display: 'block' }}>
          <p style={{ margin: '0 0 8px' }}>
            Mediana ± un desvío da{' '}
            <strong>
              {pct(cal.suggestedTypicalBand[0])} – {pct(cal.suggestedTypicalBand[1])}
            </strong>
            {matchesConfigured(cal.suggestedTypicalBand, channel.typicalBand)
              ? ', que es lo que ya está configurado.'
              : ', distinto de lo configurado. Si la tarifa cambió, esto es lo que habría que escribir:'}
          </p>
          {!matchesConfigured(cal.suggestedTypicalBand, channel.typicalBand) && (
            <pre className="mono" style={{ margin: 0, overflowX: 'auto' }}>
              {`"typicalTotalBand": [${cal.suggestedTypicalBand[0]}, ${cal.suggestedTypicalBand[1]}]`}
            </pre>
          )}
        </div>
      )}

      <p className="faint">
        No hay botón para aplicarlo. Ajustar la banda con las mismas liquidaciones que después se
        juzgan con ella sería circular, y además el número tiene que viajar con la versión del
        ruleset para que las corridas viejas sigan siendo reproducibles. Va a mano a{' '}
        <code>config/ruleset.v1.json</code>, con la nota de cómo se midió al lado.
      </p>
    </>
  );
}

/**
 * The distribution, drawn against the configured band.
 *
 * A histogram rather than a list because the question is about shape: whether
 * the cluster still sits inside the band, and whether the tail has grown.
 */
function Histogram({
  rates,
  band,
}: {
  rates: readonly number[];
  band: readonly [number, number];
}) {
  const min = Math.min(rates[0]!, band[0]);
  const max = Math.max(rates[rates.length - 1]!, band[1]);
  const span = Math.max(max - min, 0.0001);
  const buckets = 24;

  const counts = new Array<number>(buckets).fill(0);
  for (const rate of rates) {
    const index = Math.min(buckets - 1, Math.floor(((rate - min) / span) * buckets));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const tallest = Math.max(...counts, 1);

  const x = (rate: number) => ((rate - min) / span) * 100;

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox="0 0 100 34"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Distribución de ${rates.length} tasas observadas contra la banda configurada`}
        style={{ width: '100%', height: 110, display: 'block' }}
      >
        <rect
          x={x(band[0])}
          y="0"
          width={Math.max(0.5, x(band[1]) - x(band[0]))}
          height="28"
          fill="var(--ok-soft)"
        />
        {counts.map((count, index) =>
          count === 0 ? null : (
            <rect
              key={index}
              x={(index / buckets) * 100 + 0.25}
              y={28 - (count / tallest) * 26}
              width={100 / buckets - 0.5}
              height={(count / tallest) * 26}
              fill="#7d95c4"
            />
          ),
        )}
        <line x1="0" y1="28" x2="100" y2="28" stroke="var(--line)" strokeWidth="0.3" />
      </svg>
      <figcaption className="faint" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{pct(min)}</span>
        <span>la franja verde es la banda habitual configurada</span>
        <span>{pct(max)}</span>
      </figcaption>
    </figure>
  );
}

function Setting({
  name,
  value,
  source,
  note,
}: {
  name: string;
  value: string;
  source: string;
  note?: string;
}) {
  return (
    <tr>
      <td style={{ width: 200 }}>{name}</td>
      <td>
        <strong>{value}</strong>
        {note && <div className="faint">{note}</div>}
      </td>
      <td className="faint mono" style={{ textAlign: 'right' }}>
        {source}
      </td>
    </tr>
  );
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2).replace('.', ',')}%`;
}

function matchesConfigured(
  suggested: readonly [number, number],
  configured: readonly [number, number],
): boolean {
  return (
    Math.abs(suggested[0] - configured[0]) < 0.0005 &&
    Math.abs(suggested[1] - configured[1]) < 0.0005
  );
}
