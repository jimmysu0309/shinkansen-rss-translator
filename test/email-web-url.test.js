// email-web-url 測試(離線)。
//
// 訊號層次:
//   ✓ Substack 免費名單信(只有 subscribe?next=/p/…)解得出原文網址
//   ✓ Substack 付費名單信(有 email-half-post 直連 /p/…)解得出原文網址
//   ✓ 輸出不帶 query(個人 token 不外流)
//   ✓ 內文引用別篇的連結、非 email-* campaign、壞掉的 payload 都不誤認
//   ✗ 不驗:真實信件 HTML 的完整形狀(fixture 只保留 redirect 連結;部署後用 afu 上的真資料驗)
import { describe, it, expect } from 'vitest';
import { emailWebUrl } from '../src/pipeline/email-web-url.js';

// 依 Substack 真實格式組 redirect/2 連結:payload 是 base64url JSON,後面接 .簽章
const redirect = (e) =>
  `https://substack.com/redirect/2/${Buffer.from(JSON.stringify({ e, p: 1, s: 1 })).toString('base64url')}.SIG?j=x`;
const a = (href, text = 'x') => `<a href="${href}">${text}</a>`;

describe('emailWebUrl', () => {
  it('免費名單信(ChinaTalk 形狀):subscribe 頁的 next= 指回原文', () => {
    const html = [
      a(redirect('https://www.chinatalk.media/subscribe?utm_source=email&utm_campaign=email-subscribe&r=1r7yu&next=https%3A%2F%2Fwww.chinatalk.media%2Fp%2Friding-solo-in-santiago')),
      a('https://substack.com/app-link/post?publication_id=4220&post_id=218581807&token=SECRET'),
    ].join('');
    expect(emailWebUrl(html)).toBe('https://www.chinatalk.media/p/riding-solo-in-santiago');
  });

  it('付費名單信(Culpium 形狀):email-half-post 直連 /p/,query 裡的 token 被丟掉', () => {
    const html = a(redirect('https://www.culpium.com/p/tsmc-breaks-silence-on-terafab-hints?utm_campaign=email-half-post&r=1r7yu&token=SECRET'));
    const url = emailWebUrl(html);
    expect(url).toBe('https://www.culpium.com/p/tsmc-breaks-silence-on-terafab-hints');
    expect(url).not.toContain('SECRET');
  });

  it('跳過不指向文章的 email-* 連結(首頁、退訂),往下找到文章那條', () => {
    const html = [
      a(redirect('https://www.chinatalk.media?utm_campaign=email-home&r=1r7yu')),
      a(redirect('https://www.chinatalk.media/action/disable_email?token=SECRET&utm_campaign=email-unsub')),
      a(redirect('https://www.chinatalk.media/subscribe?utm_campaign=email-checkout&next=https%3A%2F%2Fwww.chinatalk.media%2Fp%2Fwhere-is-chinas-groq')),
    ].join('');
    expect(emailWebUrl(html)).toBe('https://www.chinatalk.media/p/where-is-chinas-groq');
  });

  it('內文引用別篇文章(非 email-* campaign)不會被當成原文', () => {
    const html = a(redirect('https://www.chinatalk.media/p/some-older-post?utm_source=post'));
    expect(emailWebUrl(html)).toBeNull();
  });

  it('認不得的信(Mailchimp 追蹤連結)、壞掉的 payload、空值 → null', () => {
    expect(emailWebUrl(a('https://us.list-manage.com/Jz5JRb7ccgy?e=81684b73f1'))).toBeNull();
    expect(emailWebUrl(a('https://substack.com/redirect/2/@@not-base64@@.SIG'))).toBeNull();
    expect(emailWebUrl(a('https://substack.com/redirect/2/bm90LWpzb24.SIG'))).toBeNull(); // "not-json"
    expect(emailWebUrl('')).toBeNull();
    expect(emailWebUrl(null)).toBeNull();
  });
});
