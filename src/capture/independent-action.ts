import type { ExtractedCandidate } from '../ai/schemas';
import type { Candidate, Source } from '../shared/contracts';
import { candidateDatesConflict } from '../domain/candidate-dates';
import { WorkflowError } from '../ai/deepseek';

const pairedSubmission = /(?:连同|随同|以及|和|与|跟)(?:之前的|原来的|原有的|此前的|原先的)?([\p{Script=Han}A-Za-z0-9]{2,30}?)(?:一起|一并|一同|共同|同时)(?:提交|上交|交回|交齐|交给|交上|交)/gu;
const workVerb = '手写完成|手写作答|手写填写|撰写|编写|绘制|制作|录制|拍摄|填写|编制|设计|作答|完成';
const objectAfter = new RegExp('(' + workVerb + ')(?:一[份张段篇幅本套])?([\\p{Script=Han}A-Za-z0-9]{2,30})$', 'u');
const objectBefore = new RegExp('(?:把|将)([\\p{Script=Han}A-Za-z0-9]{2,30}?)(打印|复印|' + workVerb + ')', 'u');
const production = new RegExp(workVerb, 'u');

/** For older supplement proposals require both an instruction to produce a *different* item
 * and an explicit joint submission with the named existing deliverable. Printing copies,
 * carrying supplies, shared dates and generic extra steps alone do not meet these conditions. */
function jointDeliverable(text: string, target: Candidate) {
  const pairs = [...text.matchAll(pairedSubmission)];
  if (pairs.length !== 1) return;
  const pair = pairs[0]!, original = pair[1]!;
  if (![target.title, target.action].some(field => field.includes(original))) return;
  const clauses = text.slice(0, pair.index).split(/[，,；;。！？!?\n]/).map(value => value.trim()).filter(Boolean).slice(-4);
  for (let index = clauses.length - 1; index >= 0; index--) {
    const clause = clauses[index]!;
    const before = objectBefore.exec(clause), after = objectAfter.exec(clause);
    if (!before && !after) continue;
    const name = (before?.[1] ?? after![2]!).replace(/^(?:(?:附件中|附件里|上面|上述|这次|这[张份本]|下面|本次)的?)+/, '');
    if (name.length < 2 || /^(?:之后|以后|的话|即可)$/.test(name) || name.includes(original) || original.includes(name)
        || [target.title, target.action.split('\n补充：')[0]!].some(field => field.includes(name))
        || /封面|页码|装订|签名栏|复印件|打印件|一式|份数|格式|模板|示例/.test(name)) continue;
    const instruction = clauses.slice(index).join('，');
    if (/(?:无[需须]|不用|不要|不必|不需要|不再|如需|如果|例如|比如)/.test(instruction)) continue;
    const verb = before?.[2] ?? after![1]!;
    if (verb === '打印' || verb === '复印') {
      const following = instruction.slice(instruction.indexOf(verb) + verb.length);
      const authored = production.exec(following);
      if (!authored) continue;
      return { name, title: verb + '并' + authored[0] + name };
    }
    return { name, title: verb + name };
  }
}

export function distinguishIndependentAction(item: ExtractedCandidate, source: Source, existing: Candidate[], sources: Source[], independentOf?: string): ExtractedCandidate {
  if (!independentOf && item.relation.kind !== 'supplement' && item.relation.kind !== 'duplicate') return item;
  const target = existing.find(candidate => candidate.id === (independentOf ?? item.relation.candidateId));
  if (!target) {
    if (independentOf) throw new WorkflowError('AI_RESPONSE', '新增行动引用的原事项不在本群，请核对来源');
    return item;
  }
  // Only the cited current message can establish an extra deliverable. A shortened quote may
  // omit the joint hand-in clause, but it must still name the item the user has to produce.
  let work = jointDeliverable(item.sourceQuote, target);
  if (!work && source.kind === 'text' && source.text.length <= 1600 && source.text.includes(item.sourceQuote)) {
    const fromMessage = jointDeliverable(source.text, target);
    if (fromMessage && item.sourceQuote.includes(fromMessage.name)) work = fromMessage;
  }
  if (!work && !independentOf) return item;
  if (!work && independentOf) {
    const originalName = target.title.replace(/^(?:按时|提交|上交|交付|完成|准备)+/, '');
    const formatOnly = originalName.length >= 2 && item.sourceQuote.includes(originalName)
      && /打印|复印|一式/.test(item.sourceQuote)
      && !item.sourceQuote.replaceAll(originalName, '').replace(/请|把|将|需[要]?|使用|采用|改为|改成|提交|上交|双面|单面|黑白|彩色|打印|复印|一式|[一二两三四五六七八九十\d]+份|A[345]纸?|[。，、；：,\s]/gi, '');
    const quotedAction = item.sourceQuote.trim().replace(/^请/, '').replace(/[。！!]+$/, '');
    const repeatsOriginal = item.sourceQuote === target.sourceQuote && [target.title, target.action].includes(quotedAction);
    if (repeatsOriginal || (item.action.trim() && target.action.includes(item.action.trim())) || formatOnly) {
      return { ...item, relation: { kind: 'supplement', candidateId: target.id } };
    }
  }
  const title = work?.title ?? item.title;
  const action = work && !item.action.includes(work.name) ? title : item.action;
  // A repeat can still arrive linked to the older card. Reuse the already-created independent
  // root when its action and original evidence match, without reviving a prior user decision.
  const previous = existing.find(candidate => candidate.id !== target.id && !candidate.revisionOfId && !candidate.duplicateOfId
    && (candidate.sourceQuote === item.sourceQuote && candidate.title === title ||
      work && jointDeliverable(candidate.sourceQuote, target)?.name === work.name && candidate.title.includes(work.name))
    && !candidateDatesConflict(candidate, item, [...sources, source]));
  return { ...item, title, action, relation: previous ? { kind: 'supplement', candidateId: previous.id } : { kind: 'new', candidateId: null } };
}
