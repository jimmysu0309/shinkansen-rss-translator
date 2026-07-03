// html-segmenter 測試(離線)——防漏譯的核心不變量。
//
// 訊號層次:
//   ✓ 段數不變量:texts 段數 = 可翻文字節點數;reassemble 段數不符會丟錯
//   ✓ 結構保留:圖片 / 連結 / 標籤在回填後原樣存在
//   ✓ 純空白 / 純標點節點不進 texts、原樣保留
//   ✓ 前後空白保留(排版間距不破)
//   ✓ 跳過 script/style/pre/code 內文字
//   ✗ 不驗:真實翻譯品質(那在 translate-entry 整合測試)
import { describe, it, expect } from 'vitest';
import { segmentHtml } from '../src/pipeline/html-segmenter.js';

// 假翻譯:每段前面加「譯:」,方便驗證回填位置正確
const fakeTranslate = (texts) => texts.map((t) => `譯:${t}`);

describe('segmentHtml 段數不變量', () => {
  it('多段落 → 各自成段', () => {
    const { texts } = segmentHtml('<p>First paragraph.</p><p>Second paragraph.</p>');
    expect(texts).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  it('reassemble 段數不符 → 丟錯(不變量被破壞)', () => {
    const { reassemble } = segmentHtml('<p>a</p><p>b</p>');
    expect(() => reassemble(['只有一段'])).toThrow(/段數不符/);
  });

  it('回填後段數與位置正確', () => {
    const { texts, reassemble } = segmentHtml('<p>Hello</p><p>World</p>');
    const html = reassemble(fakeTranslate(texts));
    expect(html).toBe('<p>譯:Hello</p><p>譯:World</p>');
  });
});

describe('結構保留(圖片 / 連結 / 標籤)', () => {
  it('圖片在回填後原樣存在', () => {
    const src = '<p>Look at this photo:</p><figure><img src="https://x.com/a.jpg" alt="cat"></figure>';
    const { texts, reassemble } = segmentHtml(src);
    const html = reassemble(fakeTranslate(texts));
    expect(html).toContain('<img src="https://x.com/a.jpg" alt="cat">');
    expect(html).toContain('譯:Look at this photo:');
  });

  it('段落內的連結與粗體:文字被切段但元素與屬性保留', () => {
    const src = '<p>Visit <a href="https://ex.com">our <b>site</b></a> today.</p>';
    const { texts, reassemble } = segmentHtml(src);
    // 文字節點:'Visit '、'our '、'site'、' today.' → 4 段(空白邊界被 trim 進 core 外)
    expect(texts).toEqual(['Visit', 'our', 'site', 'today.']);
    const html = reassemble(fakeTranslate(texts));
    expect(html).toContain('href="https://ex.com"');
    expect(html).toContain('<b>譯:site</b>');
  });

  it('前後空白保留,排版間距不破', () => {
    const { texts, reassemble } = segmentHtml('<p>Hello <em>world</em>!</p>');
    // 'Hello'(後接空白)、'world'、'!' → '!' 無字母數字?'!' 不含 \p{L}\p{N} → 不翻
    expect(texts).toEqual(['Hello', 'world']);
    const html = reassemble(texts.map((t) => `[${t}]`));
    // 'Hello ' 的尾空白要保留 → '[Hello] '
    expect(html).toBe('<p>[Hello] <em>[world]</em>!</p>');
  });
});

describe('不翻的節點', () => {
  it('純標點 / 純符號節點不進 texts,原樣保留', () => {
    const { texts, reassemble } = segmentHtml('<p>A</p><p> · </p><p>B</p>');
    expect(texts).toEqual(['A', 'B']);
    const html = reassemble(fakeTranslate(texts));
    expect(html).toContain('<p> · </p>'); // 中間分隔符原樣
  });

  it('script / style / code / pre 內文字不翻', () => {
    const src = '<p>Real text.</p><script>var x = "not translated";</script><pre>code block</pre>';
    const { texts } = segmentHtml(src);
    expect(texts).toEqual(['Real text.']);
  });

  it('空 HTML → 空段', () => {
    expect(segmentHtml('').texts).toEqual([]);
    expect(segmentHtml('   ').texts).toEqual([]);
  });

  it('譯文為空時保留原文,避免內容消失', () => {
    const { texts, reassemble } = segmentHtml('<p>keep me</p>');
    const html = reassemble([undefined]);
    expect(html).toBe('<p>keep me</p>');
  });
});
