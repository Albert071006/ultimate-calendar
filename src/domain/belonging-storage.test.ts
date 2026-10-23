import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from './planner';
import { PALETTE_COLORS } from '../shared/palette';
import type { MutationInput } from '../shared/contracts';

const roots: string[] = [];
const repos: Repository[] = [];
afterEach(() => { for (const r of repos.splice(0)) r.close(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function open(path: string) { const repository = createRepository(path); repos.push(repository); return { repository, planner: createPlanner(repository) }; }
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'planner-belonging-')); roots.push(dir);
  const path = join(dir, 'planner.sqlite'); let i = 0;
  const { repository, planner } = open(path);
  const mutate = (...mutations: MutationInput[]) => planner.mutate({ operationId: `belonging-${++i}`, origin: 'manual', mutations, confirmed: false } as never);
  return { path, repository, planner, mutate };
}
const course = { title: '大学物理', weekday: 1, startTime: '10:05', endTime: '11:40', firstWeek: 1, lastWeek: 16, termStart: '2026-08-31' };

it('gives new courses and goals a palette color and lets tasks belong to a course', () => {
  const { planner, mutate } = setup();
  expect(mutate({ type: 'create', entity: 'course', values: course }).status).toBe('applied');
  expect(mutate({ type: 'create', entity: 'goal', values: { title: '通过四级' } }).status).toBe('applied');
  const { courses, goals } = planner.snapshot();
  expect(PALETTE_COLORS).toContain(courses[0]!.color);
  expect(PALETTE_COLORS).toContain(goals[0]!.color);
  expect(goals[0]!.color).not.toBe(courses[0]!.color);
  expect(mutate({ type: 'create', entity: 'task', values: { title: '实验报告', courseId: courses[0]!.id } }).status).toBe('applied');
  expect(planner.snapshot().tasks[0]!.courseId).toBe(courses[0]!.id);
  expect(mutate({ type: 'create', entity: 'task', values: { title: '无效', courseId: 'missing' } }).status).toBe('clarification');
});

it('undoes a course creation even though its color was filled after the operation', () => {
  const { planner, mutate } = setup();
  mutate({ type: 'create', entity: 'course', values: course });
  expect(planner.undo().status).toBe('applied');
  expect(planner.snapshot().courses).toHaveLength(0);
});

it('unlinks tasks when their course is deleted, as one undoable change', () => {
  const { planner, mutate } = setup();
  mutate({ type: 'create', entity: 'course', values: course });
  const physics = planner.snapshot().courses[0]!;
  mutate({ type: 'create', entity: 'task', values: { title: '实验报告', courseId: physics.id } });
  const result = mutate({ type: 'delete', entity: 'course', id: physics.id, expectedVersion: physics.version, scope: 'all' } as MutationInput);
  const applied = result.status === 'preview'
    ? planner.mutate({ ...result.proposedRequest, origin: 'manual', confirmed: true, confirmationToken: result.confirmationToken }) : result;
  expect(applied.status).toBe('applied');
  expect(planner.snapshot().tasks[0]!.courseId).toBeNull();
  expect(planner.undo().status).toBe('applied');
  expect(planner.snapshot().tasks[0]!.courseId).toBe(physics.id);
});

it('fills colors for records saved before colors existed, durably and without breaking their undo', () => {
  const { path, repository, mutate } = setup();
  mutate({ type: 'create', entity: 'course', values: course });
  repository.close(); repos.splice(repos.indexOf(repository), 1);
  // Strip the new fields as an older version would have written them.
  const db = new DatabaseSync(path);
  for (const table of ['records', 'journal'] as const) {
    for (const row of db.prepare(`SELECT rowid AS id, payload FROM ${table}`).all()) {
      const payload = (row['payload'] as string).replace(/,"color":"#[0-9a-f]{6}"/g, '').replace(/,"courseId":null/g, '');
      db.prepare(`UPDATE ${table} SET payload=? WHERE rowid=?`).run(payload, row['id'] as number);
    }
  }
  expect((db.prepare("SELECT payload FROM records WHERE kind='course'").get()!['payload'] as string)).not.toContain('color');
  db.close();
  const first = open(path);
  const color = first.planner.snapshot().courses[0]!.color;
  expect(PALETTE_COLORS).toContain(color);
  expect(first.planner.snapshot().courses[0]!.version).toBe(1);
  first.repository.close(); repos.splice(repos.indexOf(first.repository), 1);
  const raw = new DatabaseSync(path);
  expect(raw.prepare("SELECT payload FROM records WHERE kind='course'").get()!['payload']).toContain(`"color":"${color}"`);
  raw.close();
  const second = open(path);
  expect(second.planner.snapshot().courses[0]!.color).toBe(color);
  expect(second.planner.undo().status).toBe('applied');
});
