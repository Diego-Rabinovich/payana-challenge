import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ReadModel } from '@aa/core';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TOOLS, toolNamed } from './tools.js';

/**
 * The MCP surface, built from the tool list.
 *
 * Kept apart from `main.ts` so the tools can be exercised without a transport:
 * the tests call the handlers directly and assert against the same DTOs the
 * HTTP API returns, which is the only thing worth testing here. The protocol
 * is incidental.
 */
export function buildServer(model: ReadModel): Server {
  const server = new Server(
    { name: 'alimentos-alcazar-conciliacion', version: model.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // The agent reads this to know what to pass. Generated from the same
      // zod schema that validates the call, so it cannot describe something
      // the tool would then reject.
      inputSchema: zodToJsonSchema(tool.input) as { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolNamed(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Unknown tool ${request.params.name}` }],
      };
    }

    // Parsing here rather than trusting the client means a malformed call is
    // a clear message instead of an exception somewhere in a query.
    const parsed = tool.input.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: parsed.error.issues.map(describe).join('; ') }],
      };
    }

    const result = await tool.run(parsed.data, model);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}

function describe(issue: { path: (string | number)[]; message: string }): string {
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}
