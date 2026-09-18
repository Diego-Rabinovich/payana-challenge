import type { SourceId } from '../domain/ids.js';
import type { SourceConnector } from './source-connector.js';

/**
 * Resolves a configured source id to its connector. Backed by
 * config/sources.json, so declaring a source is configuration, not code.
 */
export interface ConnectorRegistry {
  get(sourceId: SourceId): SourceConnector;
  ids(): readonly SourceId[];
}
