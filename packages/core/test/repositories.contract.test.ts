import { InMemoryMovementRepository } from '../src/testing/in-memory-repositories.js';
import { movementRepositoryContract } from '../src/testing/movement-repository.contract.js';

/**
 * F01-T12. One suite, every implementation. When the Postgres repository
 * lands, it is one more line here — and the suite tells us whether it really
 * honours the contract, not just its shape.
 */
movementRepositoryContract('in-memory', () => new InMemoryMovementRepository());
