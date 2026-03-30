import type { ToolExecutor } from "../../core/types.ts";

export const fetchUrlTool: ToolExecutor = {
  definition: {
    name: "fetch_url",
    description: "Fetch the content of a URL",
    parameters: [
      {
        name: "url",
        type: "string",
        description: "The URL to fetch",
        required: true,
      },
      {
        name: "maxLength",
        type: "number",
        description: "Max response length in characters (default: 10000)",
        required: false,
      },
    ],
  },
  async execute(params) {
    const url = params.url as string;
    const maxLength = (params.maxLength as number) ?? 10000;

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Arcti/1.0" },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`;
      }

      let text = await response.text();
      if (text.length > maxLength) {
        text = text.slice(0, maxLength) + "\n...[truncated]";
      }

      return text;
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  },
};

export const webSearchTool: ToolExecutor = {
  definition: {
    name: "web_search",
    description: "Search the web using DuckDuckGo and return results",
    parameters: [
      { name: "query", type: "string", description: "Search query", required: true },
      { name: "limit", type: "number", description: "Max results to return (default: 5)", required: false },
    ],
  },
  async execute(params) {
    const query = params.query as string;
    const limit = (params.limit as number) ?? 5;

    try {
      const encoded = encodeURIComponent(query);
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Arcti/1.0)",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return `Error: HTTP ${response.status}`;
      }

      const html = await response.text();

      // Parse results from DuckDuckGo HTML
      const results: { title: string; url: string; snippet: string }[] = [];
      const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
      const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;

      const links = [...html.matchAll(resultPattern)];
      const snippets = [...html.matchAll(snippetPattern)];

      for (let i = 0; i < Math.min(links.length, limit); i++) {
        const rawUrl = links[i][1];
        // DuckDuckGo wraps URLs in a redirect, extract actual URL
        const urlMatch = rawUrl.match(/uddg=([^&]+)/);
        const url = urlMatch ? decodeURIComponent(urlMatch[1]) : rawUrl;
        const title = links[i][2].replace(/<[^>]*>/g, "").trim();
        const snippet = snippets[i]
          ? snippets[i][1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim()
          : "";

        results.push({ title, url, snippet });
      }

      if (results.length === 0) {
        return "No results found for: " + query;
      }

      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");
    } catch (error) {
      return `Error: ${(error as Error).message}`;
    }
  },
};
