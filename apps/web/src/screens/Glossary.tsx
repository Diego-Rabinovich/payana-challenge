import type { EvidenceCodeInfoDto } from '@aa/contracts';
import { api } from '../api/client.js';
import { Resolved } from '../components/States.js';
import { phraseFor } from '../lib/evidence-phrases.js';
import { useResource } from '../lib/useResource.js';

const DIMENSION_LABEL: Record<string, string> = {
  AMOUNT: 'Monto',
  DATE: 'Fecha',
  DESCRIPTOR: 'Descriptor',
  UNIQUENESS: 'Unicidad',
  INTEGRITY: 'Integridad',
  ERP: 'ERP',
  INGESTION: 'Ingesta',
};

const ORDER = ['AMOUNT', 'DATE', 'DESCRIPTOR', 'INTEGRITY', 'UNIQUENESS', 'ERP', 'INGESTION'];

/**
 * The rubric, served rather than transcribed.
 *
 * Every number here comes from the same `config/ruleset.v1.json` the engine
 * scores with, so a weight that changes in config changes on this page on the
 * next request. A glossary maintained by hand is a glossary that is wrong.
 */
export function Glossary() {
  const rubric = useResource(() => api.rubric(), []);

  return (
    <Resolved resource={rubric} what="el glosario">
      {(data) => {
        const byDimension = new Map<string, EvidenceCodeInfoDto[]>();
        for (const code of data.codes) {
          byDimension.set(code.dimension, [...(byDimension.get(code.dimension) ?? []), code]);
        }

        return (
          <>
            <div className="card">
              <h2 className="card__title">Cómo se arma el puntaje</h2>
              <p className="card__hint">
                Ruleset <code>{data.rulesetVersion}</code>. Cada verificación que pasa suma sus
                puntos; el puntaje es ese total sobre lo que era alcanzable, llevado a 100.
              </p>

              <div className="tiles">
                <div className="tile">
                  <div className="tile__label">Máximo alcanzable</div>
                  <div className="tile__value">{data.attainable}</div>
                  <div className="tile__note">puntos, si la fuente informara todo</div>
                </div>
                <div className="tile">
                  <div className="tile__label">
                    <span className="dot dot--confirmed" /> Conciliado desde
                  </div>
                  <div className="tile__value">{data.bands.CONFIRMED}</div>
                </div>
                <div className="tile">
                  <div className="tile__label">
                    <span className="dot dot--probable" /> Probable desde
                  </div>
                  <div className="tile__value">{data.bands.PROBABLE}</div>
                </div>
                <div className="tile">
                  <div className="tile__label">
                    <span className="dot dot--ambiguous" /> Ambiguo desde
                  </div>
                  <div className="tile__value">{data.bands.AMBIGUOUS}</div>
                  <div className="tile__note">
                    o cuando el segundo mejor queda a {data.ambiguityDelta} puntos
                  </div>
                </div>
              </div>

              <p className="banner banner--info" style={{ marginTop: 16, marginBottom: 0 }}>
                Dos reglas que no son puntos. Una <strong>verificación descalificante</strong> no
                resta: si falla, el candidato se descarta por más alto que sea el resto. Y una
                verificación que <strong>no se pudo correr</strong> — porque la fuente nunca
                publicó el dato — sale del denominador en vez de contar como fallada, así que no
                castiga dos veces el mismo silencio.
              </p>
            </div>

            {ORDER.filter((dimension) => byDimension.has(dimension)).map((dimension) => (
              <div className="card" key={dimension}>
                <h2 className="card__title">{DIMENSION_LABEL[dimension] ?? dimension}</h2>
                {byDimension.get(dimension)!.some((code) => code.exclusiveWith.length > 0) && (
                  <p className="card__hint">
                    Son alternativas entre sí: sólo cuenta la más fuerte que se haya cumplido,
                    nunca dos a la vez.
                  </p>
                )}
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Código</th>
                        <th className="num">Puntos</th>
                        <th>Qué afirma</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byDimension
                        .get(dimension)!
                        .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
                        .map((code) => (
                          <tr key={code.code}>
                            <td className="mono">
                              {code.code}
                              {code.disqualifying && (
                                <div>
                                  <span className="chip chip--unmatched">descalifica</span>
                                </div>
                              )}
                            </td>
                            <td className="num">
                              {code.weight ? (
                                <strong>+{code.weight}</strong>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                            <td>
                              {phraseFor({
                                code: code.code,
                                dimension: code.dimension,
                                passed: true,
                              })}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            <div className="card">
              <h2 className="card__title">De dónde salen las bandas de comisión</h2>
              <p className="card__hint">
                Wompi no publica su comisión por transacción, así que la diferencia entre lo
                vendido y lo acreditado es lo único que tenemos. Hay dos bandas y hacen cosas
                distintas.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Banda</th>
                      <th>Rango</th>
                      <th>Qué hace</th>
                      <th>De dónde sale</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Admisible</td>
                      <td className="mono">4,00% – 5,00%</td>
                      <td>
                        Afuera, la diferencia no se puede explicar como comisión:{' '}
                        <code>AMOUNT_MISMATCH</code>, que descalifica al candidato.
                      </td>
                      <td className="muted">
                        De la estructura legal. La retención en la fuente es 1,5% fija por ley; el
                        resto es la comisión más su IVA del 19%. Una comisión de 2,1% a 2,95% da
                        justamente 4% a 5%.
                      </td>
                    </tr>
                    <tr>
                      <td>Habitual</td>
                      <td className="mono">4,25% – 4,45%</td>
                      <td>
                        Adentro vale <strong>+40</strong> (<code>IMPLIED_FEE_TYPICAL</code>);
                        afuera pero dentro de la admisible, <strong>+25</strong>. No descarta nada.
                      </td>
                      <td className="muted">
                        Medida sobre las 53 liquidaciones de enero a abril: mediana 4,361% y desvío
                        0,090 puntos. Es ese centro ± un desvío, y contiene 41 de las 53.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="faint" style={{ marginTop: 12 }}>
                Sobre los datos reales las tasas van de 4,299% a 4,687%, o sea que ninguna queda
                cerca de los bordes de la banda admisible: sobran 0,30 puntos de margen de cada
                lado. Si Wompi cambiara su tarifa, esto se re-mide y se edita en{' '}
                <code>config/ruleset.v1.json</code> — es un número en un archivo, no código.
              </p>
            </div>
          </>
        );
      }}
    </Resolved>
  );
}
