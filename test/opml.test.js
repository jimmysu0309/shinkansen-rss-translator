// OPML 匯入 / 匯出測試(離線)。
//
// 訊號層次:
//   ✓ 匯出:每個 feed 一個 outline,xmlUrl=譯後網址、htmlUrl=來源、屬性跳脫
//   ✓ 匯入:解析標準 OPML(含資料夾巢狀),取出 xmlUrl / title
//   ✓ round-trip:匯出再解析得回來源清單
//   ✗ 不驗:各家閱讀器方言
import { describe, it, expect } from 'vitest';
import { feedsToOpml, parseOpml } from '../src/pipeline/opml.js';

describe('feedsToOpml', () => {
  const feeds = [
    { id: 1, title: 'Tech Blog', source_url: 'https://ex.com/feed' },
    { id: 2, title: 'A & B <news>', source_url: 'https://ab.com/rss' },
  ];
  const rssUrlOf = (f) => `https://afu/rss/${f.id}`;

  it('產生合法 OPML,每個 feed 一個 outline;不輸出 category(分類交給 Miniflux)', () => {
    const xml = feedsToOpml(feeds, rssUrlOf);
    expect(xml).toContain('<opml version="2.0">');
    expect((xml.match(/<outline /g) || []).length).toBe(2);
    expect(xml).toContain('xmlUrl="https://afu/rss/1"');
    expect(xml).toContain('htmlUrl="https://ex.com/feed"');
    expect(xml).not.toContain('category=');
  });

  it('特殊字元跳脫(& < >)', () => {
    const xml = feedsToOpml(feeds, rssUrlOf);
    expect(xml).toContain('A &amp; B &lt;news&gt;');
    expect(xml).not.toContain('A & B <news>');
  });
});

describe('parseOpml', () => {
  it('解析標準 OPML → 來源清單', () => {
    const opml = `<?xml version="1.0"?>
      <opml version="2.0"><body>
        <outline text="Tech" title="Tech Blog" type="rss" xmlUrl="https://ex.com/feed" htmlUrl="https://ex.com"/>
        <outline text="News" xmlUrl="https://news.com/rss"/>
      </body></opml>`;
    const rows = parseOpml(opml);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ source_url: 'https://ex.com/feed', title: 'Tech Blog' });
    expect(rows[0].html_url).toBe('https://ex.com'); // htmlUrl 另外保留(匯入端自我參照還原用)
    expect(rows[1].source_url).toBe('https://news.com/rss');
    expect(rows[1].html_url).toBe(null); // 沒有 htmlUrl
  });

  it('只有 htmlUrl(當作 source_url)→ html_url 不重複附', () => {
    const rows = parseOpml('<opml><body><outline text="h" htmlUrl="https://only-html.com/"/></body></opml>');
    expect(rows[0].source_url).toBe('https://only-html.com/');
    expect(rows[0].html_url).toBe(null); // 與 source_url 同值就不重複
  });

  it('資料夾型 outline(無 xmlUrl)被跳過,子項仍取得', () => {
    const opml = `<opml><body>
      <outline text="資料夾">
        <outline text="子feed" xmlUrl="https://child.com/feed"/>
      </outline>
    </body></opml>`;
    const rows = parseOpml(opml);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_url).toBe('https://child.com/feed');
  });

  it('單引號屬性也解析(部分閱讀器匯出格式)', () => {
    const opml = `<opml><body><outline text='單引號' xmlUrl='https://sq.com/feed'/></body></opml>`;
    const rows = parseOpml(opml);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_url: 'https://sq.com/feed', title: '單引號' });
  });

  it('round-trip:匯出再匯入得回來源網址', () => {
    const feeds = [{ id: 1, title: 'X', source_url: 'https://x.com/feed' }];
    // 匯出時 xmlUrl 是譯後網址;但若把來源當 xmlUrl 匯出則 round-trip 回來源。
    // 這裡驗「以來源為 xmlUrl」的往返(模擬從別的閱讀器匯出的 OPML)。
    const xml = feedsToOpml(feeds, (f) => f.source_url);
    const rows = parseOpml(xml);
    expect(rows[0].source_url).toBe('https://x.com/feed');
    expect(rows[0].title).toBe('X');
  });
});
