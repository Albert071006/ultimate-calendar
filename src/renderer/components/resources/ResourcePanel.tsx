import { useEffect, useState, type DragEvent } from 'react';
import { FileText, Folder, Link, MoreHorizontal, Paperclip, Plus, X } from 'lucide-react';
import { MutationSchema, type ApiResult, type Snapshot } from '../../../shared/contracts';
import type { HostCapabilities } from '../../../shared/client';
import { ResourceReferenceSchema, type ResourceReference, type ResourceOwner as ResourceTarget } from '../../../shared/resources';
import { resolveResources, resourceOwner } from '../../../domain/resources';
import type { PlannerUI } from '../../hooks/usePlanner';
import './ResourcePanel.css';

type Status = 'available' | 'missing' | 'other-device' | 'unregistered' | 'blocked';
const statusText: Record<Exclude<Status, 'available'>, string> = {
  missing: '文件已移动或不存在', 'other-device': '需在所属电脑打开',
  unregistered: '请在此电脑重新定位', blocked: '此文件类型不能直接打开',
};
const ownerNames = { task: '任务', block: '本次活动', course: '课程', goal: '目标' };
const emptyResources: ResourceReference[] = [];

function Icon({ kind }: { kind: ResourceReference['kind'] }) {
  return kind === 'web' ? <Link aria-hidden="true" /> : kind === 'folder' ? <Folder aria-hidden="true" /> : <FileText aria-hidden="true" />;
}

/** All native operations stay on the host. The shared record never contains a local path. */
function useResourceHost(host: HostCapabilities | undefined, resources: ResourceReference[]) {
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const signature = JSON.stringify(resources);
  useEffect(() => {
    let active = true;
    if (!host?.resourceStatus) return;
    void host.resourceStatus({ resources }).then(result => {
      if (!active) return;
      if (result.ok) setStatuses(Object.fromEntries(result.data.map(item => [item.id, item.status])));
      else setError(result.error.message);
    }).catch(() => { if (active) setError('暂时无法检查资料位置，请重试。'); });
    return () => { active = false; };
  }, [host, signature, revision]);
  async function run<T>(job: () => Promise<ApiResult<T>>): Promise<T | undefined> {
    setBusy(true); setError('');
    try {
      const result = await job();
      if (result.ok) return result.data;
      setError(result.error.message);
    } catch (e) { setError(e instanceof Error ? e.message : '资料操作失败，请重试。'); }
    finally { setBusy(false); }
  }
  return { statuses, error, setError, busy, run, refresh: () => setRevision(value => value + 1) };
}

function ResourceLink({ resource, host, status, disabled, open }: {
  resource: ResourceReference; host?: HostCapabilities; status?: Status; disabled?: boolean;
  open: (resource: ResourceReference) => void;
}) {
  const unavailable = resource.kind !== 'web' && (!host?.resourceOpen || status === 'other-device' || status === 'blocked');
  const hint = resource.kind === 'web' ? new URL(resource.url).hostname
    : !host?.resourceOpen ? '需在电脑打开' : status && status !== 'available' ? statusText[status] : resource.deviceName;
  return <div className="resource-label">
    {resource.kind === 'web' && !host?.resourceOpen
      ? <a className="resource-open" href={resource.url} target="_blank" rel="noopener noreferrer"><Icon kind={resource.kind} /><span>{resource.name}</span></a>
      : <button type="button" className="resource-open" disabled={disabled || unavailable} onClick={() => open(resource)}><Icon kind={resource.kind} /><span>{resource.name}</span></button>}
    <small>{hint}</small>
  </div>;
}

export function ResourceFields({ value, onChange, host, disabled = false, title = '资料' }: {
  value: ResourceReference[]; onChange: (value: ResourceReference[]) => void;
  host?: HostCapabilities; disabled?: boolean; title?: string;
}) {
  const native = useResourceHost(host, value);
  const [addingLink, setAddingLink] = useState(false);
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [rename, setRename] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const locked = disabled || native.busy;
  function append(items: ResourceReference[]) {
    onChange([...new Map([...value, ...items].map(item => [item.id, item])).values()]);
  }
  async function pick(kind: 'file' | 'folder') {
    if (!host?.resourcePick) return;
    const items = await native.run(() => host.resourcePick!({ kind }));
    if (items) append(items);
  }
  function addLink(raw = link) {
    try {
      const url = new URL(raw.trim()).href;
      const resource = ResourceReferenceSchema.parse({ id: crypto.randomUUID(), kind: 'web', name: name.trim() || new URL(url).hostname, url });
      const existing = value.find(item => item.kind === 'web' && item.url === url);
      if (existing) { native.setError('这条链接已经关联。'); return; }
      append([resource]); setLink(''); setName(''); setAddingLink(false); native.setError('');
    } catch { native.setError('请输入完整的 http:// 或 https:// 网页地址。'); }
  }
  async function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault(); event.stopPropagation(); setDragging(false);
    if (locked) return;
    if (event.dataTransfer.files.length) {
      if (!host?.resourceDrop) { native.setError('请在电脑端选择文件。'); return; }
      const items = await native.run(() => host.resourceDrop!(Array.from(event.dataTransfer.files)));
      if (items) append(items);
    } else {
      const text = event.dataTransfer.getData('text/uri-list').split(/\r?\n/).find(line => line && !line.startsWith('#')) || event.dataTransfer.getData('text/plain');
      if (text) addLink(text);
    }
  }
  async function relocate(resource: ResourceReference) {
    if (!host?.resourceRelocate || resource.kind === 'web') return;
    const replacement = await native.run(() => host.resourceRelocate!({ resource }));
    if (replacement) onChange(value.map(item => item.id === resource.id ? { ...replacement, name: item.name } : item));
    native.refresh(); setMenu(null);
  }
  function saveName(resource: ResourceReference) {
    try {
      const renamed = ResourceReferenceSchema.parse({ ...resource, name: rename.trim() });
      onChange(value.map(item => item.id === resource.id ? renamed : item)); setEditing(null);
    } catch { native.setError('请填写资料名称（最多 200 字）。'); }
  }
  return <fieldset className={`resource-fields${dragging ? ' drag-over' : ''}`} disabled={disabled}
    onDragOver={event => { event.preventDefault(); event.stopPropagation(); if (!locked) setDragging(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => void drop(event)}>
    <legend><Paperclip aria-hidden="true" />{title}</legend>
    {value.length > 0 && <ul className="resource-list">{value.map(resource => <li key={resource.id}>
      <div className="resource-row">
        <ResourceLink resource={resource} host={host} status={native.statuses[resource.id]} disabled={locked}
          open={item => { if (host?.resourceOpen) void native.run(() => host.resourceOpen!({ resource: item })); }} />
        <button type="button" className="ui-btn sm ghost icon" disabled={locked} aria-label={`管理资料 ${resource.name}`} aria-expanded={menu === resource.id}
          onClick={() => { setMenu(menu === resource.id ? null : resource.id); setEditing(null); }}><MoreHorizontal aria-hidden="true" /></button>
      </div>
      {menu === resource.id && <div className="resource-actions">
        <button type="button" className="ui-btn sm ghost" disabled={locked} onClick={() => { setEditing(resource.id); setRename(resource.name); }}>改名称</button>
        {resource.kind !== 'web' && host?.resourceRelocate && native.statuses[resource.id] !== 'other-device' &&
          <button type="button" className="ui-btn sm ghost" disabled={locked} onClick={() => void relocate(resource)}>重新定位</button>}
        <button type="button" className="ui-btn sm ghost" disabled={locked} title="只移除关联，不删除原文件" onClick={() => { onChange(value.filter(item => item.id !== resource.id)); setMenu(null); }}>解除关联</button>
      </div>}
      {editing === resource.id && <div className="resource-rename">
        <label>资料名称<input value={rename} maxLength={200} onChange={event => setRename(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveName(resource); } }} /></label>
        <button type="button" className="ui-btn sm" disabled={locked || !rename.trim()} onClick={() => saveName(resource)}>完成</button>
      </div>}
    </li>)}</ul>}
    <div className="resource-add">
      {host?.resourcePick && <><button type="button" className="ui-btn sm" disabled={locked} onClick={() => void pick('file')}><FileText aria-hidden="true" />文件</button>
        <button type="button" className="ui-btn sm" disabled={locked} onClick={() => void pick('folder')}><Folder aria-hidden="true" />文件夹</button></>}
      <button type="button" className="ui-btn sm" disabled={locked} onClick={() => setAddingLink(!addingLink)}><Plus aria-hidden="true" />网页</button>
      {host?.resourceDrop && !value.length && <small>也可将文件拖到这里</small>}
    </div>
    {addingLink && <div className="resource-url">
      <label>网页地址<input type="url" value={link} placeholder="https://" onChange={event => setLink(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addLink(); } }} /></label>
      <label>显示名称（可选）<input value={name} maxLength={200} onChange={event => setName(event.target.value)} /></label>
      <button type="button" className="ui-btn sm" disabled={locked || !link.trim()} onClick={() => addLink()}>添加链接</button>
    </div>}
    {native.error && <p className="resource-error" role="alert">{native.error}</p>}
  </fieldset>;
}

function ResourceOwnerEditor({ snapshot, target, ui, close }: { snapshot: Snapshot; target: ResourceTarget; ui: PlannerUI; close: () => void }) {
  const owner = resourceOwner(snapshot, target);
  const [baseline] = useState(owner);
  const [resources, setResources] = useState(baseline?.resources ?? emptyResources);
  const [scope, setScope] = useState<'single' | 'this-and-following'>('single');
  if (!owner) return null;
  const recurring = target.entity === 'block' && 'recurrence' in owner && owner.recurrence;
  async function save() {
    if (!owner || !baseline) return;
    const mutation = MutationSchema.parse(recurring
      ? { type: 'updateRecurringEvent', id: owner.id, expectedVersion: baseline.version, scope, values: { resources } }
      : { type: 'update', entity: target.entity, id: owner.id, expectedVersion: baseline.version, values: { resources }, ...(target.entity === 'course' ? { scope: 'all' as const } : {}) });
    const result = await ui.mutate([mutation]);
    if (result && result.status !== 'clarification') close();
  }
  return <div className="resource-owner-editor">
    <header><strong>{ownerNames[target.entity]} · {owner.title}</strong><button className="ui-btn sm ghost icon" type="button" onClick={close} aria-label="收起资料管理"><X aria-hidden="true" /></button></header>
    {(target.entity === 'course' || target.entity === 'goal') && <p className="resource-scope">公共资料，关联任务和安排会同步显示。</p>}
    {recurring && <label>资料修改范围<select value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="single">仅本次</option><option value="this-and-following">本次及以后</option></select></label>}
    {recurring && scope === 'this-and-following' && <p className="resource-scope">同步本次增删或改名的资料，保留每次独有资料。</p>}
    <ResourceFields value={resources} onChange={setResources} host={ui.host} disabled={ui.busy} />
    <div className="resource-actions"><button type="button" className="ui-btn sm dark" disabled={ui.busy || JSON.stringify(resources) === JSON.stringify(baseline?.resources ?? [])} onClick={() => void save()}>保存资料</button><button type="button" className="ui-btn sm ghost" onClick={close}>取消</button></div>
  </div>;
}

export function ResourceSection({ snapshot, target, ui, inheritedOnly = false }: { snapshot: Snapshot; target: ResourceTarget; ui: PlannerUI; inheritedOnly?: boolean }) {
  const entries = resolveResources(snapshot, target).filter(entry => !inheritedOnly || entry.inherited);
  const native = useResourceHost(ui.host, entries.map(entry => entry.resource));
  const [editing, setEditing] = useState<ResourceTarget | null>(null);
  const groupNames = { own: target.entity === 'block' ? '本次资料' : target.entity === 'task' ? '任务资料' : '公共资料', task: '任务资料', shared: '课程与目标资料' };
  if (inheritedOnly && !entries.length) return null;
  return <section className="resource-section" aria-label={inheritedOnly ? '继承的资料' : '资料'}>
    {!inheritedOnly && <header><h4><Paperclip aria-hidden="true" />资料</h4><button type="button" className="ui-btn sm ghost" onClick={() => setEditing(target)}>管理</button></header>}
    {!entries.length && !editing && <p className="resource-empty">关联文件、文件夹或网页</p>}
    {(['own', 'task', 'shared'] as const).map(group => {
      const items = entries.filter(entry => entry.group === group);
      if (!items.length) return null;
      return <div className="resource-group" key={group}>
        <h5>{groupNames[group]}</h5>
        <ul className="resource-list">{items.map(entry => <li key={entry.resource.id}>
          <div className="resource-row"><ResourceLink resource={entry.resource} host={ui.host} status={native.statuses[entry.resource.id]} disabled={native.busy}
            open={resource => { if (ui.host?.resourceOpen) void native.run(() => ui.host!.resourceOpen!({ resource })); }} />
            {entry.inherited && <button type="button" className="ui-btn sm ghost icon" aria-label={`管理来源 ${entry.ownerTitle}`} title={`在${ownerNames[entry.owner.entity]}「${entry.ownerTitle}」中管理`} onClick={() => setEditing(entry.owner)}><MoreHorizontal aria-hidden="true" /></button>}</div>
          {entry.inherited && <small className="resource-source">来自{ownerNames[entry.owner.entity]} · {entry.ownerTitle}</small>}
        </li>)}</ul>
      </div>;
    })}
    {native.error && <p className="resource-error" role="alert">{native.error}</p>}
    {editing && <ResourceOwnerEditor key={`${editing.entity}:${editing.id}`} snapshot={snapshot} target={editing} ui={ui} close={() => setEditing(null)} />}
  </section>;
}
