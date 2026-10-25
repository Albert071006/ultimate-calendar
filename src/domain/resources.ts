import type { Snapshot, Task, Block, Course, Goal } from '../shared/contracts';
import type { ResourceOwner, ResourceReference } from '../shared/resources';

export interface ResolvedResource {
  resource: ResourceReference;
  owner: ResourceOwner;
  ownerTitle: string;
  group: 'own' | 'task' | 'shared';
  inherited: boolean;
}

export function resourceOwner(snapshot: Snapshot, owner: ResourceOwner): Task | Block | Course | Goal | undefined {
  switch (owner.entity) {
    case 'task': return snapshot.tasks.find(value => value.id === owner.id);
    case 'block': return snapshot.blocks.find(value => value.id === owner.id);
    case 'course': return snapshot.courses.find(value => value.id === owner.id);
    case 'goal': return snapshot.goals.find(value => value.id === owner.id);
  }
}

/** Resolve on every read: shared references stay at their owner and are never copied into a block. */
export function resolveResources(snapshot: Snapshot, target: ResourceOwner): ResolvedResource[] {
  const result: ResolvedResource[] = [];
  const seen = new Set<string>();
  const seenUrls = new Set<string>();
  const add = (owner: ResourceOwner, group: ResolvedResource['group']) => {
    const record = resourceOwner(snapshot, owner);
    for (const resource of record?.resources ?? []) {
      if (seen.has(resource.id)) continue;
      seen.add(resource.id);
      if (resource.kind === 'web') {
        const url = new URL(resource.url).href;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
      }
      result.push({ resource, owner, ownerTitle: record!.title, group,
        inherited: owner.entity !== target.entity || owner.id !== target.id });
    }
    return record;
  };
  const own = add(target, 'own');
  const addCourse = (course: Course | undefined, includeSelf: boolean) => {
    if (!course) return;
    if (includeSelf) add({ entity: 'course', id: course.id }, 'shared');
    // A timetable stores one row per weekday; rows in the same term/title are one course to the user.
    for (const sibling of snapshot.courses) if (sibling.id !== course.id && sibling.title === course.title && sibling.termStart === course.termStart) {
      add({ entity: 'course', id: sibling.id }, 'shared');
    }
  };
  if (target.entity === 'course') addCourse(own as Course | undefined, false);
  const task = target.entity === 'task' ? own as Task | undefined
    : target.entity === 'block' && (own as Block | undefined)?.taskId
      ? add({ entity: 'task', id: (own as Block).taskId! }, 'task') as Task | undefined : undefined;
  if (task?.courseId) addCourse(snapshot.courses.find(course => course.id === task.courseId), true);
  if (task?.goalId) add({ entity: 'goal', id: task.goalId }, 'shared');
  return result;
}
