// full-text(readability 抓全文)測試(離線)。
//
// 訊號層次:
//   ✓ Readability 在 Node(linkedom)抽正文、去掉 nav/footer 雜訊
//   ✓ 圖片保留;相對 img/href 轉絕對網址
//   ✓ fetchFullText 用注入的 fetch,非 2xx 回 null
//   ✗ 不驗:真實網站(JS 渲染站抓不到是 readability 先天限制)
import { describe, it, expect } from 'vitest';
import { extractReadable, fetchFullText } from '../src/pipeline/full-text.js';

const PAGE = `<!DOCTYPE html><html><head><title>T</title></head><body>
  <nav>導覽列雜訊 menu junk</nav>
  <article>
    <h1>真正的標題</h1>
    <p>這是文章第一段,內容夠長,readability 才會保留下來當作正文的一部分,不會被當成雜訊丟掉。</p>
    <p>第二段,含一個 <a href="/rel/link">相對連結</a> 與一張圖片 <img src="/img/pic.jpg"> 也要夠長才會被保留下來喔。</p>
  </article>
  <footer>頁尾雜訊 footer junk</footer>
</body></html>`;

describe('extractReadable', () => {
  it('抽出正文、去雜訊、保留圖片', () => {
    const out = extractReadable(PAGE, 'https://ex.com/posts/a');
    expect(out).toBeTruthy();
    expect(out).toContain('<img');
    expect(out).toContain('文章第一段');
    expect(out).not.toContain('menu junk');   // nav 去掉
    expect(out).not.toContain('footer junk');  // footer 去掉
  });

  it('相對網址轉絕對(以文章網址為 base)', () => {
    const out = extractReadable(PAGE, 'https://ex.com/posts/a');
    expect(out).toContain('https://ex.com/img/pic.jpg');
    expect(out).toContain('https://ex.com/rel/link');
    expect(out).not.toContain('"/img/pic.jpg"'); // 不留相對
  });

  it('抽不出正文 → null', () => {
    expect(extractReadable('<html><body></body></html>', 'https://ex.com')).toBe(null);
  });
});

describe('fetchFullText', () => {
  it('用注入的 fetch 抓頁面 → 抽正文', async () => {
    const fakeFetch = async () => ({ ok: true, text: async () => PAGE });
    const out = await fetchFullText('https://ex.com/posts/a', { fetchImpl: fakeFetch });
    expect(out).toContain('文章第一段');
  });
  it('非 2xx → null', async () => {
    const fakeFetch = async () => ({ ok: false, status: 403, text: async () => '' });
    expect(await fetchFullText('https://ex.com/x', { fetchImpl: fakeFetch })).toBe(null);
  });

  it('請求帶 timeout signal(掛掉的站不能卡住翻譯管線)', async () => {
    let saw;
    const fakeFetch = async (url, init) => { saw = init; return { ok: true, text: async () => PAGE }; };
    await fetchFullText('https://ex.com/posts/a', { fetchImpl: fakeFetch });
    expect(saw.signal).toBeInstanceOf(AbortSignal);
  });

  it('content-length 宣告超過 5MB → null(不下載)', async () => {
    const fakeFetch = async () => ({
      ok: true,
      headers: { get: () => String(10 * 1024 * 1024) },
      text: async () => { throw new Error('不應該讀 body'); },
    });
    expect(await fetchFullText('https://ex.com/big', { fetchImpl: fakeFetch })).toBe(null);
  });

  it('實際內容超過 5MB(未宣告長度)→ null', async () => {
    const huge = '<p>' + 'x'.repeat(5 * 1024 * 1024 + 16) + '</p>';
    const fakeFetch = async () => ({ ok: true, text: async () => huge });
    expect(await fetchFullText('https://ex.com/big2', { fetchImpl: fakeFetch })).toBe(null);
  });
});
