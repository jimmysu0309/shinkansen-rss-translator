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

// ── translate="no" / notranslate(跟進 Shinkansen v2.4.13)──
// 訊號層次:
//   ✓ 區塊整顆跳過、inline 走 ⟦*N⟧ 原子保留並原樣回填、class="notranslate" 同義
//   ✓ translate="yes" 在 no 祖先內重開;文件級 wrapper(佔整體一半以上文字)不採信
//   ✓ textnode 模式同語意
//   ✗ 不驗 icon 字型 ligature(需 computed style,伺服器端不移植)
describe('translate="no" / notranslate', () => {
  it('區塊級 translate="no" 整顆跳過,其他段照常', () => {
    const html = '<p>Hello</p><p translate="no">Jane Doe</p><p>World</p>';
    const { texts, reassemble } = segmentHtml(html);
    expect(texts).toEqual(['Hello', 'World']);
    expect(reassemble(identity(texts))).toBe(html);
  });

  it('class="notranslate" 與 translate="no" 同義(含大小寫 / 空白)', () => {
    const { texts } = segmentHtml('<p>a1</p><div class="x notranslate">b2</div><p translate=" NO ">c3</p>');
    expect(texts).toEqual(['a1']);
  });

  it('段內 inline 的 translate="no" → 原子佔位符,不送翻、回填原樣', () => {
    const html = '<p>Meet <span translate="no">Jane Doe</span> today.</p>';
    const { texts, reassemble } = segmentHtml(html);
    expect(texts).toEqual(['Meet ⟦*0⟧ today.']);
    expect(reassemble(['今天見 ⟦*0⟧。'])).toBe('<p>今天見 <span translate="no">Jane Doe</span>。</p>');
  });

  it('段落只剩不翻譯的 inline(去掉佔位符後無文字)→ 不成段', () => {
    const { texts } = segmentHtml('<p><span class="notranslate">Jane Doe</span></p><p><code>x = 1</code></p><p>ok</p>');
    expect(texts).toEqual(['ok']);
  });

  it('translate="yes" 在 translate="no" 祖先內重新開放翻譯', () => {
    // 尾段夠長,讓 no 容器不到整體一半(否則會被當文件級 wrapper 豁免,見下一條)
    const html = '<div translate="no"><p>raw</p><p translate="yes">Hello</p><p>raw2</p></div><p>World, and a long trailing paragraph.</p>';
    const { texts, reassemble } = segmentHtml(html);
    expect(texts).toEqual(['Hello', 'World, and a long trailing paragraph.']);
    expect(reassemble(['哈囉', '世界'])).toBe('<div translate="no"><p>raw</p><p translate="yes">哈囉</p><p>raw2</p></div><p>世界</p>');
  });

  it('文件級 wrapper(整篇被 notranslate 包住)不採信,內容照翻', () => {
    const { texts } = segmentHtml('<div class="notranslate"><p>Hello</p><p>World</p></div>');
    expect(texts).toEqual(['Hello', 'World']);
  });

  it('小型 notranslate 容器(不到整體一半)照常跳過', () => {
    const { texts } = segmentHtml('<div class="notranslate"><p>Jane</p></div><p>A long paragraph with plenty of words.</p>');
    expect(texts).toEqual(['A long paragraph with plenty of words.']);
  });

  it('textnode 模式:translate="no" 子樹不收,translate="yes" 重開', () => {
    const html = '<p>Hi <span translate="no">Jane <b translate="yes">Doe</b></span> there</p><p>Tail paragraph text</p>';
    const { texts, reassemble } = segmentHtml(html, { mode: 'textnode' });
    expect(texts).toEqual(['Hi', 'Doe', 'there', 'Tail paragraph text']);
    expect(reassemble(['嗨', '多伊', '那邊', '尾段'])).toBe('<p>嗨 <span translate="no">Jane <b translate="yes">多伊</b></span> 那邊</p><p>尾段</p>');
  });
});
