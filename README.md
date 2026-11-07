# edstem-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for [Ed Discussion](https://edstem.org).

## Tools

| Tool | What it does |
| --- | --- |
| `list_courses` | List the courses you're enrolled in, with IDs |
| `list_threads` | List thread titles and metadata for a course (optionally by category) |
| `get_thread` | Get a thread's full text, including answers and comments |
| `get_course_digest` | Fetch the full text of recent threads in one call (announcements and pinned threads first) |
| `search_threads` | Keyword search over a course's latest 500 threads |

It only makes `GET` requests. It cannot post, vote or modify anything.

## Setup

Requires Node.js 18+.

```bash
git clone https://github.com/rufus-gh/edstem-mcp.git
cd edstem-mcp
npm install
```

Create an API token at `https://edstem.org/us/settings/api-tokens`. Use your region in place of `us`, e.g. `au`.

Then register the server with your MCP client. For any client that uses a JSON config:

```json
{
  "mcpServers": {
    "edstem": {
      "command": "node",
      "args": ["/absolute/path/to/edstem-mcp/server.js"],
      "env": { "ED_API_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

## Configuration

| Variable | Description |
| --- | --- |
| `ED_API_TOKEN` | Required. Your Ed API token. |
| `ED_API_BASE` | Optional. API host, default `https://edstem.org/api`. |

## Example prompt

> Go through my Ed courses and tell me everything important from the last 2 weeks.

## Notes

The Ed API is not officially documented; this server relies on observed behaviour and may break if Ed changes it.

## License

ISC
