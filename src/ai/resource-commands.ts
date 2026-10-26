import type { CommandIntent, Mutation, Snapshot } from '../shared/contracts';
import type { ResourceReference, ResourceOwner } from '../shared/resources';
import { resourceOwner } from '../domain/resources';
import type { ResolvedResource } from '../domain/resources';
import { WorkflowError } from './deepseek';

export interface ResourceCommandContext {
  attachedResources: ResourceReference[];
  resourceLinks: (ResolvedResource & { target: ResourceOwner })[];
  tasks?: Record<string, unknown>[];
  blocks?: Record<string, unknown>[];
  courses?: Record<string, unknown>[];
  goals?: Record<string, unknown>[];
}

export function commandResources(context: ResourceCommandContext): Map<string, ResourceReference> {
  const known = new Map(context.resourceLinks.map(link => [link.resource.id, link.resource]));
  // Resolved views deduplicate inherited URLs; keep the original IDs visible in record metadata too.
  for (const record of [...context.tasks ?? [], ...context.blocks ?? [], ...context.courses ?? [], ...context.goals ?? []]) {
    for (const resource of (record.resources as ResourceReference[] | undefined) ?? []) known.set(resource.id, resource);
  }
  for (const resource of context.attachedResources) known.set(resource.id, resource);
  return known;
}

const sameLocation = (a: ResourceReference, b: ResourceReference) => a.kind === b.kind &&
  (a.kind === 'web' && b.kind === 'web' ? a.url === b.url
    : a.kind !== 'web' && b.kind !== 'web' && a.deviceId === b.deviceId);

/** The model may select a registered resource or rename its label; it cannot invent a path or retarget it. */
export function validateResourceMutationReferences(mutations: Mutation[], context: ResourceCommandContext): void {
  const known = commandResources(context);
  for (const mutation of mutations) {
    const candidates = [
      ...('values' in mutation && 'resources' in mutation.values ? mutation.values.resources ?? [] : []),
      ...('resources' in mutation ? mutation.resources ?? [] : []),
    ];
    for (const resource of candidates) {
      const original = known.get(resource.id);
      if (!original || !sameLocation(original, resource) || (original.kind !== 'web' && resource.kind !== 'web' && original.deviceName !== resource.deviceName)) {
        throw new WorkflowError('AI_RESPONSE', 'AI 引用了未选择的资料或更改了资料位置，请选择文件或粘贴网址后重试');
      }
    }
  }
}

export function selectedCommandResources(ids: string[], context: ResourceCommandContext): ResourceReference[] {
  const known = commandResources(context);
  return [...new Set(ids)].map(id => {
    const resource = known.get(id);
    if (!resource) throw new WorkflowError('AI_RESPONSE', 'AI 选择了上下文之外的资料，请重新选择');
    return resource;
  });
}

/** Expand attachment into the ordinary versioned planner write, preserving undo and confirmation rules. */
export function groundResourceCommand(intent: CommandIntent, context: ResourceCommandContext, snapshot: Snapshot): CommandIntent {
  if (intent.kind === 'resource_open') { selectedCommandResources(intent.resourceIds, context); return intent; }
  if (intent.kind !== 'resource_attach') return intent;
  const target = resourceOwner(snapshot, intent.target);
  if (!target) throw new WorkflowError('AI_RESPONSE', '要关联资料的事项已不存在，请重新选择');
  const selected = selectedCommandResources(intent.resourceIds, context);
  if (intent.target.entity === 'block' && 'recurrence' in target && target.recurrence) {
    if (!intent.scope) return { kind: 'clarification', reply: '这是一组重复活动。', questions: ['资料仅用于本次，还是本次及以后？'] };
    return { kind: 'mutate', reply: intent.reply, mutations: [{ type: 'updateRecurringEvent', id: target.id, expectedVersion: intent.expectedVersion,
      scope: intent.scope, resourceMode: 'append', values: { resources: selected } }] };
  }
  const resources = [...(target.resources ?? [])];
  const existing = new Set(resources.map(resource => resource.id));
  for (const resource of selected) if (!existing.has(resource.id)) {
    resources.push(resource); existing.add(resource.id);
  }
  if (resources.length === (target.resources ?? []).length) return { kind: 'query', reply: '这些资料已关联，无需重复添加。' };
  const common = { id: target.id, expectedVersion: intent.expectedVersion, values: { resources } };
  let mutation: Mutation;
  if (intent.target.entity === 'course') mutation = { type: 'update', entity: 'course', ...common, scope: 'all' };
  else mutation = { type: 'update', entity: intent.target.entity, ...common };
  return { kind: 'mutate', reply: intent.reply, mutations: [mutation] };
}
