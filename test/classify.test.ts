import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmail, parseFrom } from '../src/classify.js';
import { chunkDomains, domainMatches, looksLikeAi, searchDomains, vendorForAppName, vendorForBillingText } from '../src/catalogue.js';
import { parseCsv, toCsv } from '../src/util.js';

test('parseFrom handles display names and bare addresses', () => {
  assert.deepEqual(parseFrom('"OpenAI" <noreply@tm.openai.com>'), { name: 'OpenAI', address: 'noreply@tm.openai.com', domain: 'tm.openai.com' });
  assert.equal(parseFrom('hello@lovable.dev')?.domain, 'lovable.dev');
  assert.equal(parseFrom('not an address'), null);
});

test('domain matching is suffix-safe', () => {
  assert.ok(domainMatches('tm.openai.com', 'openai.com'));
  assert.ok(domainMatches('openai.com', 'openai.com'));
  assert.ok(!domainMatches('notopenai.com', 'openai.com'));
  assert.ok(!domainMatches('openai.com.evil.io', 'openai.com'));
});

test('vendor sign-up, login and receipt mail is classified', () => {
  const s = classifyEmail('Anthropic <no-reply@mail.anthropic.com>', 'Verify your email for Claude');
  assert.equal(s?.vendor.id, 'claude');
  assert.equal(s?.kind, 'email_signup');
  assert.equal(classifyEmail('OpenAI <noreply@tm.openai.com>', 'Your ChatGPT log-in code')?.kind, 'email_login');
  const r = classifyEmail('Cursor <hi@cursor.com>', 'Your receipt from Anysphere');
  assert.equal(r?.kind, 'email_receipt');
  assert.equal(r?.paid, true);
});

test('marketing mail is low confidence and never paid', () => {
  const m = classifyEmail('OpenAI <noreply@email.openai.com>', 'Introducing new features for Plus users');
  assert.equal(m?.kind, 'email_other');
  assert.equal(m?.confidence, 'low');
  assert.equal(m?.paid, false);
});

test('payment-processor receipts are attributed to the vendor', () => {
  const r = classifyEmail('Anthropic, PBC <invoice+statements@stripe.com>', 'Your receipt from Anthropic, PBC #1234');
  assert.equal(r?.vendor.id, 'claude');
  assert.equal(r?.paid, true);
  assert.equal(classifyEmail('Acme Widgets <invoice@stripe.com>', 'Your receipt from Acme Widgets'), null);
});

test('unrelated senders are ignored', () => {
  assert.equal(classifyEmail('Bank <alerts@bank.co.uk>', 'Welcome'), null);
});

test('OAuth app names map to vendors with whole-word matching', () => {
  assert.equal(vendorForAppName('ChatGPT')?.id, 'chatgpt');
  assert.equal(vendorForAppName('Claude for Work')?.id, 'claude');
  assert.equal(vendorForAppName('Claudette Recipes'), undefined);
  assert.equal(vendorForAppName('Otter.ai')?.id, 'otter');
  assert.ok(looksLikeAi('SalesGPT Pro'));
  assert.ok(looksLikeAi('Acme AI Notetaker'));
  assert.ok(!looksLikeAi('Zoom'));
  assert.ok(!looksLikeAi('Mailchimp'));
});

test('card statement descriptions map to vendors', () => {
  assert.equal(vendorForBillingText('OPENAI *CHATGPT SUBSCR')?.id, 'chatgpt');
  assert.equal(vendorForBillingText('ANTHROPIC CLAUDE.AI SUBSCRIPTION')?.id, 'claude');
  assert.equal(vendorForBillingText('TESCO STORES 2231'), undefined);
});

test('search domain chunks stay within the length budget and cover every domain', () => {
  const all = searchDomains();
  const chunks = chunkDomains(all, 450);
  assert.deepEqual(chunks.flat().sort(), [...all].sort());
  for (const c of chunks) assert.ok(c.map((d) => `from:${d}`).join(' OR ').length <= 500);
});

test('CSV round trip and formula neutralising', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\n'), [
    ['a', 'b'],
    ['x, y', 'he said "hi"'],
  ]);
  assert.equal(toCsv([['=SUM(A1)', 'ok']]), "'=SUM(A1),ok");
});
