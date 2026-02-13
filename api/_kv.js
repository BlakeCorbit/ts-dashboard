// Vercel KV (Upstash Redis) client via REST API
// Env vars: KV_REST_API_URL, KV_REST_API_TOKEN
// Graceful degradation: all functions return null/empty when not configured

function isKVConfigured() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvExec(command) {
  if (!isKVConfigured()) return null;

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error(`KV error ${resp.status}: ${body.substring(0, 200)}`);
    return null;
  }

  const data = await resp.json();
  return data.result !== undefined ? data.result : null;
}

// Pipeline: execute multiple commands in one request
async function kvPipeline(commands) {
  if (!isKVConfigured()) return commands.map(() => null);

  const url = `${process.env.KV_REST_API_URL}/pipeline`;
  const token = process.env.KV_REST_API_TOKEN;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (!resp.ok) return commands.map(() => null);
  const data = await resp.json();
  return Array.isArray(data) ? data.map((d) => d.result) : commands.map(() => null);
}

// ---- String operations ----

async function kvGet(key) {
  return kvExec(['GET', key]);
}

async function kvSet(key, value, exSeconds) {
  const cmd = ['SET', key, typeof value === 'string' ? value : JSON.stringify(value)];
  if (exSeconds) cmd.push('EX', String(exSeconds));
  return kvExec(cmd);
}

async function kvDel(...keys) {
  return kvExec(['DEL', ...keys]);
}

// ---- List operations ----

async function kvLpush(key, ...values) {
  return kvExec(['LPUSH', key, ...values]);
}

async function kvLrange(key, start, stop) {
  return kvExec(['LRANGE', key, String(start), String(stop)]);
}

async function kvLtrim(key, start, stop) {
  return kvExec(['LTRIM', key, String(start), String(stop)]);
}

// ---- Hash operations ----

async function kvHset(key, fieldValues) {
  // fieldValues: { field1: val1, field2: val2 }
  const args = ['HSET', key];
  for (const [f, v] of Object.entries(fieldValues)) {
    args.push(f, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return kvExec(args);
}

async function kvHget(key, field) {
  return kvExec(['HGET', key, field]);
}

async function kvHgetall(key) {
  const result = await kvExec(['HGETALL', key]);
  if (!result) return {};
  // Upstash returns array: [field, value, field, value, ...]
  if (Array.isArray(result)) {
    const obj = {};
    for (let i = 0; i < result.length; i += 2) {
      obj[result[i]] = result[i + 1];
    }
    return obj;
  }
  return result;
}

// ---- Key operations ----

async function kvExpire(key, seconds) {
  return kvExec(['EXPIRE', key, String(seconds)]);
}

async function kvKeys(pattern) {
  const result = await kvExec(['KEYS', pattern]);
  return Array.isArray(result) ? result : [];
}

// ---- Convenience: JSON get/set ----

async function kvGetJSON(key) {
  const val = await kvGet(key);
  if (val === null) return null;
  try { return JSON.parse(val); } catch { return val; }
}

async function kvSetJSON(key, value, exSeconds) {
  return kvSet(key, JSON.stringify(value), exSeconds);
}

// ---- Convenience: capped list (push + trim) ----

async function kvListPush(key, value, maxLen) {
  const val = typeof value === 'string' ? value : JSON.stringify(value);
  if (maxLen) {
    return kvPipeline([
      ['LPUSH', key, val],
      ['LTRIM', key, '0', String(maxLen - 1)],
    ]);
  }
  return kvLpush(key, val);
}

module.exports = {
  isKVConfigured,
  kvGet,
  kvSet,
  kvDel,
  kvLpush,
  kvLrange,
  kvLtrim,
  kvHset,
  kvHget,
  kvHgetall,
  kvExpire,
  kvKeys,
  kvGetJSON,
  kvSetJSON,
  kvListPush,
  kvPipeline,
};
