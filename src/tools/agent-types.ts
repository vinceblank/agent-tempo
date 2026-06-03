import { ok, type TempoToolDescriptor } from './descriptor';
import { listAgentTypes } from '../ensemble/agent-types';

export function buildAgentTypesTool(): TempoToolDescriptor {
  return {
    name: 'agent_types',
    description: 'List available player types (agent definitions) that can be used when recruiting',
    params: {},
    handler: async () => {
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
  };
}
