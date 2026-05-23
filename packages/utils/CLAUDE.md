# @launchkit/utils

**Responsibility:** Pure cross-cutting helpers (Result, pipe/flow, renderTemplate, redactSecrets, ids) + shared effect interfaces (Clock, IdGen).

**Public API (barrel `src/index.ts`):** ok, err, isOk, isErr, map, mapErr, andThen, unwrapOr, pipe, flow, renderTemplate, redactSecrets, Clock, createSystemClock, createFixedClock, IdGen, createCryptoIdGen, createSequentialIdGen.

**Depends on:** none (pure TypeScript)

**Effects owned:** none

**Local rules:** Everything here is pure or an interface -- no concrete IO. createSequentialIdGen is the test fake; createCryptoIdGen is production.
