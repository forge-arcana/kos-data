// mcp/verify.mjs — verifyBrief(brief, dataRoot, packs): the deterministic gate
// (HM §1.5, ALL 11 checks — a closed list; Phase 4 only wraps this as the MCP
// tool `verify_brief`). Pure function of (brief, data root, packs); zero LLM.
// packs === null ⇒ loaded from <dataRoot>/ontology/*.pack.json.
// Reads data ONLY through mcp/retrieve.mjs (§1.11).

import { resolveRef, parseRef, loadPacks, getDossier, isPrivateRoot } from './retrieve.mjs';

export async function verifyBrief(brief, dataRoot, packs) {
  if (packs == null) packs = loadPacks(dataRoot);
  const cache = new Map();
  const out = { ok: true, perClaim: [], missingDisclosures: [], provenanceNotes: [] };
  const fail = () => {
    out.ok = false;
  };

  // ---- Check 1: ref grammar + single namespace ----------------------------
  const namespaces = new Set();
  const badRefs = [];
  for (const ref of allRefs(brief)) {
    const parsed = parseRef(ref);
    if (!parsed) badRefs.push(ref);
    else namespaces.add(parsed.namespace);
  }
  if (badRefs.length) {
    fail();
    out.perClaim.push({ id: null, status: 'rejected', reason: 'bad-ref-grammar', refs: badRefs });
    return out;
  }
  if (namespaces.size > 1) {
    fail();
    out.reason = 'cross-vertical-unsupported';
    return out;
  }

  let privatelyResolved = 0;
  const claimRows = new Map(); // claim id → resolved rows (for checks 9/7)

  for (const claim of brief.claims ?? []) {
    const per = { id: claim.id, status: 'verified', refResults: [] };
    const values = claim.values ?? [{ name: null, value: claim.value, unit: claim.unit, refs: claim.refs ?? [] }];
    const rows = [];
    let rejected = null;
    let anyPublicOnly = false;

    for (const v of values) {
      if (!Array.isArray(v.refs) || v.refs.length === 0) {
        rejected = { reason: 'refs-empty' };
        break;
      }
      let matched = false;
      let sawResolvable = false;
      for (const ref of v.refs) {
        // ---- Check 2: resolution ------------------------------------------
        const res = await resolveRef(ref, dataRoot, { cache });
        per.refResults.push({ ref, status: res.status });
        if (res.status === 'unresolvable-publicly') {
          anyPublicOnly = true;
          continue;
        }
        if (res.status !== 'ok') continue;
        sawResolvable = true;
        rows.push({ ref, row: res.row, verifiedAt: res.verifiedAt });
        // ---- Check 3: value match (A-shaped values only) ------------------
        if (!claim.derivation && !claim.inlineFormula) {
          if (valueMatches(v.value, res.row.value, toleranceFor(packs, res.row))) matched = true;
        } else {
          matched = true; // B claims match at derivation depth (check 5/6)
        }
      }
      if (!matched) {
        if (!sawResolvable && anyPublicOnly) {
          privatelyResolved++;
          continue; // claim survives; provenance note added below (check 3)
        }
        rejected = sawResolvable
          ? { reason: 'value-mismatch', claimed: v.value }
          : { reason: 'unresolvable', refs: v.refs };
        break;
      }
    }

    // ---- Check 4: tier recomputation --------------------------------------
    if (!rejected) {
      const recomputed = claim.inlineFormula || claim.derivation ? 'B' : rowsMatchClaim(values, rows, packs) ? 'A' : 'C';
      per.recomputedTier = recomputed;
      per.verifiedAt = rows.some((r) => r.verifiedAt === 'card') ? 'card' : 'rows';

      // ---- Check 5: derivation re-execution -------------------------------
      if (claim.derivation && !rejected) {
        const err = await checkDerivation(claim, rows, packs, dataRoot, cache);
        if (err) rejected = err;
      }
      // ---- Check 6: inline formula ----------------------------------------
      if (claim.inlineFormula && !rejected) {
        const err = await checkInlineFormula(claim, dataRoot, cache, packs);
        if (err) rejected = err;
      }
      // ---- Check 8: sample size -------------------------------------------
      if (!rejected && (claim.derivation || isAggregateClaim(claim))) {
        if (claim.rowCount == null || claim.window == null) {
          rejected = { reason: 'aggregate-missing-rowcount-or-window' };
        } else {
          const minN = minNFor(claim.derivation, packs);
          if (minN != null && claim.rowCount < minN) {
            const canonical = `low sample: ${claim.rowCount} rows (pack minimum for ${claim.derivation.split('@')[0]} is ${minN})`;
            if (!(claim.disclosure ?? '').includes('low sample:')) {
              out.missingDisclosures.push({ claim: claim.id, requiredDisclosure: canonical });
              fail();
            }
          }
        }
      }
    }

    if (rejected) {
      per.status = 'rejected';
      Object.assign(per, rejected);
      fail();
    }
    claimRows.set(claim.id, rows);
    out.perClaim.push(per);
  }

  if (privatelyResolved > 0) {
    out.provenanceNotes.push(`${privatelyResolved} refs resolve only against the private tier`);
  }

  // ---- Check 7: comparative window check ----------------------------------
  if (brief.classification?.archetype === 'comparative') {
    const derivedClaims = (brief.claims ?? []).filter((c) => c.derivation && c.window);
    for (let i = 0; i < derivedClaims.length; i++) {
      for (let j = i + 1; j < derivedClaims.length; j++) {
        const a = derivedClaims[i];
        const b = derivedClaims[j];
        if (a.derivation.split('@')[0] !== b.derivation.split('@')[0]) continue;
        const ea = firstEntity(a);
        const eb = firstEntity(b);
        if (!ea || !eb || ea === eb) continue;
        if (JSON.stringify(a.window) !== JSON.stringify(b.window)) {
          const canonical = `windows differ: ${ea} ${a.window.from}–${a.window.to} (${a.rowCount} rows) vs ${eb} ${b.window.from}–${b.window.to} (${b.rowCount} rows)`;
          for (const c of [a, b]) {
            if (!(c.disclosure ?? '').includes('windows differ:')) {
              out.missingDisclosures.push({ claim: c.id, requiredDisclosure: canonical });
              fail();
            }
          }
        }
      }
    }
  }

  // ---- Check 9: strength grants (causal briefs) ---------------------------
  if (brief.classification?.archetype === 'causal') {
    const order = { contextual: 0, contributing: 1, direct: 2, determinative: 3 };
    for (const factor of brief.explanation ?? []) {
      const rows = (factor.claims ?? []).flatMap((id) => claimRows.get(id) ?? []).map((r) => r.row);
      const granted = grantStrength(rows, brief, packs);
      if (order[factor.strength] > order[granted]) {
        fail();
        out.perClaim.push({
          id: null,
          status: 'rejected',
          reason: `strength-exceeds-grant: factor "${factor.factor}" claims ${factor.strength}, granted ${granted}`,
        });
      }
    }
    // ---- Check 10: completeness (causal) ----------------------------------
    const eventId = (brief.resolved?.events ?? [])[0];
    if (eventId) {
      const sport = eventId.split('/')[0];
      const group = eventId.split('/').length >= 5 ? eventId.split('/').slice(0, -1).join('/') : eventId;
      const dossier = await getDossier(sport, group, dataRoot, cache);
      const covered = new Set((brief.cannot_show ?? []).map((c) => c.family));
      for (const gap of dossier?.gaps ?? []) {
        if (gap.status !== 'full' && !covered.has(gap.family)) {
          fail();
          out.missingDisclosures.push({
            claim: null,
            requiredDisclosure: `cannot_show must include family "${gap.family}" (${gap.status}): ${gap.note}`,
          });
        }
      }
    }
  }
  // Check 10 (attribute): a gapped metric must be the refusal object.
  if (brief.classification?.archetype === 'attribute' && !brief.refusal) {
    for (const metric of brief.resolved?.metrics ?? []) {
      for (const pack of packs.values()) {
        const decl = pack.metrics?.[metric];
        if (decl?.status === 'unmeasurable') {
          fail();
          out.perClaim.push({ id: null, status: 'rejected', reason: `attribute-on-gapped-metric: ${metric} requires the refusal object` });
        }
      }
    }
  }

  // ---- Check 11: external hygiene -----------------------------------------
  const allowedExternal = new Set(['name', 'license', 'url', 'description']);
  for (const ext of brief.external ?? []) {
    const extra = Object.keys(ext).filter((k) => !allowedExternal.has(k));
    if (extra.length || Object.values(ext).some((v) => typeof v === 'number')) {
      fail();
      out.perClaim.push({ id: null, status: 'rejected', reason: `external-hygiene: pointer-only fields allowed, got ${extra.join(',') || 'numeric value'}` });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allRefs(brief) {
  const refs = [];
  for (const claim of brief.claims ?? []) {
    for (const r of claim.refs ?? []) refs.push(r);
    for (const v of claim.values ?? []) for (const r of v.refs ?? []) refs.push(r);
    for (const input of Object.values(claim.inlineFormula?.inputs ?? {})) refs.push(input);
  }
  return refs;
}

function toleranceFor(packs, row) {
  const pack = packs.get(row.sport);
  return pack?.metrics?.[row.metric]?.tolerance ?? null;
}

/** Check-3 rule: exact for strings/booleans; numbers within pack tolerance OR rounding allowance. */
export function valueMatches(claimed, actual, tolerance) {
  if (typeof actual !== 'number' || typeof claimed !== 'number') return claimed === actual;
  if (claimed === actual) return true;
  const decimals = String(claimed).includes('.') ? String(claimed).split('.')[1].length : 0;
  const rounding = 0.5 * 10 ** -decimals;
  const tol = Math.max(tolerance ?? 0, rounding);
  return Math.abs(actual - claimed) <= tol;
}

function rowsMatchClaim(values, rows, packs) {
  if (!rows.length) return false;
  return values.every((v) =>
    rows.some((r) => valueMatches(v.value, r.row.value, toleranceFor(packs, r.row))),
  );
}

function isAggregateClaim(claim) {
  return claim.rowCount != null || claim.window != null;
}

function minNFor(derivation, packs) {
  if (!derivation) return null;
  const id = derivation.split('@')[0];
  for (const pack of packs.values()) {
    if (pack.derivations?.[id]?.minN != null) return pack.derivations[id].minN;
  }
  return null;
}

function firstEntity(claim) {
  for (const ref of [...(claim.refs ?? []), ...(claim.values ?? []).flatMap((v) => v.refs ?? [])]) {
    const p = parseRef(ref);
    if (p?.entity) return p.entity;
  }
  return null;
}

/**
 * Check 5 — re-execute the pack derivation at the named packVersion.
 * Card-depth rule (decided): on a PUBLIC root a derived aggregate citing card
 * evidence verifies against the card's committed value (verifiedAt: "card");
 * on a private root the formula re-executes over the constituent rows.
 */
async function checkDerivation(claim, rows, packs, dataRoot, cache) {
  const [id, version] = String(claim.derivation).split('@');
  let decl = null;
  for (const pack of packs.values()) {
    if (pack.derivations?.[id]) {
      if (version && pack.packVersion !== version) {
        return { reason: `derivation-version-mismatch: pack is ${pack.packVersion}, claim cites ${version}` };
      }
      decl = pack.derivations[id];
    }
  }
  if (!decl) return { reason: `unknown-derivation: ${id}` };
  const claimedValue = claim.value ?? claim.values?.[0]?.value;

  if (!isPrivateRoot(dataRoot)) {
    // Card depth: any resolved row (the card aggregate) must match the claim.
    const ok = rows.some((r) => valueMatches(claimedValue, r.row.value, null));
    return ok && rows.length ? null : { reason: 'derivation-card-mismatch', claimed: claimedValue };
  }

  const rowValues = rows.map((r) => r.row);
  const computed = executeFormula(decl.formula, rowValues);
  if (computed === null) return { reason: `derivation-not-executable: ${decl.formula}` };
  return valueMatches(claimedValue, computed, claim.tolerance ?? decl.tolerance ?? null)
    ? null
    : { reason: 'derivation-mismatch', expected: computed, claimed: claimedValue };
}

/** The closed set of executable pack formulas (grows per sport onboarding). */
export function executeFormula(formula, rows) {
  if (formula === 'count(value=true)') return rows.filter((r) => r.value === true).length;
  if (formula === 'count(value<=3)') return rows.filter((r) => typeof r.value === 'number' && r.value <= 3).length;
  if (formula === 'count(value=true)/count(*)' || formula === 'wins/starts') {
    if (!rows.length) return null;
    return Math.round((rows.filter((r) => r.value === true).length / rows.length) * 10000) / 10000;
  }
  if (formula === 'count-by-winner-over-shared-events') {
    const wins = {};
    for (const r of rows) {
      if (r.metric === 'result.winner' && r.value === true) wins[r.entity] = (wins[r.entity] ?? 0) + 1;
    }
    return Object.values(wins).reduce((a, b) => a + b, 0);
  }
  if (formula === 'last-n(5)') return rows.slice(-5).length;
  return null;
}

// ---- Check 6: inline formula (closed grammar, recursive descent) ----------

async function checkInlineFormula(claim, dataRoot, cache, packs) {
  const f = claim.inlineFormula;
  if (!f?.expr || typeof f.inputs !== 'object') return { reason: 'inline-formula-malformed' };
  const inputs = {};
  for (const [name, ref] of Object.entries(f.inputs)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) return { reason: `inline-formula-bad-var: ${name}` };
    const res = await resolveRef(ref, dataRoot, { cache });
    if (res.status !== 'ok') return { reason: `inline-formula-input-unresolvable: ${ref}` };
    if (typeof res.row.value !== 'number') return { reason: `inline-formula-input-not-numeric: ${ref}` };
    inputs[name] = res.row.value;
  }
  let computed;
  try {
    computed = evaluateExpr(f.expr, inputs);
  } catch (err) {
    return { reason: `inline-formula: ${err.message}` };
  }
  const claimedValue = claim.value ?? claim.values?.[0]?.value;
  return valueMatches(claimedValue, computed, null)
    ? null
    : { reason: 'inline-formula-mismatch', expected: computed, claimed: claimedValue };
}

/**
 * evaluateExpr(expr, inputs) — the HM §1.5 check-6 closed grammar:
 *   expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)*
 *   factor := '-'? ( NUMBER | VAR | '(' expr ')' )
 * No functions, no exponent. Division by zero throws.
 */
export function evaluateExpr(expr, inputs) {
  let pos = 0;
  const s = String(expr);
  const peek = () => {
    while (s[pos] === ' ') pos++;
    return s[pos];
  };
  const parseExpr = () => {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = s[pos++];
      const rhs = parseTerm();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  };
  const parseTerm = () => {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = s[pos++];
      const rhs = parseFactor();
      if (op === '/') {
        if (rhs === 0) throw new Error('division by zero');
        v = v / rhs;
      } else {
        v = v * rhs;
      }
    }
    return v;
  };
  const parseFactor = () => {
    let neg = false;
    if (peek() === '-') {
      neg = true;
      pos++;
    }
    let v;
    if (peek() === '(') {
      pos++;
      v = parseExpr();
      if (peek() !== ')') throw new Error('unbalanced parentheses');
      pos++;
    } else {
      const rest = s.slice(pos);
      const num = rest.match(/^\d+(\.\d+)?/);
      const varm = rest.match(/^[a-z][a-z0-9_]*/);
      if (num) {
        v = Number(num[0]);
        pos += num[0].length;
      } else if (varm) {
        if (!(varm[0] in inputs)) throw new Error(`unknown var ${varm[0]}`);
        v = inputs[varm[0]];
        pos += varm[0].length;
      } else {
        throw new Error(`parse error at "${s.slice(pos)}"`);
      }
    }
    return neg ? -v : v;
  };
  const result = parseExpr();
  while (s[pos] === ' ') pos++;
  if (pos !== s.length) throw new Error(`trailing input "${s.slice(pos)}"`);
  return result;
}

// ---- Check 9: strength grant table (HM §1.3) ------------------------------

function grantStrength(rows, brief, packs) {
  if (!rows.length) return 'contextual';
  const events = new Set(brief.resolved?.events ?? []);
  const eventGroups = new Set([...events].map((e) => (e.split('/').length >= 5 ? e.split('/').slice(0, -1).join('/') : e)));
  const inThisEvent = (row) => {
    if (!row.event) return false;
    const g = row.event.split('/').length >= 5 ? row.event.split('/').slice(0, -1).join('/') : row.event;
    return events.has(row.event) || eventGroups.has(g);
  };
  for (const row of rows) {
    const pack = packs.get(row.sport);
    if ((pack?.determinative ?? []).includes(row.metric)) return 'determinative';
  }
  if (rows.some((r) => r.metric.startsWith('result.') && inThisEvent(r))) return 'direct';
  if (
    rows.some(
      (r) =>
        (r.metric.startsWith('perf.') && inThisEvent(r)) ||
        r.metric.startsWith('form.') ||
        r.metric.startsWith('market.') ||
        r.metric.startsWith('avail.'),
    )
  ) {
    return 'contributing';
  }
  return 'contextual';
}
