interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Spain public procurement MCP — PLACSP tender notices (keyless).
 *
 * Wraps the official ATOM syndication feed of Spain's national procurement
 * platform PLACSP (Plataforma de Contratación del Sector Público,
 * contrataciondelestado.es), published by the Ministerio de Hacienda:
 *   https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom
 *
 * The feed carries ~185 tender notices (licitaciones) per page, each entry
 * embedding a full CODICE/UBL XML detail block (cac-place-ext:ContractFolderStatus)
 * with buyer, budget amounts, CPV codes, status, procedure, and submission
 * deadline. Older pages are reachable via <link rel="next"> (timestamped
 * archive URLs, ~185 entries each).
 *
 * Cloudflare Workers have no DOMParser, so entries are parsed with targeted
 * regex/string slicing (same approach as the gdacs feed pack) — no XML parser
 * dependency.
 *
 * FEED SIZE / CACHING (fleet #2769): the first page started at ~7.3MB and
 * grew to ~12MB, 35-52s to fetch from outside Cloudflare — close enough to
 * the Worker's own 50s budget that a slow day times out, and every distinct
 * search query re-paid that fetch independently (the gateway's own result
 * cache is keyed on exact tool args, so a "software" search and a "limpieza"
 * search never share one, even though they need the SAME underlying page).
 *
 * The gateway injects its one shared KV namespace as `_cacheKv`
 * (injectCacheKv, see pack-manifest.json + pack-types.ts), and every page
 * fetch below goes through a cache-aside wrapper keyed on the page URL —
 * not on the caller's query — so one slow fetch per TTL window serves every
 * caller, on every Cloudflare PoP, regardless of what they searched for. KV
 * rather than the Workers Cache API because Cache API is per-colo: a caller
 * landing on a different edge location would still pay the full cold fetch.
 * Per fleet #2754, never a bare module-scope variable either — that is baked
 * into one isolate and gone the moment it recycles. A missing/absent binding
 * (standalone or npm builds carry no gateway bindings) degrades cleanly to
 * the old uncached live fetch; a KV read/write failure is swallowed the same
 * way, since caching is an optimization and must never be why a call fails.
 * A live-fetch failure with NO usable cached fallback stays exactly the loud
 * error it always was — never a silently empty result.
 *
 * All tools return shaped, COMPACT, LLM-friendly objects (never raw entry XML)
 * and never throw — fetch/parse failures resolve to { error, retry_hint }.
 * English keys; Spanish free-text values (titles, buyer names) pass through
 * as-is.
 */


const FEED_URL =
  'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
// PLACSP serves large syndication files; present a plain browser UA.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// PLACSP serves the feed uncompressed (no Content-Encoding) and response
// times vary widely (observed 17-52s from outside CF, 11.96MB on 2026-10-07 —
// grown from the 7.3MB this used to say); allow 50s per page fetch — the
// Worker's own wall-clock ceiling, not a margin under it. The cache below is
// what keeps most callers off this path entirely.
const FETCH_TIMEOUT_MS = 50_000;
const MAX_PAGES = 3;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SOURCE =
  'PLACSP — Plataforma de Contratación del Sector Público (contrataciondelestado.es official syndication feed)';

// -- feed-page cache (KV, injected as _cacheKv) ------------------------------
//
// The live/current page (FEED_URL itself) changes continuously — new
// notices, status updates — so it gets a short freshness window amortizing
// the ~35-52s/12MB cold fetch across every caller inside it. Archive pages
// (reached via <link rel="next">, a timestamped URL) are closed history in
// practice — PLACSP does not rewrite a page once superseded — so they get a
// much longer one; re-validating 12MB of unchanging archive every 12 minutes
// would be pure waste.
const CURRENT_PAGE_FRESH_SEC = 12 * 60; // 12 min
const ARCHIVE_PAGE_FRESH_SEC = 24 * 60 * 60; // 24h — archive pages don't change once published
// How much longer, past its freshness window, a copy stays usable as a
// fallback when a live refetch fails. A 1h-old current-page copy is far more
// useful to a caller than a loud timeout; this is the outer bound on how old
// "still useful" is allowed to be before we stop serving it as a success.
const STALE_MAX_SEC = 60 * 60; // 1h
// KV's own deletion horizon — generous so a copy outlives both windows above
// with room to spare; KV entries are cheap and the feed is the only writer.
const KV_RETENTION_SEC = 6 * 60 * 60; // 6h

interface KvLike {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

interface CachedFeedPage {
  cachedAt: number; // epoch ms this page was last fetched live
  entries: string[]; // raw per-entry XML fragments (shapeEntry runs on read either way)
  next: string | null;
  updated: string | null;
}

type CacheMeta = {
  stale: boolean;
  cacheAgeSec: number;
  servedFrom: 'fresh-cache' | 'stale-cache' | 'upstream';
};

function kvFromArgs(args: Record<string, unknown>): KvLike | undefined {
  const kv = args._cacheKv;
  return kv && typeof (kv as KvLike).get === 'function' && typeof (kv as KvLike).put === 'function'
    ? (kv as KvLike)
    : undefined;
}

function feedCacheKey(url: string): string {
  return `spain_tenders:feed_page:${url}`;
}

function freshWindowFor(url: string): number {
  return url === FEED_URL ? CURRENT_PAGE_FRESH_SEC : ARCHIVE_PAGE_FRESH_SEC;
}

// One upstream fetch per distinct page URL in flight at a time within this
// isolate, however many callers inside it are waiting on it — a burst of
// concurrent callers all missing the KV cache at once pays the cold fetch
// once, not once per caller. This is a best-effort, per-isolate optimization
// on top of the (cross-isolate, cross-colo) KV cache, not a replacement for
// it — a different isolate still goes to KV first.
const INFLIGHT = new Map<string, Promise<CachedFeedPage>>();

// Cache-first wrapper around fetchFeedPageLive (fleet #2769). Keyed per feed
// URL via KV, so page 1 (FEED_URL) and every archive page a multi-page search
// walks into cache independently and SHARE across callers/queries/colos:
//   1. Fresh KV hit — answer with ZERO upstream fetch.
//   2. Miss/stale — fetch upstream (de-duped per isolate via INFLIGHT), then
//      write the fresh copy to KV.
//   3. Upstream fetch fails — serve a still-usable KV copy (< STALE_MAX_SEC
//      past its freshness window) flagged `stale: true`, rather than failing
//      the call.
//   4. No cache at all and upstream fails — rethrow. callTool's existing
//      catch classes this upstream_down, same as before: a true miss stays
//      a loud error, never a silent empty result.
async function fetchFeedPage(url: string, kv: KvLike | undefined): Promise<{ page: FeedPage; cache: CacheMeta }> {
  const key = feedCacheKey(url);
  const freshSec = freshWindowFor(url);
  const now = Date.now();

  let cached: CachedFeedPage | null = null;
  if (kv) {
    try {
      cached = (await kv.get(key, 'json')) as CachedFeedPage | null;
    } catch {
      cached = null; // caching is an optimization; a KV read failure must not fail the call
    }
  }
  const cacheAgeSec = cached ? Math.max(0, Math.round((now - cached.cachedAt) / 1000)) : null;

  if (cached && cacheAgeSec !== null && cacheAgeSec < freshSec) {
    return {
      page: shapePage(cached),
      cache: { stale: false, cacheAgeSec, servedFrom: 'fresh-cache' },
    };
  }

  let flight = INFLIGHT.get(key);
  if (!flight) {
    flight = fetchFeedPageLive(url).finally(() => INFLIGHT.delete(key));
    INFLIGHT.set(key, flight);
  }

  try {
    const fresh = await flight;
    if (kv) {
      kv.put(key, JSON.stringify(fresh), { expirationTtl: KV_RETENTION_SEC }).catch(() => {
        /* best-effort; a write failure must not fail an otherwise-successful live fetch */
      });
    }
    return { page: shapePage(fresh), cache: { stale: false, cacheAgeSec: 0, servedFrom: 'upstream' } };
  } catch (e) {
    // The live fetch failed (timeout/network/5xx/parse). Answer from the
    // still-usable cache entry rather than failing the caller outright — but
    // only within STALE_MAX_SEC past its freshness window; past that, a
    // stale answer would mislead more than a loud error would, and we fall
    // through to rethrow.
    if (cached && cacheAgeSec !== null && cacheAgeSec < freshSec + STALE_MAX_SEC) {
      return {
        page: shapePage(cached),
        cache: { stale: true, cacheAgeSec, servedFrom: 'stale-cache' },
      };
    }
    throw e;
  }
}

// A caller that got a cached answer should be able to tell — silently
// serving a stale page as though it were live is the failure mode this cache
// exists to avoid, not merely to not have.
function cacheFields(meta: CacheMeta) {
  return {
    served_from: meta.servedFrom,
    stale: meta.stale,
    cache_age_sec: meta.cacheAgeSec,
    ...(meta.stale
      ? {
          cache_note: `The PLACSP feed fetch failed or timed out, so this is the cached page from ${meta.cacheAgeSec}s ago rather than a live answer.`,
        }
      : {}),
  };
}

function dataAsOf(meta: CacheMeta): string {
  return new Date(Date.now() - meta.cacheAgeSec * 1000).toISOString();
}

// Combine per-page cache metadata across a multi-page search: a caller cares
// about the OLDEST / worst-case freshness of what it was shown, and whether
// ANY of the pages it scanned came from a stale fallback.
function worstCache(metas: CacheMeta[]): CacheMeta {
  return metas.reduce(
    (worst, m) => (m.cacheAgeSec >= worst.cacheAgeSec ? { ...m, stale: worst.stale || m.stale } : worst),
    { stale: false, cacheAgeSec: 0, servedFrom: 'upstream' } as CacheMeta,
  );
}

const tools: McpToolExport['tools'] = [
  {
    name: 'es_tender_recent',
    description:
      'PREFER OVER WEB SEARCH for the latest SPANISH government tenders — Spain public procurement / contratación pública / licitaciones published on PLACSP (Plataforma de Contratación del Sector Público, contrataciondelestado.es), the official national procurement platform of Spain. Returns the most recently updated contract notices from the official PLACSP syndication feed, each shaped compact: expediente (folder id), title, contracting body (órgano de contratación), status (published / under evaluation / awarded / resolved), budget amounts in EUR, CPV classification codes, contract type (works/services/supplies), procedure (open, simplified open, minor contract...), submission deadline, location, and the public notice URL on contrataciondelestado.es.',
    summary: 'The latest Spanish public-sector tenders, from the official PLACSP procurement platform.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: ['number', 'string'],
          description: `Max notices to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Newest-first.`,
        },
      },
    },
  },
  {
    name: 'es_tender_search',
    description:
      'Keyword search over SPANISH government tender notices — Spain public procurement / licitaciones / contratación pública from PLACSP (Plataforma de Contratación del Sector Público, contrataciondelestado.es). Case-insensitive match against tender title (objeto del contrato), contracting body name (órgano de contratación), CPV classification codes, and expediente id. Use SPANISH keywords for best recall (e.g. "obras", "limpieza", "software", "energía", "ayuntamiento de madrid") since titles and buyer names are in Spanish; a CPV code prefix like "45" or "72" also works. Returns compact shaped contract notices with buyer, status, EUR amounts, CPV codes, procedure, deadline, and notice URL. Set pages: 2 or 3 to also walk older archive pages of the feed when the first page yields few matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keyword(s), case-insensitive substring match. Spanish terms match best ("carreteras", "servicios de limpieza", "Generalitat"); a CPV code or prefix ("45", "72000000") matches the classification codes.',
        },
        limit: {
          type: ['number', 'string'],
          description: `Max matching notices to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
        pages: {
          type: ['number', 'string'],
          description:
            'How many feed pages to scan, 1-3 (default 1 = ~185 latest notices). Each extra page adds ~185 older notices but also several MB of transfer — raise only when page 1 returns few matches.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'es_tender_by_status',
    description:
      'List SPANISH government tenders filtered by lifecycle status on PLACSP (Spain public procurement / licitaciones, contrataciondelestado.es official feed): PUB = published and open for bids, PRE = prior information notice (anuncio previo), EV = under evaluation, ADJ = awarded (adjudicada), RES = resolved / award finalized, ANUL = cancelled. Ideal for "currently open Spanish tenders" (status PUB) or "recently awarded Spanish government contracts" (ADJ or RES). Returns compact shaped notices with title, contracting body, EUR budget amounts, CPV codes, contract type, procedure, submission deadline, and notice URL.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Status code: PUB | PRE | EV | ADJ | RES | ANUL.',
        },
        limit: {
          type: ['number', 'string'],
          description: `Max notices to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
      required: ['status'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'es_tender_recent':
        return await recentTenders(args);
      case 'es_tender_search':
        return await searchTenders(args);
      case 'es_tender_by_status':
        return await tendersByStatus(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = /abort|timeout/i.test(msg);
    return {
      error: `PLACSP feed: ${msg}`,
      retry_hint: timedOut
        ? 'The PLACSP syndication feed is ~12MB and can be slow; retry once, and keep pages at 1.'
        : 'Retry once; if it persists the contrataciondelestado.es syndication feed may be temporarily down.',
    };
  }
}

// ---- tools ----------------------------------------------------------------

async function recentTenders(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const { page, cache } = await fetchFeedPage(FEED_URL, kvFromArgs(args));
  const tenders = page.entries.slice(0, limit);
  return {
    source: SOURCE,
    feed_updated: page.updated,
    data_as_of: dataAsOf(cache),
    cache: cacheFields(cache),
    total_on_page: page.entries.length,
    count: tenders.length,
    tenders,
  };
}

async function searchTenders(args: Record<string, unknown>): Promise<unknown> {
  const query = strArg(args.query);
  if (!query) {
    return {
      error: 'es_tender_search requires "query" — a keyword like "obras", "limpieza", or a CPV prefix like "45".',
      retry_hint: 'Pass a Spanish keyword or CPV code in "query"; use es_tender_recent to list latest notices without a filter.',
    };
  }
  const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxPages = clampInt(args.pages, 1, 1, MAX_PAGES);
  const q = query.toLowerCase();
  const kv = kvFromArgs(args);

  const matched: ShapedTender[] = [];
  let scanned = 0;
  let pagesFetched = 0;
  let url: string | null = FEED_URL;
  let nextAvailable = false;
  const caches: CacheMeta[] = [];

  while (url && pagesFetched < maxPages) {
    const { page, cache } = await fetchFeedPage(url, kv);
    pagesFetched++;
    scanned += page.entries.length;
    caches.push(cache);
    for (const t of page.entries) {
      if (tenderMatches(t, q)) matched.push(t);
    }
    nextAvailable = page.next !== null;
    if (matched.length >= limit) break;
    url = page.next;
  }

  const cache = worstCache(caches);
  return {
    source: SOURCE,
    query,
    pages_fetched: pagesFetched,
    notices_scanned: scanned,
    matched: matched.length,
    count: Math.min(matched.length, limit),
    older_pages_available: nextAvailable,
    data_as_of: dataAsOf(cache),
    cache: cacheFields(cache),
    // 2026-10-14: when the feed page comes from this pack's own KV cache no
    // upstream call is made, and the gateway's empty-reason inference then
    // books a zero-match answer as `not_queried` (13 of 17 rows for one caller
    // in 2d) — the data WAS queried, against a fresh copy. Declare the reason.
    ...(matched.length === 0 ? { empty_reason: 'no_match' } : {}),
    ...(matched.length === 0 && nextAvailable
      ? { hint: `No matches in the ${scanned} most recent notices — retry with pages: ${Math.min(pagesFetched + 1, MAX_PAGES)} to scan older notices, or broaden the keyword (Spanish terms match best).` }
      : {}),
    tenders: matched.slice(0, limit),
  };
}

async function tendersByStatus(args: Record<string, unknown>): Promise<unknown> {
  const raw = strArg(args.status);
  const status = raw ? raw.toUpperCase() : '';
  if (!STATUS_LABELS[status]) {
    return {
      error: `es_tender_by_status requires "status" — one of: ${VALID_STATUSES.join(', ')}.`,
      retry_hint: 'Use PUB for tenders currently open for bids, ADJ or RES for awarded contracts.',
    };
  }
  const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const { page, cache } = await fetchFeedPage(FEED_URL, kvFromArgs(args));
  const matched = page.entries.filter((t) => t.status === status);
  return {
    source: SOURCE,
    status,
    status_label: STATUS_LABELS[status],
    data_as_of: dataAsOf(cache),
    cache: cacheFields(cache),
    total_on_page: page.entries.length,
    matched: matched.length,
    count: Math.min(matched.length, limit),
    tenders: matched.slice(0, limit),
  };
}

// SyndicationContractFolderStatusCode (CODICE 2.04)
const STATUS_LABELS: Record<string, string> = {
  PRE: 'prior information notice (anuncio previo)',
  PUB: 'published — open for bids (publicada)',
  EV: 'under evaluation (pendiente de adjudicación)',
  ADJ: 'awarded (adjudicada)',
  RES: 'resolved — award finalized (resuelta)',
  ANUL: 'cancelled (anulada)',
};

// ContractCode (CODICE 2.08) — cbc:TypeCode on the ProcurementProject
const CONTRACT_TYPE_LABELS: Record<string, string> = {
  '1': 'Supplies (Suministros)',
  '2': 'Services (Servicios)',
  '3': 'Works (Obras)',
  '7': 'Special administrative (Administrativo especial)',
  '8': 'Private (Privado)',
  '21': 'Public services management (Gestión de servicios públicos)',
  '22': 'Services concession (Concesión de servicios)',
  '31': 'Public works concession (Concesión de obras públicas)',
  '32': 'Works concession (Concesión de obras)',
  '40': 'Public-private partnership (Colaboración público-privada)',
  '50': 'Patrimonial (Patrimonial)',
};

// SyndicationTenderingProcessCode (CODICE 2.07) — cbc:ProcedureCode
const PROCEDURE_LABELS: Record<string, string> = {
  '1': 'Open (Abierto)',
  '2': 'Restricted (Restringido)',
  '3': 'Negotiated, unpublicized (Negociado sin publicidad)',
  '4': 'Negotiated, publicized (Negociado con publicidad)',
  '5': 'Competitive dialogue (Diálogo competitivo)',
  '6': 'Internal rules (Normas internas)',
  '7': 'Framework-agreement call-off (Derivado de acuerdo marco)',
  '8': 'Design contest (Concurso de proyectos)',
  '9': 'Simplified open (Abierto simplificado)',
  '10': 'Innovation partnership (Asociación para la innovación)',
  '11': 'Innovation-partnership call-off (Derivado de asociación para la innovación)',
  '12': 'Dynamic purchasing system call-off (Basado en sistema dinámico de adquisición)',
  '13': 'Competitive with negotiation (Licitación con negociación)',
  '100': 'Minor contract (Contrato menor)',
};

const VALID_STATUSES = Object.keys(STATUS_LABELS);

// ---- feed fetch + entry splitting ----------------------------------------

interface FeedPage {
  entries: ShapedTender[];
  next: string | null;
  updated: string | null;
}

function shapePage(raw: CachedFeedPage): FeedPage {
  return { entries: raw.entries.map(shapeEntry), next: raw.next, updated: raw.updated };
}

async function fetchFeedPageLive(url: string): Promise<CachedFeedPage> {
  const res = await fetch(url, {
    headers: { Accept: 'application/atom+xml, application/xml, text/xml', 'User-Agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().then((t) => t.slice(0, 200)).catch(() => '');
    throw new Error(`${res.status} ${body}`.trim());
  }
  const xml = await res.text();

  const entries: string[] = [];
  let i = 0;
  for (;;) {
    const s = xml.indexOf('<entry>', i);
    if (s === -1) break;
    const e = xml.indexOf('</entry>', s);
    if (e === -1) break;
    entries.push(xml.slice(s + 7, e));
    i = e + 8;
  }
  if (!entries.length) throw new Error('feed returned no <entry> elements (unexpected format).');

  // Feed-level header sits before the first entry. The next-page link is
  // written attribute-order href-then-rel: <link href="..." rel="next"/>,
  // but match either order to be safe.
  const head = xml.slice(0, xml.indexOf('<entry>'));
  const next =
    matchGroup(head, /<link\b[^>]*href="([^"]+)"[^>]*rel="next"/) ??
    matchGroup(head, /<link\b[^>]*rel="next"[^>]*href="([^"]+)"/);
  const updated = matchGroup(head, /<updated>([^<]+)<\/updated>/);

  return { cachedAt: Date.now(), entries, next: next ? decodeEntities(next) : null, updated };
}

// ---- entry shaping --------------------------------------------------------

interface ShapedTender {
  folder_id: string | null;
  title: string | null;
  buyer: string | null;
  status: string | null;
  status_label: string | null;
  amount_estimated_eur: number | null;
  amount_total_eur: number | null;
  currency: string | null;
  cpv_codes: string[];
  contract_type: string | null;
  procedure: string | null;
  submission_deadline: string | null;
  location: string | null;
  updated: string | null;
  url: string | null;
}

function shapeEntry(entry: string): ShapedTender {
  const statusCode = firstTagText(entry, 'cbc-place-ext:ContractFolderStatusCode');

  // Buyer = the LocatedContractingParty's own PartyName — the FIRST
  // <cac:PartyName> in the entry (ParentLocatedParty names come after it).
  const buyer = matchGroup(entry, /<cac:PartyName>\s*<cbc:Name>([^<]*)</);

  const estimated = firstTagText(entry, 'cbc:EstimatedOverallContractAmount');
  const total = firstTagText(entry, 'cbc:TotalAmount');
  const currency =
    matchGroup(entry, /<cbc:(?:TotalAmount|EstimatedOverallContractAmount)\s+currencyID="([^"]+)"/) ?? null;

  const cpv: string[] = [];
  const cpvRe = /<cbc:ItemClassificationCode\b[^>]*>([^<]+)<\/cbc:ItemClassificationCode>/g;
  for (let m = cpvRe.exec(entry); m; m = cpvRe.exec(entry)) {
    const code = m[1].trim();
    if (code && !cpv.includes(code)) cpv.push(code);
  }

  const typeCode = firstTagText(entry, 'cbc:TypeCode');
  const procedureCode = firstTagText(entry, 'cbc:ProcedureCode');

  // Submission deadline lives in its own period block.
  const deadlineBlock = section(entry, 'cac:TenderSubmissionDeadlinePeriod');
  const deadlineDate = deadlineBlock ? firstTagText(deadlineBlock, 'cbc:EndDate') : null;
  const deadlineTime = deadlineBlock ? firstTagText(deadlineBlock, 'cbc:EndTime') : null;

  const locBlock = section(entry, 'cac:RealizedLocation');
  const region = locBlock ? firstTagText(locBlock, 'cbc:CountrySubentity') : null;
  const city = locBlock ? firstTagText(locBlock, 'cbc:CityName') : null;

  const link = matchGroup(entry, /<link\b[^>]*href="([^"]+)"/);
  const title = firstTagText(entry, 'title');
  const updated = firstTagText(entry, 'updated');

  return {
    folder_id: firstTagText(entry, 'cbc:ContractFolderID'),
    title,
    buyer: buyer ? decodeEntities(buyer).trim() : null,
    status: statusCode,
    status_label: statusCode ? STATUS_LABELS[statusCode] ?? null : null,
    amount_estimated_eur: numOrNull(estimated),
    amount_total_eur: numOrNull(total),
    currency,
    cpv_codes: cpv,
    contract_type: typeCode ? CONTRACT_TYPE_LABELS[typeCode] ?? typeCode : null,
    procedure: procedureCode ? PROCEDURE_LABELS[procedureCode] ?? procedureCode : null,
    submission_deadline: deadlineDate ? (deadlineTime ? `${deadlineDate}T${deadlineTime}` : deadlineDate) : null,
    location: [city, region].filter((v, idx, a) => v && a.indexOf(v) === idx).join(', ') || null,
    updated,
    url: link ? decodeEntities(link) : null,
  };
}

function tenderMatches(t: ShapedTender, q: string): boolean {
  if (t.title && t.title.toLowerCase().includes(q)) return true;
  if (t.buyer && t.buyer.toLowerCase().includes(q)) return true;
  if (t.folder_id && t.folder_id.toLowerCase().includes(q)) return true;
  return t.cpv_codes.some((c) => c.startsWith(q));
}

// ---- XML micro-helpers (no DOMParser in Workers) --------------------------

// First <tag ...>text</tag> occurrence — text content, entity-decoded.
function firstTagText(xml: string, tag: string): string | null {
  const open = xml.indexOf(`<${tag}`);
  if (open === -1) return null;
  const gt = xml.indexOf('>', open);
  if (gt === -1) return null;
  const close = xml.indexOf(`</${tag}>`, gt);
  if (close === -1) return null;
  const text = xml.slice(gt + 1, close).trim();
  return text ? decodeEntities(text) : null;
}

// Inner XML of the first <tag>...</tag> block (children included).
function section(xml: string, tag: string): string | null {
  const open = xml.indexOf(`<${tag}`);
  if (open === -1) return null;
  const gt = xml.indexOf('>', open);
  if (gt === -1) return null;
  const close = xml.indexOf(`</${tag}>`, gt);
  if (close === -1) return null;
  return xml.slice(gt + 1, close);
}

function matchGroup(s: string, re: RegExp): string | null {
  const m = s.match(re);
  return m ? m[1] : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---- small arg helpers ----------------------------------------------------

function numOrNull(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  let n: number;
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.trunc(v);
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Math.trunc(Number(v));
  else return dflt;
  return Math.min(max, Math.max(min, n));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
