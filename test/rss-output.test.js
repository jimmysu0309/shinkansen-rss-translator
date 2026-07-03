// rss-output 測試(離線)。
//
// 訊號層次:
//   ✓ Atom 結構、篇數、譯文標題/內文出現在輸出
//   ✓ pending 篇退回原文(不遺漏)
//   ✗ 不驗:Miniflux 端實際解析(部署驗)
import { describe, it, expect } from 'vitest';
import { buildFeedXml } from '../src/pipeline/rss-output.js';

const feed = { title: 'Tech Blog', source_url: 'https://ex.com/feed' };

describe('buildFeedXml', () => {
  it('done 篇用譯文標題與內文', () => {
    const entries = [{
      guid: 'g1', url: 'https://ex.com/1', translation_status: 'done',
      title: 'Original Title', title_translated: '翻譯後標題',
      content_html: '<p>Original</p>', content_translated: '<p>譯文內容</p>',
      published_at: Date.parse('2025-07-02T10:00:00Z'),
    }];
    const xml = buildFeedXml({ feed, entries, selfUrl: 'https://afu/rss/1' });
    expect(xml).toContain('<feed');           // Atom
    expect(xml).toContain('翻譯後標題');
    expect(xml).toContain('譯文內容');
    expect(xml).not.toContain('Original Title');
    expect(xml).toContain('繁中翻譯');          // feed 標題後綴
  });

  it('pending 篇退回原文,不遺漏文章', () => {
    const entries = [{
      guid: 'g2', url: 'https://ex.com/2', translation_status: 'pending',
      title: 'Not Yet', content_html: '<p>English body</p>',
      published_at: Date.parse('2025-07-01T10:00:00Z'),
    }];
    const xml = buildFeedXml({ feed, entries, selfUrl: 'https://afu/rss/1' });
    expect(xml).toContain('Not Yet');
    expect(xml).toContain('English body');
  });

  it('多篇:篇數正確', () => {
    const entries = [
      { guid: 'a', translation_status: 'done', title_translated: 'A譯', content_translated: '<p>a</p>', published_at: 2 },
      { guid: 'b', translation_status: 'done', title_translated: 'B譯', content_translated: '<p>b</p>', published_at: 1 },
    ];
    const xml = buildFeedXml({ feed, entries, selfUrl: 'https://afu/rss/1' });
    const count = (xml.match(/<entry>/g) || []).length;
    expect(count).toBe(2);
  });

  it('空 entries → 合法空 Atom', () => {
    const xml = buildFeedXml({ feed, entries: [], selfUrl: 'https://afu/rss/1' });
    expect(xml).toContain('<feed');
    expect((xml.match(/<entry>/g) || []).length).toBe(0);
  });
});
