// Circuit breaker pattern for external API calls
// States: CLOSED (normal) → OPEN (failing, reject calls) → HALF_OPEN (testing)
// In-memory per serverless invocation; with KV, persists across invocations.

const { isKVConfigured, kvGetJSON, kvSetJSON } = require('./_kv');

const DEFAULTS = {
  failureThreshold: 5,    // failures before opening
  cooldownMs: 60000,      // 60s before trying again
  halfOpenMax: 2,          // max test calls in half-open
};

// In-memory fallback (per invocation)
const circuits = {};

function getCircuit(name) {
  if (!circuits[name]) {
    circuits[name] = { state: 'CLOSED', failures: 0, lastFailure: 0, halfOpenAttempts: 0 };
  }
  return circuits[name];
}

async function loadCircuit(name) {
  const local = getCircuit(name);

  if (isKVConfigured()) {
    try {
      const remote = await kvGetJSON(`circuit:${name}`);
      if (remote && remote.state) {
        // Merge: use remote state as truth
        Object.assign(local, remote);
      }
    } catch {}
  }

  return local;
}

async function saveCircuit(name, circuit) {
  circuits[name] = circuit;

  if (isKVConfigured()) {
    try {
      await kvSetJSON(`circuit:${name}`, circuit, 300); // 5 min TTL
    } catch {}
  }
}

async function canExecute(name) {
  const cb = await loadCircuit(name);

  switch (cb.state) {
    case 'CLOSED':
      return true;

    case 'OPEN': {
      const elapsed = Date.now() - cb.lastFailure;
      if (elapsed >= DEFAULTS.cooldownMs) {
        cb.state = 'HALF_OPEN';
        cb.halfOpenAttempts = 0;
        await saveCircuit(name, cb);
        return true;
      }
      return false;
    }

    case 'HALF_OPEN':
      return cb.halfOpenAttempts < DEFAULTS.halfOpenMax;

    default:
      return true;
  }
}

async function recordSuccess(name) {
  const cb = await loadCircuit(name);
  cb.state = 'CLOSED';
  cb.failures = 0;
  cb.halfOpenAttempts = 0;
  await saveCircuit(name, cb);
}

async function recordFailure(name) {
  const cb = await loadCircuit(name);

  cb.failures++;
  cb.lastFailure = Date.now();

  if (cb.state === 'HALF_OPEN') {
    // Failed during test → reopen
    cb.state = 'OPEN';
    cb.halfOpenAttempts = 0;
  } else if (cb.failures >= DEFAULTS.failureThreshold) {
    cb.state = 'OPEN';
  }

  await saveCircuit(name, cb);
}

async function getStatus(name) {
  const cb = await loadCircuit(name);
  return {
    name,
    state: cb.state,
    failures: cb.failures,
    lastFailure: cb.lastFailure ? new Date(cb.lastFailure).toISOString() : null,
  };
}

// Wrap an async function with circuit breaker protection
function withCircuitBreaker(name, fn) {
  return async function (...args) {
    const allowed = await canExecute(name);
    if (!allowed) {
      const cb = getCircuit(name);
      const retryIn = Math.ceil((DEFAULTS.cooldownMs - (Date.now() - cb.lastFailure)) / 1000);
      throw new Error(`Service "${name}" unavailable (circuit open). Retry in ${retryIn}s.`);
    }

    try {
      const result = await fn(...args);
      await recordSuccess(name);
      return result;
    } catch (err) {
      await recordFailure(name);
      throw err;
    }
  };
}

module.exports = {
  canExecute,
  recordSuccess,
  recordFailure,
  getStatus,
  withCircuitBreaker,
};
