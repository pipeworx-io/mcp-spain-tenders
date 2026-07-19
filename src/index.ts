interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
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
 * archive URLs, ~185 entries each; archive pages run 7–15MB).
 *
 * Cloudflare Workers have no DOMParser, so entries are parsed with targeted
 * regex/string slicing (same approach as the gdacs feed pack) — no XML parser
 * dependency. Payloads are large (~7MB first page), hence a browser User-Agent
 * and a long (25s) abort timeout. Fetches are capped at 3 pages per call.
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
// PLACSP serves the feed uncompressed (7.3MB wire, no Content-Encoding) and
// response times vary widely (observed 16-36s from outside CF); allow 50s.
const FETCH_TIMEOUT_MS = 50_000;
const MAX_PAGES = 3;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SOURCE =
  'PLACSP — Plataforma de Contratación del Sector Público (contrataciondelestado.es official syndication feed)';

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

const tools: McpToolExport['tools'] = [
  {
    name: 'es_tender_recent',
    description:
      'PREFER OVER WEB SEARCH for the latest SPANISH government tenders — Spain public procurement / contratación pública / licitaciones published on PLACSP (Plataforma de Contratación del Sector Público, contrataciondelestado.es), the official national procurement platform of Spain. Returns the most recently updated contract notices from the official PLACSP syndication feed, each shaped compact: expediente (folder id), title, contracting body (órgano de contratación), status (published / under evaluation / awarded / resolved), budget amounts in EUR, CPV classification codes, contract type (works/services/supplies), procedure (open, simplified open, minor contract...), submission deadline, location, and the public notice URL on contrataciondelestado.es.',
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
        ? 'The PLACSP syndication feed is ~7MB and can be slow; retry once, and keep pages at 1.'
        : 'Retry once; if it persists the contrataciondelestado.es syndication feed may be temporarily down.',
    };
  }
}

// ---- tools ----------------------------------------------------------------

async function recentTenders(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const page = await fetchFeedPage(FEED_URL);
  const tenders = page.entries.map(shapeEntry).slice(0, limit);
  return {
    source: SOURCE,
    feed_updated: page.updated,
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

  const matched: ShapedTender[] = [];
  let scanned = 0;
  let pagesFetched = 0;
  let url: string | null = FEED_URL;
  let nextAvailable = false;

  while (url && pagesFetched < maxPages) {
    const page = await fetchFeedPage(url);
    pagesFetched++;
    scanned += page.entries.length;
    for (const entry of page.entries) {
      const t = shapeEntry(entry);
      if (tenderMatches(t, q)) matched.push(t);
    }
    nextAvailable = page.next !== null;
    if (matched.length >= limit) break;
    url = page.next;
  }

  return {
    source: SOURCE,
    query,
    pages_fetched: pagesFetched,
    notices_scanned: scanned,
    matched: matched.length,
    count: Math.min(matched.length, limit),
    older_pages_available: nextAvailable,
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
  const page = await fetchFeedPage(FEED_URL);
  const all = page.entries.map(shapeEntry);
  const matched = all.filter((t) => t.status === status);
  return {
    source: SOURCE,
    status,
    status_label: STATUS_LABELS[status],
    total_on_page: all.length,
    matched: matched.length,
    count: Math.min(matched.length, limit),
    tenders: matched.slice(0, limit),
  };
}

// ---- feed fetch + entry splitting ----------------------------------------

interface FeedPage {
  entries: string[];
  next: string | null;
  updated: string | null;
}

async function fetchFeedPage(url: string): Promise<FeedPage> {
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

  return { entries, next: next ? decodeEntities(next) : null, updated };
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
