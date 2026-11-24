export type WechatHistoryWindow = { direction: 'older' | 'newer'; since: number };
type Cursors = { latest: string | null; inspection: string | null };
type Page = { nextCursor: string | null; latestCursor?: string | null };

const PAGE_LIMIT = 200;
const INSPECTION_PAGES = 4;

/** Inspect the visible seven-day window cyclically. Ascending keyset reads
 * independently catch up with arrivals, even if a burst spans several polls. */
export async function pollWechatHistory(
  initial: Cursors, read: (cursor: string | null, direction: WechatHistoryWindow['direction']) => Promise<Page>,
  checkpoint: (progress: Cursors) => void,
) {
  let { latest, inspection } = initial;
  const inspectionLimit = latest ? INSPECTION_PAGES : PAGE_LIMIT;
  let inspected = 0, caughtUp = false;
  const seen = new Set<string>();
  function inspect(page: Page) {
    if (page.nextCursor && (page.nextCursor === inspection || seen.has(page.nextCursor))) throw Error('微信历史巡检游标未前进');
    inspection = page.nextCursor;
    if (inspection) seen.add(inspection);
    inspected++;
  }
  if (!latest || !inspection) {
    const head = await read(null, 'older');
    caughtUp = !latest || !head.nextCursor || latest === head.latestCursor;
    if (caughtUp) latest = head.latestCursor ?? latest;
    inspect(head);
    checkpoint({ latest, inspection });
  }
  for (let page = 0; !caughtUp && latest && page < PAGE_LIMIT - INSPECTION_PAGES; page++) {
    const newer = await read(latest, 'newer');
    if (newer.nextCursor && (!newer.latestCursor || newer.latestCursor === latest || newer.latestCursor !== newer.nextCursor))
      throw Error('微信最新消息游标未前进');
    latest = newer.latestCursor ?? latest;
    caughtUp = !newer.nextCursor;
    checkpoint({ latest, inspection });
  }
  while (inspection && inspected < inspectionLimit) {
    inspect(await read(inspection, 'older'));
    checkpoint({ latest, inspection });
  }
  return !caughtUp ? '本轮已达到分页上限，下一轮将继续读取新消息和复查最近七天' :
    inspection ? '最近七天的本机记录正在分次复查；未同步到电脑的消息无法补采' :
    '已读取当前可见的本机记录；未同步到电脑的消息无法补采';
}
