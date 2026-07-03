// html-segmenter 測試(離線)—— block + 佔位符切段。
//
// 訊號層次:
//   ✓ 葉子區塊為單位;inline → 配對佔位符 ⟦N⟧…⟦/N⟧、原子(img)→ ⟦*N⟧
//   ✓ 回填還原 tag + 屬性(連結 href / 巢狀 inline);段數不變量
//   ✓ 防禦式回填:LLM 弄壞標記不崩、空譯文保留原文
//   ✓ 跳過 script/style/pre;圖片保留
import { describe, it, expect } from 'vitest';
import { segmentHtml } from '../src/pipeline/html-segmenter.js';

// 假翻譯:原樣回傳(保留佔位符)→ 驗證回填能重建原結構
const identity = (texts) => texts.slice();

describe('block 切段:每個葉子區塊一段', () => {
  it('多段落 → 各自成段(無 inline 則無佔位符)', () => {
    const { texts } = segmentHtml('<p>First paragraph.</p><p>Second paragraph.</p>');
    expect(texts).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  it('reassemble 段數不符 → 丟錯', () => {
    const { reassemble } = segmentHtml('<p>a</p><p>b</p>');
    expect(() => reassemble(['只有一段'])).toThrow(/段數不符/);
  });

  it('整段翻譯回填(identity 還原原文)', () => {
    const { texts, reassemble } = segmentHtml('<p>Hello</p><p>World</p>');
    expect(reassemble(identity(texts))).toBe('<p>Hello</p><p>World</p>');
  });
});

describe('inline 佔位符', () => {
  it('連結 + 巢狀粗體 → 單段含配對佔位符', () => {
    const { texts, reassemble } = segmentHtml('<p>Visit <a href="https://ex.com">our <b>site</b></a> today.</p>');
    expect(texts).toEqual(['Visit ⟦0⟧our ⟦1⟧site⟦/1⟧⟦/0⟧ today.']); // 整句一段,語序完整
    // identity 回填 → 還原 tag + href + 巢狀 <b>
    expect(reassemble(identity(texts))).toBe('<p>Visit <a href="https://ex.com">our <b>site</b></a> today.</p>');
  });

  it('翻譯後語序改變 + 佔位符保留 → 連結位置跟著換', () => {
    const { texts, reassemble } = segmentHtml('<p>Visit <a href="https://ex.com">site</a> now.</p>');
    expect(texts).toEqual(['Visit ⟦0⟧site⟦/0⟧ now.']);
    // 模擬中文語序:把連結移到後面
    const html = reassemble(['現在造訪⟦0⟧網站⟦/0⟧。']);
    expect(html).toBe('<p>現在造訪<a href="https://ex.com">網站</a>。</p>');
  });

  it('段內圖片 → 原子佔位符,回填保留 <img> 與屬性', () => {
    const { texts, reassemble } = segmentHtml('<p>See <img src="https://x.com/p.jpg" alt="pic"> here.</p>');
    expect(texts).toEqual(['See ⟦*0⟧ here.']);
    const html = reassemble(['看這裡 ⟦*0⟧。']);
    expect(html).toContain('<img src="https://x.com/p.jpg" alt="pic">');
    expect(html).toContain('看這裡');
  });
});

describe('結構保留 / 跳過', () => {
  it('figure 內純圖片(無文字)不成段,原樣保留', () => {
    const { texts, reassemble } = segmentHtml('<p>Look:</p><figure><img src="https://x.com/a.jpg"></figure>');
    expect(texts).toEqual(['Look:']); // 只有 <p> 是翻譯單位
    const html = reassemble(['看:']);
    expect(html).toContain('<img src="https://x.com/a.jpg">');
    expect(html).toContain('<p>看:</p>');
  });

  it('script / style / pre / code 內文字不翻', () => {
    const { texts } = segmentHtml('<p>Real.</p><script>var x=1</script><pre>code</pre>');
    expect(texts).toEqual(['Real.']);
  });

  it('巢狀容器 → 遞迴取葉子區塊', () => {
    const { texts } = segmentHtml('<div><section><p>A</p><p>B</p></section></div>');
    expect(texts).toEqual(['A', 'B']);
  });

  it('list 每個 li 一段', () => {
    const { texts } = segmentHtml('<ul><li>one</li><li>two</li></ul>');
    expect(texts).toEqual(['one', 'two']);
  });

  it('空 / 純空白 → 無段', () => {
    expect(segmentHtml('').texts).toEqual([]);
    expect(segmentHtml('   ').texts).toEqual([]);
    expect(segmentHtml('<p>  </p>').texts).toEqual([]);
  });
});

describe('textnode 模式(給 Google 翻譯,無佔位符)', () => {
  it('逐文字節點切段,不含任何 ⟦⟧ 標記', () => {
    const { texts, reassemble } = segmentHtml('<p>Visit <a href="https://ex.com">site</a> now.</p>', { mode: 'textnode' });
    expect(texts).toEqual(['Visit', 'site', 'now.']); // 文字節點各自成段
    expect(texts.join('')).not.toContain('⟦');         // 純文字,無標記
    const html = reassemble(['造訪', '網站', '現在。']);
    expect(html).toContain('href="https://ex.com"');    // 結構仍保留
    expect(html).toContain('網站');
  });

  it('圖片保留(不動元素)', () => {
    const { texts, reassemble } = segmentHtml('<p>See <img src="x.jpg"> here</p>', { mode: 'textnode' });
    const html = reassemble(texts.map((t) => '譯' + t));
    expect(html).toContain('<img src="x.jpg">');
  });
});

describe('防禦式回填', () => {
  it('空譯文 → 保留原文', () => {
    const { reassemble } = segmentHtml('<p>keep me</p>');
    expect(reassemble([undefined])).toBe('<p>keep me</p>');
  });

  it('LLM 漏掉關標記 → 不崩,段末補關', () => {
    const { texts, reassemble } = segmentHtml('<p>a <b>bold</b> c</p>');
    // texts = ['a ⟦0⟧bold⟦/0⟧ c'];漏掉 ⟦/0⟧
    const html = reassemble(['a ⟦0⟧粗體 c']);
    expect(html).toContain('<b>粗體 c</b>'); // <b> 在段末被補關,不 throw
    expect(() => reassemble(['a ⟦0⟧粗體 c'])).not.toThrow();
  });

  it('壞掉的原子索引 → 略過不崩', () => {
    const { reassemble } = segmentHtml('<p>x <img src="i.jpg"> y</p>');
    expect(() => reassemble(['x ⟦*9⟧ y'])).not.toThrow(); // 索引 9 不存在 → 略過
  });
});
