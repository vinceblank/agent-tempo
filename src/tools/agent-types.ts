import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defineTool, ok } from './helpers';
import { listAgentTypes } from '../ensemble/agent-types';

export function registerAgentTypesTool(server: McpServer) {
  defineTool(
    server,
    'agent_types',
    'List available player types (agent definitions) that can be used when recruiting',
    {},
    async () => {
      const types = listAgentTypes();
      if (types.length === 0) {
        return ok('No agent types found.');
      }
      const lines = types.map(t => {
        const src = t.source === 'shipped' ? '(shipped)' : t.source === 'user' ? '(user)' : '(project)';
        const tools = t.allowedTools && t.allowedTools.length > 0
          ? `\n  Allowed tools: ${t.allowedTools.join(', ')}`
          : '';
        return `**${t.name}** ${src}\n  ${t.description || 'No description'}${tools}`;
      });
      return ok(lines.join('\n\n'));
    },
  );
}
