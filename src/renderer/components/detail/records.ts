import type { Entity, EntityKind, Snapshot } from "../../../shared/contracts";
import type { Selection } from "../Calendar";

export const entityNames: Record<EntityKind, string> = {
  task: "任务",
  block: "时段",
  goal: "目标",
  candidate: "候选事项",
  course: "课程",
  courseException: "课程例外",
  source: "原始来源",
  preference: "偏好",
  feedback: "反馈",
};
export function findRecord(
  snapshot: Snapshot,
  selection: Selection,
): Entity | undefined {
  const keys = {
    task: "tasks",
    block: "blocks",
    goal: "goals",
    candidate: "candidates",
    course: "courses",
    courseException: "courseExceptions",
    source: "sources",
    preference: "preferences",
    feedback: "feedback",
  } as const;
  return snapshot[keys[selection.entity]].find(
    (value) => value.id === selection.id,
  );
}
