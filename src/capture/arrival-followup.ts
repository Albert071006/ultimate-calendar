import { WorkflowError } from '../ai/deepseek';
import type { ExtractedCandidate } from '../ai/schemas';
import type { Candidate } from '../shared/contracts';

export interface ArrivalFollowupInput {
  candidate: ExtractedCandidate;
  unit: { id: string; messageId: string; text: string; attachmentId: string | null; imageDataUrl: string | null };
  context: readonly { id: string; text: string }[];
  /** The caller must already restrict these candidates to this account and group. */
  existingCandidates: readonly Candidate[];
}

const latePermission = /(?:可以|允许|可)(?:稍微|稍|适当)?(?:晚(?:一点|一些|点)?|迟(?:一点|一些|点)?)(?:一会儿?)?(?:再)?(?:来|到(?:场|达)?|抵达)|(?:可以|允许|可)(?:稍微|稍)?迟到/;
const arrivalLimit = /(?:最晚|最迟|务必|必须|须|不得晚于)[^。！？\n]{0,32}(?:到场|到达|抵达|到|来)/;
const followupLabel = /^(?:补充(?:说明|通知)?|再(?:补充|说明)(?:一下)?|另外说明)[：:，,\s]/;
const eventNoun = /会议|周见面|见面会|交流会|讨论会|报告会|读书会|研讨会|座谈会|班会|讲座|培训|活动|课程|课|排练|工作坊/;
const clock = /\d{1,2}[:：]\d{2}|(?:上午|下午|中午|晚上|晚间)?[一二三四五六七八九十两\d]{1,3}[点时]/;
const eventAnnouncement = /举行|举办|召开|开展|开课|上课|开会|开始|集合|(?:在[^。！？\n]{1,30})开(?:一场|一次)?/;
// Require an event/time subject. A particular person's arrival adjustment is not a global reschedule.
const globalReschedule = /(?:会议|周见面(?:会)?|见面会|交流会|讨论会|报告会|读书会|研讨会|座谈会|班会|讲座|培训|活动|课程|排练|工作坊|开始时间|集合时间)(?:时间)?\s*(?:现|将|已|统一|整体|全部|一律)*(?:改到|改为|调整到|推迟到|延期至)|(?:全体|所有人|大家)(?:的到场时间|的集合时间)?\s*(?:统一|整体|全部|一律)(?:改到|改为|调整到|推迟到|延期至)/;

function hasIndependentAnnouncement(text: string): boolean {
  // Only a complete affirmative sentence in the current message can establish a new event.
  // A course mentioned as the reason for being late, and a prior context message, cannot do so.
  return text.split(/[。！？\n]/).some(sentence => {
    const permission = sentence.search(latePermission);
    const announcement = permission < 0 ? sentence : sentence.slice(0, permission);
    if (/^\s*(?:明天|今天|后天)?(?:有人|有些人|有同学|有些同学|有.{0,12}课的(?:同学|人)|因为|如果|若)/.test(announcement)) return false;
    return clock.test(announcement) && eventNoun.test(announcement)
      && (eventAnnouncement.test(announcement) || /时间[：:]/.test(announcement) && /地点[：:]/.test(announcement));
  });
}

/** Reject only explicit dependent arrival exceptions, without choosing an event or rewriting evidence. */
export function assertArrivalFollowup(input: ArrivalFollowupInput): void {
  const { candidate, unit, existingCandidates } = input;
  if (unit.attachmentId !== null || unit.imageDataUrl !== null || unit.text.length > 4000
    || candidate.sourceIds.length !== 1 || candidate.sourceIds[0] !== unit.id
    || !unit.text.includes(candidate.sourceQuote)) return;
  const text = unit.text.trim();
  const permission = latePermission.exec(text);
  const labelledArrival = followupLabel.test(text) && arrivalLimit.test(text);
  if (!permission && !labelledArrival || globalReschedule.test(text) || hasIndependentAnnouncement(text)) return;

  // Context is interpretation aid, never a candidate identity. In particular context commonly
  // includes the current message itself; neither that nor the nearest prior message grants an ID.
  const hasPriorContext = input.context.some(message => message.id !== unit.messageId && message.text.trim());
  const target = candidate.relation.candidateId
    ? existingCandidates.find(item => item.id === candidate.relation.candidateId) : undefined;
  if (!target || !['supplement', 'duplicate'].includes(candidate.relation.kind)) {
    throw new WorkflowError('AI_RESPONSE', hasPriorContext
      ? '到场补充需要关联已确认身份的原事项；已有前文不能作为新活动依据，请校对原事项'
      : '到场补充缺少可验证的原事项，请补全前文后校对，不能据此生成独立活动');
  }
  if (candidate.eventStart && candidate.eventStart !== target.eventStart
    || candidate.eventEnd && candidate.eventEnd !== target.eventEnd
    || candidate.deadline && JSON.stringify(candidate.deadline) !== JSON.stringify(target.deadline)
    || candidate.temporalEvidence.some(evidence => evidence.basis !== 'unknown' && clock.test(evidence.quote))) {
    throw new WorkflowError('AI_RESPONSE', '到场补充不能把局部晚到例外改成活动起止或全员截止，请保留原安排并校对');
  }
  if (permission) {
    const summary = [candidate.action, ...candidate.conditions].join('；');
    const reason = text.slice(0, permission.index);
    for (const match of summary.matchAll(/(?:到达|抵达|赶到|前往|参加|到|去)(?:上|参加)?([\p{Script=Han}A-Za-z\d]{1,16}(?:课|考试|训练|值班|实验))/gu)) {
      const destination = match[1]!;
      const after = summary.slice(match.index! + match[0].length);
      // "参加实验课的同学" and "参加实验课后再到场" identify the affected group,
      // rather than commanding attendance at the reason activity.
      if (/^(?:的(?:同学|人|成员|人员|朋友)|后|结束|下课|完|时|者)|^[，,；;\s]*(?:结束|上完|下课|之后|然后|再)/.test(after)) continue;
      if (reason.includes(destination) && !target.title.includes(destination)) {
        throw new WorkflowError('AI_RESPONSE', '晚到原因不能被改写成到达或参加的目标，请关联原活动并校对到场说明');
      }
    }
    // A deliberately small set of explicit constraints prevents erasing the affected group.
    // It does not attempt to infer the user's classes, commitments or participation.
    const reasonKind = ['课', '考试', '实习', '训练', '值班', '实验'].find(word => reason.includes(word));
    if (!latePermission.test(summary) || reasonKind && !summary.includes(reasonKind)
      || /部分|个别/.test(reason) && !/部分|个别/.test(summary)) {
      throw new WorkflowError('AI_RESPONSE', '晚到补充必须保留适用对象与允许晚到的条件，不能改写成所有人的新要求，请校对');
    }
  }
}
