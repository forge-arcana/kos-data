// mcp/retrieve.mjs — THE one retrieval engine (§1.11): everything that reads
// KOS data programmatically (verifyBrief, corpus-check, all MCP tools) goes
// through these pure functions. A data root is EITHER a filesystem path
// (private/customer root — has archive/) OR a CDN URL prefix (public root).
// Ref resolution follows plan §4.2's order exactly; on a public root a
// span=event ref older than the window resolves `unresolvable-publicly`,
// never a bare 404 (OM §8.2 asymmetry — the moat made visible).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const METRIC_RE = '(?:result|perf|form|cond|avail|market|meas|agg)\\.[a-z0-9_]+';

// ---------------------------------------------------------------------------
// Ref grammar (OM §3.6)
// ---------------------------------------------------------------------------

/**
 * parseRef(ref) — {namespace, span, sport, event?, entity?, metric, date?, scope?}
 * or null when the ref does not parse.
 */
export function parseRef(ref) {
  const m = String(ref).match(/^(kos|kod):([^#]+)#(.*)$/);
  if (!m) return null;
  const [, namespace, path, rhs] = m;
  const rm = rhs.match(new RegExp(`^((?:athlete|team|venue|official|competition)/[a-z0-9-]+)?\\.(${METRIC_RE})(?:@(.+))?$`));
  if (!rm) return null;
  const [, entity, metric, scope] = rm;
  const segs = path.split('/');
  const sport = segs[0];
  if (segs[1] === 'asof' && segs.length === 3) {
    return { namespace, span: 'asof', sport, entity: entity ?? null, metric, date: segs[2], scope: scope ?? null };
  }
  if (segs[1] === 'career' && segs.length === 3) {
    if (scope) return null;
    return { namespace, span: 'career', sport, entity: entity ?? null, metric, date: segs[2] };
  }
  if (scope === 'season') {
    if (segs.length < 2 || segs.length > 3) return null;
    return { namespace, span: 'season', sport, event: path, entity: entity ?? null, metric };
  }
  if (scope) return null;
  if (segs.length < 4) return null;
  return { namespace, span: 'event', sport, event: path, entity: entity ?? null, metric };
}

// ---------------------------------------------------------------------------
// Root access (filesystem or CDN)
// ---------------------------------------------------------------------------

const isUrl = (root) => /^https?:\/\//.test(root);

export function isPrivateRoot(root) {
  return !isUrl(root) && existsSync(join(root, 'archive', 'observations'));
}

/** getJson(root, relPath, cache?) — parsed JSON or null (missing/404). */
export async function getJson(root, relPath, cache = null) {
  const key = `${root}|${relPath}`;
  if (cache?.has(key)) return cache.get(key);
  let out = null;
  if (isUrl(root)) {
    try {
      const res = await fetch(`${root.replace(/\/$/, '')}/${relPath}`, {
        headers: { 'user-agent': 'kos-retrieve/0.1' },
      });
      if (res.status === 200) out = await res.json();
    } catch {
      out = null;
    }
  } else {
    const p = join(root, relPath);
    if (existsSync(p)) out = JSON.parse(readFileSync(p, 'utf8'));
  }
  cache?.set(key, out);
  return out;
}

function scanNdjson(root, relPath, predicate) {
  const p = join(root, relPath);
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (predicate(row)) return row;
  }
  return null;
}

/** Hot path of an event/group id (OM §5.3 — the ONE flattening). */
export function hotPath(id) {
  const [sport, season, competition, ...rest] = id.split('/');
  const leaf = rest.join('__');
  return `${sport}/v1/events/${season}/${competition}${leaf ? '/' + leaf : ''}.json`;
}

// ---------------------------------------------------------------------------
// Typed fetchers
// ---------------------------------------------------------------------------

export async function getDossier(sport, eventId, root, cache = null) {
  return getJson(root, hotPath(eventId), cache);
}

export async function getCard(sport, entityId, root, cache = null) {
  const [type, slug] = entityId.split('/');
  const kind = type === 'team' ? 'teams' : 'athletes';
  return getJson(root, `${sport}/v1/${kind}/${slug}.json`, cache);
}

export async function getSeries(sport, entityId, metric, root, cache = null) {
  const card = await getCard(sport, entityId, root, cache);
  return card?.series?.[metric] ?? null;
}

export async function getCoverage(sport, root, cache = null) {
  const pack = await getJson(root, `ontology/${sport}.pack.json`, cache);
  return pack?.coverage ?? null;
}

// ---------------------------------------------------------------------------
// resolveRef (plan §4.2 resolution order)
// ---------------------------------------------------------------------------

/**
 * resolveRef(ref, root, opts?) → {status, row?, verifiedAt?}
 * status: ok | unresolvable | unresolvable-publicly | bad-ref
 * row: the (re-inflated) warm-shaped row; verifiedAt: "rows" | "card".
 */
export async function resolveRef(ref, root, opts = {}) {
  const parsed = typeof ref === 'string' ? parseRef(ref) : ref;
  if (!parsed) return { status: 'bad-ref' };
  const cache = opts.cache ?? null;
  const todayISO = opts.todayISO ?? new Date().toISOString().slice(0, 10);
  const priv = isPrivateRoot(root);

  if (parsed.span === 'event') {
    const { sport, event, entity, metric } = parsed;
    if (priv) {
      const [s, season, competition] = event.split('/');
      const row = scanNdjson(
        root,
        join('archive', 'observations', s, season, `${competition}.ndjson`),
        (r) => r.span === 'event' && r.event === event && (r.entity ?? null) === entity && r.metric === metric,
      );
      return row ? { status: 'ok', row, verifiedAt: 'rows' } : { status: 'unresolvable' };
    }
    // Public: the group dossier (event id may carry a trailing session segment).
    let dossier = await getJson(root, hotPath(event), cache);
    let session = null;
    if (!dossier && event.split('/').length >= 5) {
      const group = event.split('/').slice(0, -1).join('/');
      session = event.split('/').at(-1);
      dossier = await getJson(root, hotPath(group), cache);
    }
    if (!dossier) {
      const season = event.split('/')[1];
      const windowStart = new Date(new Date(todayISO) - 90 * 86400000).toISOString().slice(0, 10);
      const old = String(season).slice(0, 4) < windowStart.slice(0, 4) || String(season).slice(0, 4) < todayISO.slice(0, 4);
      return { status: old ? 'unresolvable-publicly' : 'unresolvable' };
    }
    const hit = (dossier.rows ?? []).find(
      (r) =>
        (session === null || r.session === session) &&
        (r.entity ?? null) === entity &&
        r.metric === metric,
    );
    if (!hit) return { status: 'unresolvable' };
    return {
      status: 'ok',
      verifiedAt: 'rows',
      row: {
        date: dossier.date,
        sport,
        span: 'event',
        event,
        ...(entity ? { entity } : {}),
        metric,
        value: hit.value,
        ...(hit.unit ? { unit: hit.unit } : {}),
        source: hit.source,
      },
    };
  }

  if (parsed.span === 'asof') {
    const { sport, entity, metric, date, scope } = parsed;
    if (priv) {
      const row = scanNdjson(
        root,
        join('archive', 'state', sport, `${date.slice(0, 4)}.ndjson`),
        (r) => r.span === 'asof' && r.date === date && r.entity === entity && r.metric === metric && (r.event ?? null) === scope,
      );
      return row ? { status: 'ok', row, verifiedAt: 'rows' } : { status: 'unresolvable' };
    }
    // Public: card series, then scoped dossier's preEvent[].
    const series = await getSeries(sport, entity, metric, root, cache);
    const inSeries = (series ?? []).find((p) => p.date === date && (p.event ?? null) === scope);
    if (inSeries) {
      return {
        status: 'ok',
        verifiedAt: 'card',
        row: { date, sport, span: 'asof', ...(scope ? { event: scope } : {}), entity, metric, value: inSeries.value, source: 'card' },
      };
    }
    if (scope && scope.split('/').length >= 3) {
      const dossier = await getJson(root, hotPath(scope), cache);
      const hit = (dossier?.preEvent ?? []).find(
        (r) => r.date === date && r.entity === entity && r.metric === metric && (r.event ?? null) === scope,
      );
      if (hit) return { status: 'ok', verifiedAt: 'rows', row: { ...hit, sport, span: 'asof' } };
    }
    return { status: 'unresolvable-publicly' };
  }

  // season | career → aggregates file privately, card aggregates publicly.
  const { sport, entity, metric } = parsed;
  if (priv) {
    const row = scanNdjson(root, join('archive', 'aggregates', `${sport}.ndjson`), (r) =>
      parsed.span === 'season'
        ? r.span === 'season' && r.event === parsed.event && r.entity === entity && r.metric === metric
        : r.span === 'career' && r.date === parsed.date && r.entity === entity && r.metric === metric,
    );
    return row ? { status: 'ok', row, verifiedAt: 'rows' } : { status: 'unresolvable' };
  }
  const card = await getCard(sport, entity, root, cache);
  if (!card) return { status: 'unresolvable-publicly' };
  const scope = parsed.span === 'season' ? parsed.event : 'career';
  const hit = (card.aggregates ?? []).find((a) => a.provenance === 'sourced' && a.metric === metric && a.scope === scope);
  if (!hit) return { status: 'unresolvable-publicly' };
  return {
    status: 'ok',
    verifiedAt: 'card',
    row: {
      date: parsed.date ?? null,
      sport,
      span: parsed.span,
      ...(parsed.span === 'season' ? { event: parsed.event } : {}),
      entity,
      metric,
      value: hit.value,
      ...(hit.unit ? { unit: hit.unit } : {}),
      source: 'card',
    },
  };
}

/** loadPacks(dataRoot) — ontology/*.pack.json from a filesystem root. */
export function loadPacks(dataRoot) {
  const dir = join(dataRoot, 'ontology');
  const packs = new Map();
  if (!existsSync(dir)) return packs;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.pack.json')).sort()) {
    const pack = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    packs.set(pack.sport, pack);
  }
  return packs;
}
