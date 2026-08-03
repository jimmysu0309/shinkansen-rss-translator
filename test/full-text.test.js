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

// og:image hero 補圖(離線)。
//
// 訊號層次:
//   ✓ Readability 丟掉 lead image 時,og:image 前置為 hero
//   ✓ 正文已有同一張圖(pathname 相同、CDN 參數不同)→ 不重複前置
//   ✓ 正文開頭已有 hero 等級圖(width >= 200 或未標寬)→ 不前置
//   ✓ 開頭只有頭像小圖(width < 200)→ 照樣前置 hero
//   ✗ 不驗:真實站點 og:image 品質(站方放 logo 當 og:image 的情況)
describe('og:image hero 補圖', () => {
  const makePage = ({ og, bodyExtra = '' }) => `<!DOCTYPE html><html><head>
    ${og ? `<meta property="og:image" content="${og}">` : ''}
  </head><body><article>
    <h1>標題</h1>${bodyExtra}
    <p>這是文章第一段,內容夠長,readability 才會保留下來當作正文的一部分,不會被當成雜訊丟掉。</p>
    <p>第二段也要夠長才會被保留下來,再多寫一點字數充版面確保 readability 抽得出正文喔。</p>
  </article></body></html>`;

  it('正文沒圖 + 有 og:image → 前置 hero figure', () => {
    const out = extractReadable(
      makePage({ og: 'https://cdn.ex.com/hero.jpg?w=1200' }), 'https://ex.com/a');
    expect(out.startsWith('<figure><img src="https://cdn.ex.com/hero.jpg?w=1200"')).toBe(true);
  });

  it('正文已有同一張圖(pathname 同、參數不同)→ 不重複', () => {
    const out = extractReadable(
      makePage({
        og: 'https://cdn.ex.com/hero.jpg?w=1200',
        bodyExtra: '<p><img src="https://cdn.ex.com/hero.jpg?w=640"> 圖說文字也湊一點長度</p>',
      }), 'https://ex.com/a');
    expect(out.match(/hero\.jpg/g).length).toBe(1);
    expect(out.startsWith('<figure>')).toBe(false);
  });

  it('開頭已有 hero 等級圖(未標寬度)→ 不前置', () => {
    const out = extractReadable(
      makePage({
        og: 'https://cdn.ex.com/hero.jpg',
        bodyExtra: '<figure><img src="https://cdn.ex.com/lead.jpg"></figure>',
      }), 'https://ex.com/a');
    expect(out).not.toContain('hero.jpg');
  });

  it('開頭只有頭像小圖(width=36)→ 照樣前置 hero', () => {
    const out = extractReadable(
      makePage({
        og: 'https://cdn.ex.com/hero.jpg',
        bodyExtra: '<p><img src="https://cdn.ex.com/avatar.jpg" width="36"> 作者頭像列</p>',
      }), 'https://ex.com/a');
    expect(out.startsWith('<figure><img src="https://cdn.ex.com/hero.jpg"')).toBe(true);
  });

  it('沒有 og:image → 正文不動', () => {
    const out = extractReadable(makePage({ og: null }), 'https://ex.com/a');
    expect(out).not.toContain('<figure>');
  });

  // 2026-08-03 9to5Mac hero 重複回歸:og:image 走 Photon CDN(主機塞進 path)、
  // 內文同圖走原站 → pathname 不同;且首圖 tag 帶超長 srcset,閉合 > 落在掃描窗外
  it('Photon CDN og:image(i0.wp.com/原站/…)vs 原站內文同圖 → 不重複前置', () => {
    const out = extractReadable(
      makePage({
        og: 'https://i0.wp.com/9to5mac.com/wp-content/uploads/hero.jpg?resize=1200%2C628&ssl=1',
        bodyExtra: '<figure><img width="1600" src="https://9to5mac.com/wp-content/uploads/hero.jpg?w=1600"> 首圖說明文字</figure>',
      }), 'https://9to5mac.com/a');
    expect(out.match(/hero\.jpg/g).length).toBe(1);
    expect(out.startsWith('<figure><img src="https://i0.wp.com')).toBe(false);
  });

  it('開頭 hero 圖帶超長 srcset(tag 超過掃描窗)→ 仍視為已有 hero,不前置', () => {
    const srcset = Array.from({ length: 14 }, (_, i) =>
      `https://cdn.ex.com/lead.jpg?w=${(i + 1) * 320}&quality=82&strip=all&ssl=1 ${(i + 1) * 320}w`).join(', ');
    expect(srcset.length).toBeGreaterThan(600); // 前提:tag 一定超過 HERO_SCAN_CHARS
    const out = extractReadable(
      makePage({
        og: 'https://cdn.ex.com/other-hero.jpg',
        bodyExtra: `<figure><img width="1600" src="https://cdn.ex.com/lead.jpg" srcset="${srcset}"> 說明</figure>`,
      }), 'https://ex.com/a');
    expect(out).not.toContain('other-hero.jpg');
  });

  it('一般路徑段含點(/v1.2/…)不會被誤剝主機前綴', () => {
    const out = extractReadable(
      makePage({
        og: 'https://cdn.ex.com/v1.2/hero.jpg',
        bodyExtra: '<p><img src="https://cdn.ex.com/v1.2/hero.jpg?w=640"> 圖說湊長度文字文字</p>',
      }), 'https://ex.com/a');
    expect(out.match(/hero\.jpg/g).length).toBe(1); // 同圖仍要比對得到(不前置第二張)
  });
});

// Readability 重複抽取去重(離線)。
//
// 訊號層次:
//   ✓ 同 pathname 的重複圖只留第一張(含空殼 figure 一併移除)
//   ✓ 相鄰重複文字段(> 20 字)只留一份;不相鄰 / 短句不動
//   ✓ skip link(#錨點整段)移除
//   ✗ 不驗:真實站點雙版本結構的完整樣態(以最小結構代表)
describe('Readability 重複抽取去重', () => {
  const PAGE2 = `<!DOCTYPE html><html><head></head><body><article>
    <p><a href="#content">跳至主要內容</a></p>
    <p>這段導言重複了兩次,長度超過二十個字才會觸發相鄰去重的保守規則喔。</p>
    <p>這段導言重複了兩次,長度超過二十個字才會觸發相鄰去重的保守規則喔。</p>
    <figure><img src="https://cdn.ex.com/lead.jpg?w=376"></figure>
    <figure><img src="https://cdn.ex.com/lead.jpg?w=750"></figure>
    <p>正文第一段,內容夠長,readability 才會保留下來當作正文的一部分,不會被丟掉。</p>
    <p>短句重複</p><p>短句重複</p>
    <p>正文第二段也要夠長才會被保留下來,再多寫一點字數充版面確保抽得出正文喔。</p>
  </article></body></html>`;

  it('重複 lead 圖只留一張、重複導言只留一份、skip link 移除', () => {
    const out = extractReadable(PAGE2, 'https://ex.com/a');
    expect(out.match(/lead\.jpg/g).length).toBe(1);
    expect(out.match(/這段導言重複了兩次/g).length).toBe(1);
    expect(out).not.toContain('跳至主要內容');
  });

  it('Photon CDN 版與原站版同圖(主機塞 path)→ 也去重', () => {
    const page = `<!DOCTYPE html><html><body><article>
      <figure><img src="https://i0.wp.com/ex.com/uploads/lead.jpg?w=376"></figure>
      <figure><img src="https://ex.com/uploads/lead.jpg?w=750"></figure>
      <p>正文第一段,內容夠長,readability 才會保留下來當作正文的一部分,不會被丟掉。</p>
      <p>正文第二段也要夠長才會被保留下來,再多寫一點字數充版面確保抽得出正文喔。</p>
    </article></body></html>`;
    const out = extractReadable(page, 'https://ex.com/a');
    expect(out.match(/lead\.jpg/g).length).toBe(1);
  });

  it('短句重複(<= 20 字)不動', () => {
    const out = extractReadable(PAGE2, 'https://ex.com/a');
    expect(out.match(/短句重複/g).length).toBe(2);
  });
});
