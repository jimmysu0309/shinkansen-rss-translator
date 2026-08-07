// rss-output 測試(離線)。
//
// 訊號層次:
//   ✓ Atom 結構、篇數、譯文標題/內文出現在輸出
//   ✓ pending 篇退回原文(不遺漏)
//   ✗ 不驗:Miniflux 端實際解析(部署驗)
import { describe, it, expect } from 'vitest';
import { buildFeedXml, withHero } from '../src/pipeline/rss-output.js';

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

  it('有 author 的篇輸出 <author><name>,沒有的不輸出', () => {
    const entries = [
      { guid: 'a', translation_status: 'done', author: 'Emma Roth', title_translated: 'A譯', content_translated: '<p>a</p>', published_at: 2 },
      { guid: 'b', translation_status: 'done', author: null, title_translated: 'B譯', content_translated: '<p>b</p>', published_at: 1 },
    ];
    const xml = buildFeedXml({ feed, entries, selfUrl: 'https://afu/rss/1' });
    expect(xml).toContain('<name>Emma Roth</name>');
    expect((xml.match(/<author>/g) || []).length).toBe(1);
  });

  it('opencc feed 作者名轉繁;其他引擎保留原名', () => {
    const entries = [
      { guid: 'a', translation_status: 'done', author: '少数派编辑部', title_translated: 'A譯', content_translated: '<p>a</p>', published_at: 2 },
    ];
    const xmlOcc = buildFeedXml({ feed: { ...feed, engine: 'opencc' }, entries, selfUrl: 'https://afu/rss/1' });
    expect(xmlOcc).toContain('<name>少數派編輯部</name>');
    const xmlGem = buildFeedXml({ feed: { ...feed, engine: 'gemini' }, entries, selfUrl: 'https://afu/rss/1' });
    expect(xmlGem).toContain('<name>少数派编辑部</name>');
  });

  it('空 entries → 合法空 Atom', () => {
    const xml = buildFeedXml({ feed, entries: [], selfUrl: 'https://afu/rss/1' });
    expect(xml).toContain('<feed');
    expect((xml.match(/<entry>/g) || []).length).toBe(0);
  });

  it('image_url → 譯文前面前置 hero;沒有 image_url 的篇不動', () => {
    const entries = [
      { guid: 'h1', translation_status: 'done', title_translated: 'A', content_translated: '<p>譯文</p>',
        image_url: 'https://cdn/cover.jpg', published_at: 3 },
      { guid: 'h2', translation_status: 'done', title_translated: 'B', content_translated: '<p>沒封面</p>', published_at: 2 },
    ];
    const xml = buildFeedXml({ feed, entries, selfUrl: 'https://afu/rss/1' });
    // feed 套件把內文包 CDATA,所以 HTML 是原樣不轉義的
    expect(xml).toContain('<figure><img src="https://cdn/cover.jpg" alt="" /></figure><p>譯文</p>');
    expect((xml.match(/figure/g) || []).length).toBe(2); // 只有第一篇有(開頭+結尾標籤)
  });
});

describe('withHero', () => {
  it('內文已有同一張圖(忽略 query)就不重複前置', () => {
    const html = '<p>x</p><img src="https://cdn/cover.jpg?w=800">';
    expect(withHero(html, 'https://cdn/cover.jpg?w=1600')).toBe(html);
  });

  it('開頭 600 字元內已經有圖(圖輯類)就不前置', () => {
    const html = '<figure><img src="https://cdn/a.jpg"></figure><p>圖輯</p>';
    expect(withHero(html, 'https://cdn/cover.jpg')).toBe(html);
  });

  it('開頭沒圖就前置;網址的 & 會轉義', () => {
    expect(withHero('<p>x</p>', 'https://cdn/c.jpg?a=1&b=2'))
      .toBe('<figure><img src="https://cdn/c.jpg?a=1&amp;b=2" alt="" /></figure><p>x</p>');
  });

  it('沒有 image_url / 空內文都不炸', () => {
    expect(withHero('<p>x</p>', null)).toBe('<p>x</p>');
    expect(withHero('', 'https://cdn/c.jpg')).toBe('<figure><img src="https://cdn/c.jpg" alt="" /></figure>');
  });

  it('內文很後面才出現同一張圖 → 仍視為重複,不前置', () => {
    const html = `<p>${'字'.repeat(700)}</p><img src="https://cdn/cover.jpg">`;
    expect(withHero(html, 'https://cdn/cover.jpg')).toBe(html);
  });
});
