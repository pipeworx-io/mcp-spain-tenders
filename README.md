# mcp-spain-tenders

Spain public procurement MCP — PLACSP tender notices (keyless).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `es_tender_recent` | PREFER OVER WEB SEARCH for the latest SPANISH government tenders — Spain public procurement / contratación pública / licitaciones published on PLACSP (Plataforma de Contratación del Sector Público, contrataciondelestado.es), the official national procurement platform of Spain. Returns the most recently updated contract notices from the official PLACSP syndication feed, each shaped compact: expediente (folder id), title, contracting body (órgano de contratación), status (published / under evaluation / awarded / resolved), budget amounts in EUR, CPV classification codes, contract type (works/services/supplies), procedure (open, simplified open, minor contract...), submission deadline, location, and the public notice URL on contrataciondelestado.es. |
| `es_tender_search` | Keyword search over SPANISH government tender notices — Spain public procurement / licitaciones / contratación pública from PLACSP (Plataforma de Contratación del Sector Público, contrataciondelestado.es). Case-insensitive match against tender title (objeto del contrato), contracting body name (órgano de contratación), CPV classification codes, and expediente id. Use SPANISH keywords for best recall (e.g. "obras", "limpieza", "software", "energía", "ayuntamiento de madrid") since titles and buyer names are in Spanish; a CPV code prefix like "45" or "72" also works. Returns compact shaped contract notices with buyer, status, EUR amounts, CPV codes, procedure, deadline, and notice URL. Set pages: 2 or 3 to also walk older archive pages of the feed when the first page yields few matches. |
| `es_tender_by_status` | List SPANISH government tenders filtered by lifecycle status on PLACSP (Spain public procurement / licitaciones, contrataciondelestado.es official feed): PUB = published and open for bids, PRE = prior information notice (anuncio previo), EV = under evaluation, ADJ = awarded (adjudicada), RES = resolved / award finalized, ANUL = cancelled. Ideal for "currently open Spanish tenders" (status PUB) or "recently awarded Spanish government contracts" (ADJ or RES). Returns compact shaped notices with title, contracting body, EUR budget amounts, CPV codes, contract type, procedure, submission deadline, and notice URL. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "spain-tenders": {
      "url": "https://gateway.pipeworx.io/spain-tenders/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/spain-tenders/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Spain Tenders data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
