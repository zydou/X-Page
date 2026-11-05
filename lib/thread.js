/**
 * lib/thread.js
 * ============================================================
 * 串推（自推链）的纯逻辑：墓碑判定、补全门控、补全闭包、后代筛选。
 *
 * 不做 I/O：补全所需的会话数据经注入的 io 获取，
 * 因此可用抓取的 fxtwitter 样本离线验证。
 *
 * fxtwitter v2 已验证的行为（OpenAPI + 实测）：
 *   - /2/thread 向下遍历在被删推处截断；向上遍历可穿过墓碑
 *   - /2/conversation 的 thread 可穿过墓碑补回父链，墓碑本身不带 replying_to
 *   - /2/conversation 的 replies 是整个会话的回复（平铺，带 replying_to），
 *     默认按 likes 排序，cursor.bottom 翻页
 * ============================================================
 */

const authorOf = (p) => p?.author?.screen_name ?? null;
const byTime = (a, b) => (a.created_timestamp || 0) - (b.created_timestamp || 0);

/**
 * 墓碑：被删 / 被封 / 私密等不可用推文的占位对象（无正文、无时间）。
 * 补全时把它当作链上的一个点，但渲染时不输出。
 *
 * @param {Object|null} post
 * @returns {boolean}
 */
export function isTombstone(post) {
  if (!post || !post.id) return true;
  if (post.type === "tombstone") return true;
  return !post.author && !post.text && !post.html_no_media;
}

/**
 * 补全门控：只对"自推链"触发。
 * 条件：thread 中出现墓碑，或存在同作者的回复链接。
 * 单推、他人回复他人的推文都不满足，因此零额外请求。
 *
 * @param {Array} thread /2/thread 返回的 thread[]
 * @returns {boolean}
 */
export function needsSelfThreadRepair(thread) {
  if (thread.some((p) => p && p.type === "tombstone")) return true;
  const live = new Map(thread.filter((p) => !isTombstone(p)).map((p) => [p.id, p]));
  for (const p of live.values()) {
    const parent = live.get(p.replying_to?.status);
    if (parent && authorOf(parent) === authorOf(p)) return true;
  }
  return false;
}

/**
 * 根推：thread 中没有父节点的活推文，取最早的一条。
 *
 * @param {Array} thread
 * @returns {Object|null}
 */
export function findRoot(thread) {
  const roots = thread.filter((p) => !isTombstone(p) && !p.replying_to?.status);
  roots.sort(byTime);
  return roots[0] ?? null;
}

/**
 * 从会话祖先链推出墓碑的父节点。
 *
 * path 是某条回复的会话祖先链（含墓碑；child 为挂在墓碑下的那条回复）：
 *   - 去掉 child 及其后代（路径上位于墓碑之下的部分），剩下的是墓碑之上的祖先
 *   - 这些祖先中唯一"没有被其他祖先当作父节点引用"的那一个，就是墓碑的父
 * 只处理链上恰有一个墓碑的情况；多墓碑或不唯一时返回 null（宁可不补，也不猜测）。
 *
 * @param {Array} path 会话祖先链
 * @param {string} tombId 墓碑 id
 * @returns {string|null}
 */
function parentOfTombstone(path, tombId) {
  if (path.filter((p) => isTombstone(p)).length !== 1) return null;
  const child = path.find((p) => !isTombstone(p) && p.replying_to?.status === tombId);
  if (!child) return null;
  const below = new Set([child.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of path) {
      if (!isTombstone(p) && !below.has(p.id) && below.has(p.replying_to?.status)) {
        below.add(p.id);
        grew = true;
      }
    }
  }
  const above = path.filter((p) => !isTombstone(p) && !below.has(p.id));
  const referenced = new Set(above.map((p) => p.replying_to?.status));
  const tips = above.filter((p) => !referenced.has(p.id));
  return tips.length === 1 ? tips[0].id : null;
}

/**
 * 会话祖先链是否属于同一条自推链：含根（无父节点的活推文），
 * 且除墓碑外全部同作者。
 *
 * @param {Array} path 会话祖先链
 * @param {string} author 自推链的作者 screen_name
 * @returns {boolean}
 */
function isSelfChain(path, author) {
  return (
    path.some((p) => p && !isTombstone(p) && !p.replying_to?.status) &&
    path.every((p) => isTombstone(p) || authorOf(p) === author)
  );
}

/**
 * 补全自推链，返回补全后的 thread。
 *
 * 保留原有项，追加补回的同作者节点；被补上父链的墓碑带上 replying_to，
 * 使向下遍历（descendantsOf）能穿过它。墓碑本身不渲染。
 *
 * 算法：
 *   0. 若 thread 中没有根（fxtwitter 对中段请求偶尔省略根）：取一条活节点的会话祖先链，
 *      确认是同作者自推链后并入，从中定位根
 *   1. 以根为起点，从会话回复中收集同作者回复，闭包并入（父节点已在链上才加入）
 *   2. 某回复的父节点既不是已知活推文、也未尝试过 → 父节点是被删推。
 *      调 fetchChain(该回复)：若祖先链上包含该墓碑、通到根、且除墓碑外全部同作者，
 *      则并入该链并推出墓碑的父节点，再闭包一次
 *   3. 所有 fetchChain 调用总数不超过 maxBridges
 *
 * @param {Array} thread /2/thread 的 thread[]
 * @param {Object} io
 * @param {(rootId: string, author: string) => Promise<Array>} io.fetchReplies
 *        会话回复（可跨页；由调用方决定翻页策略）
 * @param {(id: string) => Promise<Array>} io.fetchChain
 *        该推的会话祖先链 thread[]（能穿过墓碑）
 * @param {{maxBridges?: number}} [opt]
 * @returns {Promise<Array>}
 */
export async function repairSelfThread(thread, io, { maxBridges = 3 } = {}) {
  if (!needsSelfThreadRepair(thread)) return thread;

  const out = new Map(thread.filter((p) => p && p.id).map((p) => [p.id, p]));
  const chain = new Set(out.keys());
  const settled = new Set(); // 已尝试过的墓碑父节点 id（接受或拒绝），不重复回源
  const resolved = new Set(); // 已补上父节点的墓碑 id
  let budget = maxBridges;

  // 并入一条会话祖先链：活节点直接并入；墓碑按 parentOfTombstone 补上父节点
  const absorb = (path) => {
    for (const p of path) {
      if (!isTombstone(p) && !chain.has(p.id)) {
        chain.add(p.id);
        out.set(p.id, p);
      }
    }
    for (const t of path.filter((p) => p && isTombstone(p))) {
      const parent = resolved.has(t.id) ? null : parentOfTombstone(path, t.id);
      if (!parent) continue;
      resolved.add(t.id);
      chain.add(t.id);
      out.set(t.id, { ...t, replying_to: { status: parent } });
    }
  };

  if (!findRoot([...out.values()])) {
    const seed = [...out.values()].find((p) => !isTombstone(p));
    if (!seed || budget <= 0) return thread;
    budget--;
    const path = await io.fetchChain(seed.id);
    if (!isSelfChain(path, authorOf(seed))) return thread;
    absorb(path);
  }
  const root = findRoot([...out.values()]);
  if (!root) return thread;
  const author = authorOf(root);

  const replies = await io.fetchReplies(root.id, author);
  const known = new Set(
    [...out.values(), ...replies].filter((p) => p && p.id && !isTombstone(p)).map((p) => p.id)
  );
  const sameAuthor = replies.filter(
    (p) => p && p.id && !isTombstone(p) && p.replying_to?.status && authorOf(p) === author
  );
  const attach = () => {
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of sameAuthor) {
        if (chain.has(p.id) || !chain.has(p.replying_to.status)) continue;
        chain.add(p.id);
        out.set(p.id, p);
        grew = true;
      }
    }
  };

  attach();
  for (let progress = true; progress && budget > 0; ) {
    progress = false;
    for (const r of [...out.values(), ...sameAuthor]) {
      if (budget <= 0) break;
      const P = r.replying_to?.status;
      if (!P || known.has(P) || settled.has(P) || resolved.has(P)) continue;
      budget--;
      settled.add(P);

      const path = await io.fetchChain(r.id);
      const linked =
        path.some((p) => p && p.id === P && isTombstone(p)) &&
        path.some((p) => p && p.id === root.id) &&
        path.every((p) => isTombstone(p) || authorOf(p) === author);
      if (!linked) continue;
      absorb(path);
      attach();
      progress = true;
    }
  }
  return [...out.values()];
}

/**
 * 串推后代：从 pid 沿 replying_to 向下闭包，墓碑参与传递。
 * 只向下走，因此不受祖先方向断链的影响，也不会把根推或其他分支误判为后代。
 *
 * @param {string} pid 请求的推文 id
 * @param {Array} thread 原始 thread[]（含墓碑；墓碑本身不输出）
 * @returns {Array} 按 created_timestamp 升序的活推文
 */
export function descendantsOf(pid, thread) {
  const nodes = thread.filter((p) => p && p.id);
  const desc = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of nodes) {
      if (!desc.has(p.id) && desc.has(p.replying_to?.status)) {
        desc.add(p.id);
        grew = true;
      }
    }
  }
  return nodes
    .filter((p) => p.id !== pid && desc.has(p.id) && !isTombstone(p))
    .sort(byTime);
}
