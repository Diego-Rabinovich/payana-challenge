import type { ChannelDto } from '@aa/contracts';
import { api } from '../api/client.js';
import { useRun } from '../components/Filters.js';
import { Resolved } from '../components/States.js';
import { useResource } from '../lib/useResource.js';

/**
 * The sources this system is connected to, and what the last run measured.
 *
 * There is no calibrate button, and there is no chart. The run derives its own
 * typical band as part of scoring, so what belongs here is that number and
 * where it came from — a histogram would be decoration on top of four figures
 * that say it better.
 */
export function Sources() {
  const run = useRun();
  const channels = useResource(() => api.channels(run), [run]);

  return (
    <Resolved resource={channels} what="las fuentes">
      {(data) => (
        <>
          <div className="card">
            <h2 className="card__title">Fuentes conectadas</h2>
            <p className="card__hint">
              Una entrada por fuente de la que este sistema lee. Todo lo de abajo sale de{' '}
              <code>config/ruleset.v1.json</code>, salvo lo medido, que sale de la corrida.
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
        . Un crédito que no la nombra falla <code>DESCRIPTOR_FOREIGN</code>, que descalifica.
      </p>

      <div className="section-title" style={{ marginTop: 8 }}>
        Configurado
      </div>
      <div className="table-wrap">
        <table>
          <tbody>
            <Setting name="Cadencia" value={channel.cadence} source="settlement.cadence" />
            <Setting
              name="Corte del día"
              value={channel.cutoff ?? 'medianoche'}
              source="settlement.cutoff"
            />
            <Setting
              name="Ventana"
              value={`T+${channel.window.fromBusinessDays} a T+${channel.window.toBusinessDays} días hábiles`}
              source="settlement.window"
            />
            <Setting
              name="Comisión admisible"
              value={`${pct(channel.admissibleBand[0])} – ${pct(channel.admissibleBand[1])}`}
              source="deductions.plausibleTotalBand"
              note="Es un portón, no un puntaje: afuera, la diferencia no puede ser comisión y el candidato se descarta."
            />
          </tbody>
        </table>
      </div>

      {!channel.declaresOwnBand && (
        <p className="banner banner--warn">
          No declara su propia banda, así que usa el default global, ancho a propósito porque no se
          sabe nada de ella todavía.
        </p>
      )}

      <div className="section-title">Medido en la última corrida</div>
      <Measured channel={channel} />
    </div>
  );
}

function Measured({ channel }: { channel: ChannelDto }) {
  if (channel.reportsOwnDeductions) {
    return (
      <p className="banner banner--info">
        Esta fuente informa sus propias comisiones, así que no hay nada que medir: el neto esperado
        se calcula sin mirar el depósito y la coincidencia exacta vale <code>AMOUNT_EXACT</code>.
      </p>
    );
  }

  if (!channel.calibration) {
    return (
      <p className="muted">
        {channel.settlements === 0
          ? 'La última corrida no tuvo liquidaciones de esta fuente.'
          : `Sólo ${channel.settlements} liquidaciones: con menos de tres no se puede decir qué es habitual, así que nadie sumó puntos por eso.`}
      </p>
    );
  }

  const cal = channel.calibration;

  return (
    <>
      <div className="table-wrap">
        <table>
          <tbody>
            <Setting
              name="Comisión habitual"
              value={`${pct(cal.typicalBand[0])} – ${pct(cal.typicalBand[1])}`}
              source="derivado de la corrida"
              note="Mediana ± un desvío sobre las liquidaciones que cruzaron. Sólo suma puntos; no descarta nada."
            />
            <Setting
              name="Mediana"
              value={pct(cal.median)}
              source={`sobre ${cal.settlements} liquidaciones`}
            />
            <Setting
              name="Desvío"
              value={`${(cal.deviation * 100).toFixed(3).replace('.', ',')} puntos`}
              source="poblacional"
            />
            {channel.observed && (
              <Setting
                name="Rango observado"
                value={`${pct(channel.observed.lowest)} – ${pct(channel.observed.highest)}`}
                source={`${channel.observed.count} tasas implícitas`}
              />
            )}
          </tbody>
        </table>
      </div>

      <p className="faint">
        Esta banda no está en la configuración y no debería estarlo: se mide sobre las
        liquidaciones que ya cruzaron, en una segunda pasada que sólo suma puntos. Como no puede
        rechazar nada, usar los datos de la propia corrida no es circular — y cada corrida queda
        juzgada contra su propio período en vez de contra el que alguien midió por última vez.
      </p>
    </>
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
      <td style={{ width: 190 }}>{name}</td>
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
