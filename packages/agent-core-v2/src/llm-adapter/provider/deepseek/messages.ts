import { isDeepStrictEqual } from 'node:util';
import type { ImageContent, TextContent, TranscriptContext } from '@earendil-works/pi-ai';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { getSystemMessageText } from '@earendil-works/pi-ai/utils/text';
import type { Message, Tool } from '#/llm-adapter/contract/message';
import { ChatProviderError } from '#/llm-adapter/contract/errors';
import { decodePiSignature } from '../pi/messages';
import type { DeepSeekCapabilities } from './capabilities';

export const DEEPSEEK_TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01';

type Block = Record<string, unknown>;
interface NativeMessage { role: 'system' | 'user' | 'assistant'; content: Block[] }

function inputBlock(block: TextContent | ImageContent): Block {
  return block.type === 'text' ? { type: 'text', text: block.text } : {
    type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data },
  };
}

export function prepareDeepSeekMessages(
  payload: Record<string, unknown>, context: TranscriptContext, tools: readonly Tool[],
  history: readonly Message[], capabilities: DeepSeekCapabilities, route: string, effort: string,
): Record<string, unknown> {
  if (!['off', 'low', 'high', 'max'].includes(effort))
    throw new ChatProviderError(`DeepSeek Messages does not support reasoning effort '${effort}'. Use low, high, max or off.`);
  const declarations = new Map<string, Tool>();
  for (const tool of tools) declarations.set(tool.name, tool);
  const announced = new Set<string>();
  let inConversation = false;
  for (const [index, message] of context.messages.entries()) {
    if (message.role !== 'system') { inConversation = true; continue; }
    for (const tool of message.toolsAdded ?? []) {
      if (inConversation) announced.add(tool.name);
      const existing = declarations.get(tool.name);
      if (capabilities.toolUpdate !== 'none' && existing && (!isDeepStrictEqual(existing.parameters, tool.parameters) || existing.description !== tool.description))
        throw new ChatProviderError(`DeepSeek cached tool '${tool.name}' was redefined. Start a new session after changing its schema.`);
      declarations.set(tool.name, { ...tool, parameters: { ...tool.parameters }, deferred: index > 0 && !inConversation ? undefined : existing?.deferred });
    }
  }
  const messages: NativeMessage[] = [];
  const systems: NativeMessage[] = [];
  const leading: string[] = [];
  const effectiveSystem: string[] = [];
  const pendingCalls = new Set<string>();
  let sawConversation = false;
  const flushSystems = () => {
    if (systems.length === 0) return;
    if (pendingCalls.size > 0) throw new ChatProviderError('DeepSeek tool calls must receive all results before a system update.');
    if (messages.at(-1)?.role !== 'user') throw new ChatProviderError('DeepSeek system updates require a preceding user or tool result.');
    messages.push(...systems.splice(0));
  };
  const push = (role: 'user' | 'assistant', content: Block[]) => {
    if (content.length === 0) return;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of context.messages) {
    if (message.role === 'system') {
      const text = getSystemMessageText(message);
      const blocks: Block[] = [];
      if (text) {
        effectiveSystem.push(text);
        if (!sawConversation || capabilities.systemPromptUpdate === 'leading-only') leading.push(text);
        else blocks.push({ type: 'text', text: effectiveSystem.join('\n\n') });
      }
      if (sawConversation && capabilities.toolUpdate !== 'none') {
        if ((message.toolsRemoved?.length ?? 0) > 0 && capabilities.toolUpdate !== 'in-history')
          throw new ChatProviderError('This DeepSeek route supports tool additions only. Start a new session after removing tools.');
        for (const tool of message.toolsRemoved ?? []) blocks.push({ type: 'tool_removal', tool: { type: 'tool_reference', name: tool.name } });
        for (const tool of message.toolsAdded ?? []) blocks.push({ type: 'tool_addition', tool: { type: 'tool_reference', name: tool.name } });
      }
      if (blocks.length > 0) systems.push({ role: 'system', content: blocks });
      continue;
    }
    sawConversation = true;
    if (message.role === 'assistant') {
      flushSystems();
      if (pendingCalls.size > 0) throw new ChatProviderError('DeepSeek history has unresolved tool calls before the next assistant message.');
      const source = history[message.timestamp];
      const content = message.content.flatMap((block, index): Block[] => {
        if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : [];
        if (block.type === 'toolCall') {
          if (pendingCalls.has(block.id)) throw new ChatProviderError('DeepSeek history contains duplicate tool call IDs.');
          pendingCalls.add(block.id);
          return [{ type: 'tool_use', id: block.id, name: block.name, input: block.arguments }];
        }
        const original = source?.content[index];
        const signature = decodePiSignature(original?.type === 'think' ? original.encrypted : undefined);
        const valid = signature?.route === route && signature.api === message.api &&
          signature.provider === message.provider && signature.model === message.model;
        if (!block.thinking) return [];
        return [{ type: 'thinking', thinking: block.thinking, signature: valid ? signature.signature : undefined }];
      });
      push('assistant', content);
    } else if (message.role === 'toolResult') {
      if (!pendingCalls.delete(message.toolCallId)) throw new ChatProviderError('DeepSeek tool result has no matching pending tool call.');
      push('user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content.map(inputBlock), is_error: message.isError }]);
    } else {
      if (pendingCalls.size > 0) throw new ChatProviderError('DeepSeek tool results must precede new user input.');
      push('user', typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content.map(inputBlock));
    }
  }
  if (pendingCalls.size > 0) throw new ChatProviderError('DeepSeek history ends with unresolved tool calls.');
  flushSystems();
  const optimized = capabilities.toolUpdate !== 'none';
  const current = optimized ? [...declarations.values()] : [...new Map([...getCurrentTools(context.messages), ...tools].map(tool => [tool.name, tool])).values()];
  const definitions = [...current].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((tool) => ({
    name: tool.name, description: tool.description, input_schema: tool.parameters,
    defer_loading: optimized && (announced.has(tool.name) || declarations.get(tool.name)?.deferred === true) ? true : undefined,
  }));
  const result: Record<string, unknown> = { ...payload, messages, system: leading.join('\n\n') || undefined, tools: definitions.length > 0 ? definitions : undefined,
    thinking: { type: effort === 'off' ? 'disabled' : 'enabled' }, output_config: effort === 'off' ? undefined : { effort } };
  delete result['betas'];
  return result;
}
